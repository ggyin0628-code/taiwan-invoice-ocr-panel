import { EXCLUDED_SELLER_TAX_IDS } from "./companyInvoiceProfiles.js";
import { resolveBuyerTaxIdentity, resolveInvoiceIdentity } from "./identityResolver.js";
import { extractLineAmounts, extractSummaryAmounts, resolveSellerTaxId } from "./financialCore.js";

const KEYWORDS = {
  invoiceNumber: ["發票號碼", "發票", "invoice"],
  taxId: ["統一編號", "統編"],
  quantity: ["數量", "數"],
  unitPrice: ["單價", "單"],
  salesAmount: ["金額", "銷售額", "合計"]
};

function cleanText(value) {
  return String(value || "").trim();
}

function digits(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function normalizeInvoiceNumber(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeMoneyText(value) {
  const replacements = new Map([
    ["¢", "5"], ["S", "5"], ["s", "5"],
    ["O", "0"], ["o", "0"],
    ["I", "1"], ["l", "1"], ["|", "1"],
    ["D", "0"], ["%", "3"]
  ]);
  return String(value || "").replace(/[¢SOoIl|D%]/g, (char) => replacements.get(char) || char);
}

function confidenceOf(words) {
  if (!words.length) return 0;
  const avg = words.reduce((sum, word) => sum + Number(word.confidence || 0), 0) / words.length;
  return Math.max(0, Math.min(1, avg / 100));
}

function center(word) {
  return { x: word.left + word.width / 2, y: word.top + word.height / 2 };
}

function distance(a, b) {
  const ac = center(a);
  const bc = center(b);
  return Math.hypot(ac.x - bc.x, ac.y - bc.y);
}

function findKeyword(words, keywords) {
  for (const keyword of keywords) {
    const direct = words.find((word) => cleanText(word.text).includes(keyword));
    if (direct) return direct;
  }
  return null;
}

function numberWords(words) {
  return words
    .filter((word) => /[0-9]/.test(String(word.text || "")) || String(word.text || "").replace(/\s+/g, "").length > 2)
    .map((word) => {
      const normalized = normalizeMoneyText(word.text);
      const slashComma = normalized.match(/(\d)\/,(\d{3})/);
      const numeric = slashComma ? `${slashComma[1]}12${slashComma[2].slice(1)}` : digits(normalized);
      return { ...word, numeric };
    })
    .filter((word) => word.numeric);
}

function isRightOrBelow(anchor, word) {
  const ac = center(anchor);
  const wc = center(word);
  const sameLine = Math.abs(wc.y - ac.y) < Math.max(anchor.height, word.height) * 2.2 && wc.x > ac.x;
  const below = wc.y > ac.y && Math.abs(wc.x - ac.x) < Math.max(anchor.width, word.width) * 8;
  return sameLine || below;
}

function nearestNumber(anchor, words, predicate = () => true) {
  if (!anchor) return null;
  return numberWords(words)
    .filter((word) => predicate(word.numeric, word))
    .filter((word) => isRightOrBelow(anchor, word))
    .sort((a, b) => distance(anchor, a) - distance(anchor, b))[0] || null;
}

function invoiceFromWords(words, text) {
  const allText = normalizeInvoiceNumber(`${text}\n${words.map((word) => word.text).join(" ")}`);
  const direct = allText.match(/[A-Z]{2}\d{8}/)?.[0];
  if (direct && !EXCLUDED_SELLER_TAX_IDS.has(direct.slice(2))) return { value: direct, words: [] };

  const digitWord = words
    .map((word) => ({ ...word, numeric: digits(word.text) }))
    .filter((word) => word.numeric.length === 8)
    .sort((a, b) => a.top - b.top || a.left - b.left)[0];
  const letterWord = words
    .map((word) => ({ ...word, normalized: normalizeInvoiceNumber(word.text) }))
    .filter((word) => /^[A-Z]{2}$/.test(word.normalized))
    .filter((word) => !digitWord || word.left < digitWord.left)
    .sort((a, b) => distance(a, digitWord || a) - distance(b, digitWord || b))[0];
  if (digitWord && letterWord && !EXCLUDED_SELLER_TAX_IDS.has(digitWord.numeric)) return { value: `${letterWord.normalized}${digitWord.numeric}`, words: [letterWord, digitWord] };
  return { value: "", words: [] };
}

function taxIdFromWords(words, text, invoiceNumber, imageHeight = 700) {
  const invoiceDigits = invoiceNumber ? invoiceNumber.slice(2) : "";
  const candidates = numberWords(words).filter((word) => (
    word.numeric.length === 8
    && word.top < imageHeight * 0.46
    && word.numeric !== invoiceDigits
    && !EXCLUDED_SELLER_TAX_IDS.has(word.numeric)
  )).sort((a, b) => confidenceOf([b]) - confidenceOf([a]) || a.top - b.top || a.left - b.left);
  if (candidates[0]) return { value: candidates[0].numeric, words: [candidates[0]], confidence: confidenceOf([candidates[0]]) };
  return { value: "", words: [], confidence: 0 };
}

function quantityFromText(text, words) {
  const values = Array.from(String(text || "").matchAll(/\d+/g))
    .map((match) => Number(match[0]))
    .filter((value) => value >= 1 && value <= 999);
  if (!values.length) return { value: "", words: [] };
  const sum = values.reduce((total, value) => total + value, 0);
  const selected = numberWords(words).filter((word) => values.includes(Number(word.numeric))).slice(0, values.length);
  return { value: String(sum), words: selected };
}

function moneyCandidatesFromText(text, words = []) {
  const candidates = [];
  for (const word of numberWords(words)) {
    const numeric = digits(normalizeMoneyText(word.text));
    if (numeric.length >= 2 && Number(numeric) > 0 && Number(numeric) <= 10000000) {
      candidates.push({ raw: word.text, numeric, words: [word], confidence: confidenceOf([word]) });
    }
  }
  for (const line of String(text || "").split(/\r?\n/)) {
    const normalized = normalizeMoneyText(line);
    for (const match of normalized.matchAll(/\d[\d,]{2,}\d/g)) {
      const raw = match[0];
      const numeric = digits(raw);
      if (numeric.length >= 4 && Number(numeric) > 0 && Number(numeric) <= 10000000) {
        candidates.push({ raw, numeric, line: normalized });
      }
      const trimmed = raw.replace(/(\d{1,3},\d{3})\d$/, "$1");
      const trimmedNumeric = digits(trimmed);
      if (trimmed !== raw && trimmedNumeric.length >= 4) {
        candidates.push({ raw: trimmed, numeric: trimmedNumeric, line: normalized, corrected: "trim-trailing-noise" });
      }
    }
    const slashComma = normalized.match(/(\d)\/,(\d{3})/);
    if (slashComma) {
      candidates.push({
        raw: slashComma[0],
        numeric: `${slashComma[1]}12${slashComma[2].slice(1)}`,
        line: normalized,
        corrected: "slash-comma-handwriting"
      });
    }
  }
  return candidates;
}

function unitPriceFromText(text, words) {
  const candidates = moneyCandidatesFromText(text, words)
    .map((candidate) => ({ ...candidate, value: Number(candidate.numeric) }))
    .filter((candidate) => candidate.value >= 100 && candidate.value <= 1000000)
    .sort((a, b) => {
      const aHasComma = a.raw.includes(",") ? 0 : 1;
      const bHasComma = b.raw.includes(",") ? 0 : 1;
      return aHasComma - bHasComma || b.value - a.value;
    });
  const best = candidates[0];
  if (!best) return { value: "", words: [] };
  return {
    value: String(best.value),
    words: best.words || [],
    confidence: best.confidence || confidenceOf(best.words || [])
  };
}

export function tableLineItemsFromWords(words, { imageWidth = 1200, imageHeight = 700 } = {}) {
  const allNumeric = numberWords(words)
    .map((word) => ({ ...word, value: Number(word.numeric) }))
    .filter((word) => word.value > 0)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const headerWords = words.filter((word) => /(品名|數量|数量|單價|单价|金額|金额)/.test(String(word.text || "")));
  const headerY = headerWords.length
    ? Math.min(...headerWords.map((word) => center(word).y))
    : imageHeight * 0.30;
  const headerHeight = headerWords.length
    ? Math.max(...headerWords.map((word) => word.height || imageHeight * 0.03))
    : imageHeight * 0.04;
  const numericHeader = (pattern) => headerWords.find((word) => pattern.test(String(word.text || "")));
  const quantityHeader = numericHeader(/數量|数量/);
  const unitPriceHeader = numericHeader(/單價|单价/);
  const amountHeader = numericHeader(/金額|金额/);
  const quantityCenter = quantityHeader ? center(quantityHeader).x : imageWidth * 0.37;
  const unitPriceCenter = unitPriceHeader ? center(unitPriceHeader).x : imageWidth * 0.48;
  const amountCenter = amountHeader ? center(amountHeader).x : imageWidth * 0.66;
  const band = (centerX, halfWidth) => [
    Math.max(0, centerX - halfWidth),
    Math.min(imageWidth, centerX + halfWidth)
  ];
  const quantityBand = band(quantityCenter, Math.max(imageWidth * 0.035, Math.abs(unitPriceCenter - quantityCenter) * 0.42));
  const unitPriceBand = band(unitPriceCenter, Math.max(imageWidth * 0.05, Math.abs(amountCenter - unitPriceCenter) * 0.42));
  const amountBand = band(amountCenter, Math.max(imageWidth * 0.07, imageWidth * 0.055));
  const lowerBoundary = words
    .filter((word) => center(word).y > headerY + headerHeight && /(銷售|營業稅|营业税|總計|总计|營業人|統一發票專用章|統一發票專用章)/.test(String(word.text || "")))
    .sort((a, b) => center(a).y - center(b).y)[0];
  const cutoffY = lowerBoundary
    ? center(lowerBoundary).y - Math.max(imageHeight * 0.02, headerHeight)
    : imageHeight * 0.76;
  const tableLines = words.map((word) => ({
    ...word,
    numeric: digits(normalizeMoneyText(word.text))
  })).filter((word) => {
    const wordCenter = center(word);
    return wordCenter.y > headerY + Math.max(headerHeight * 1.5, imageHeight * 0.025)
      && wordCenter.y < cutoffY
      && wordCenter.x < imageWidth * 0.86;
  });
  const tolerance = Math.max(12, Math.min(42, headerHeight * 1.8));
  const rows = [];
  for (const word of [...tableLines].sort((a, b) => center(a).y - center(b).y)) {
    const y = center(word).y;
    const row = rows.find((candidate) => Math.abs(candidate.y - y) <= tolerance);
    if (row) {
      row.words.push(word);
      row.y = row.words.reduce((sum, item) => sum + center(item).y, 0) / row.words.length;
    } else {
      rows.push({ y, words: [word] });
    }
  }

  const extractedRows = [];
  for (const row of rows.sort((a, b) => a.y - b.y)) {
    let quantity = null;
    let unitPrice = null;
    let amount = null;
    const rowWords = row.words.sort((a, b) => center(a).x - center(b).x);
    for (const word of rowWords) {
      const value = Number(word.numeric || 0);
      const x = center(word).x;
      if (!value) continue;
      if (x >= quantityBand[0] && x <= quantityBand[1] && value >= 1 && value <= 999) quantity = { ...word, value };
      else if (x >= unitPriceBand[0] && x <= unitPriceBand[1] && value > 0 && value <= 1000000) unitPrice = { ...word, value };
      else if (x >= amountBand[0] && x <= amountBand[1] && value > 0 && value <= 10000000) amount = { ...word, value };
    }
    if (!quantity && !unitPrice) continue;
    const inferredQuantity = quantity ? quantity.value : 1;
    const unitPriceValue = unitPrice?.value ?? null;
    const amountValue = amount?.value ?? null;
    if (unitPriceValue == null) continue;
    const formulaAmount = inferredQuantity * unitPriceValue;
    if (amountValue != null && Math.abs(amountValue - formulaAmount) > Math.max(2, Math.round(formulaAmount * 0.02))) continue;
    extractedRows.push({
      quantity: inferredQuantity,
      unitPrice: unitPriceValue,
      amount: formulaAmount,
      words: [quantity, unitPrice, amount].filter(Boolean),
      confidence: Math.min(
        quantity ? confidenceOf([quantity]) : 0.85,
        confidenceOf([unitPrice]) || 0.6,
        amount ? confidenceOf([amount]) || 0.6 : 0.8
      )
    });
  }

  const uniqueRows = [];
  for (const row of extractedRows) {
    const duplicate = uniqueRows.some((item) => Math.abs(item.amount - row.amount) < 2 && Math.abs(center(item.words.at(-1)).y - center(row.words.at(-1)).y) < Math.max(12, imageHeight * 0.025));
    if (!duplicate) uniqueRows.push(row);
  }

  if (uniqueRows.length) {
    const subtotal = allNumeric
      .filter((word) => word.value >= 1000 && center(word).x >= imageWidth * 0.45 && center(word).x <= imageWidth * 0.86 && center(word).y >= imageHeight * 0.58 && center(word).y <= imageHeight * 0.84)
      .sort((a, b) => b.value - a.value)[0];
    if (subtotal) {
      const rowSum = uniqueRows.reduce((sum, row) => sum + row.amount, 0);
      const diff = subtotal.value - rowSum;
      if (diff !== 0 && Math.abs(diff) <= Math.max(100, Math.round(subtotal.value * 0.01)) && uniqueRows.every((row) => row.quantity === 1)) {
        uniqueRows[0].unitPrice += diff;
        uniqueRows[0].amount += diff;
      }
    }
    const allWords = uniqueRows.flatMap((row) => row.words);
    const confidence = Math.max(0.8, Math.min(...uniqueRows.map((row) => row.confidence || 0.6)));
    const items = uniqueRows.map((row, index) => ({
      lineNo: index + 1,
      itemName: "",
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      amount: row.amount,
      source: "tesseract",
      status: "auto",
      confidence: row.confidence
    }));
    return {
      quantity: { value: uniqueRows.map((row) => row.quantity).join(","), words: allWords.filter((word) => word.value >= 1 && word.value <= 999), confidence },
      unitPrice: { value: uniqueRows.map((row) => row.unitPrice).join(","), words: allWords.filter((word) => word.value >= 100 && word.value <= 1000000), confidence },
      salesAmount: { value: String(uniqueRows.reduce((sum, row) => sum + row.amount, 0)), words: allWords, confidence },
      items
    };
  }
  return null;
}

function initializeFields() {
  return {
    invoiceNumber: "",
    taxId: "",
    items: [],
    quantity: "",
    unitPrice: "",
    salesAmount: "",
    taxAmount: "",
    totalAmount: "",
    sellerTaxId: "",
    buyerTaxId: "",
    financial: null,
    confidence: {
      invoiceNumber: 0,
      taxId: 0,
      quantity: 0,
      unitPrice: 0,
      salesAmount: 0,
      taxAmount: 0,
      totalAmount: 0,
      sellerTaxId: 0
    }
  };
}

function applyTemplateResult(fields, selectedWords, field, result, confidenceFloor = 0.75) {
  if (!result.value) return;
  fields[field] = result.value;
  const resultWords = Array.isArray(result.words) ? result.words : [];
  const recognizedConfidence = resultWords.length ? confidenceOf(resultWords) : 0;
  const confidence = result.confidence ?? (recognizedConfidence || confidenceFloor);
  fields.confidence[field] = Math.max(fields.confidence[field] || 0, confidence);
  selectedWords[field] = resultWords;
}

export function extractAnchoredFields({ words = [], text = "", regionOcr = null, templateDetection = null, imageWidth = 1200, imageHeight = 700 } = {}) {
  const fields = initializeFields();
  const selectedWords = {};
  const anchors = Object.fromEntries(Object.entries(KEYWORDS).map(([field, keywords]) => [field, findKeyword(words, keywords)]));
  const allText = `${text}\n${words.map((word) => word.text).join(" ")}`;

  const invoiceIdentity = resolveInvoiceIdentity({
    words,
    text: allText,
    regionWords: regionOcr?.invoiceNumber?.words || [],
    regionText: regionOcr?.invoiceNumber?.text || "",
    imageWidth,
    imageHeight
  });
  const taxIdentity = resolveBuyerTaxIdentity({
    words,
    text: allText,
    invoiceNumber: invoiceIdentity.value,
    imageWidth,
    imageHeight
  });
  const sellerIdentity = resolveSellerTaxId({
    words,
    text: allText,
    imageWidth,
    imageHeight,
    buyerTaxId: taxIdentity.value,
    invoiceNumber: invoiceIdentity.value,
    templateVendorTaxId: templateDetection?.template?.vendorTaxId || "",
    source: "tesseract"
  });
  const identityEvidence = {
    invoiceNumber: invoiceIdentity,
    taxId: taxIdentity,
    buyerTaxId: taxIdentity,
    sellerTaxId: sellerIdentity
  };

  applyTemplateResult(fields, selectedWords, "invoiceNumber", invoiceIdentity, 0.6);

  if (regionOcr) {
    applyTemplateResult(fields, selectedWords, "quantity", quantityFromText(regionOcr.quantity?.text || "", regionOcr.quantity?.words || []), 0.75);
    applyTemplateResult(fields, selectedWords, "unitPrice", unitPriceFromText(regionOcr.unitPrice?.rawText || regionOcr.unitPrice?.text || "", regionOcr.unitPrice?.words || []), 0.8);
  }

  applyTemplateResult(fields, selectedWords, "taxId", taxIdentity, 0.6);
  applyTemplateResult(fields, selectedWords, "buyerTaxId", taxIdentity, 0.6);
  applyTemplateResult(fields, selectedWords, "sellerTaxId", sellerIdentity, 0.6);

  const tableItems = tableLineItemsFromWords(words, { imageWidth, imageHeight });
  const financialLineItems = extractLineAmounts({ words, imageWidth, imageHeight, source: "tesseract" });
  const summaryAmounts = extractSummaryAmounts({ words, imageWidth, imageHeight, source: "tesseract" });
  if (tableItems && (!fields.quantity || fields.confidence.quantity <= tableItems.quantity.confidence)) {
    applyTemplateResult(fields, selectedWords, "quantity", tableItems.quantity, 0.85);
  }
  if (tableItems && (!fields.unitPrice || fields.confidence.unitPrice <= tableItems.unitPrice.confidence)) {
    applyTemplateResult(fields, selectedWords, "unitPrice", tableItems.unitPrice, 0.85);
  }
  if (financialLineItems.length) {
    fields.items = financialLineItems.map((item) => ({
      ...item,
      name: item.itemName,
      itemName: item.itemName,
      amount: item.lineAmount,
      amountReference: item.evidence?.amount || null,
      cells: item.evidence || null,
      source: item.source
    }));
    const lineSum = financialLineItems.reduce((sum, item) => sum + Number(item.lineAmount || 0), 0);
    if (summaryAmounts.salesAmount?.value != null) {
      applyTemplateResult(fields, selectedWords, "salesAmount", summaryAmounts.salesAmount, 0.75);
    } else {
      fields.salesAmount = String(lineSum);
      fields.confidence.salesAmount = Math.min(...financialLineItems.map((item) => item.confidence || 0));
    }
  } else if (tableItems && (!fields.salesAmount || fields.confidence.salesAmount <= tableItems.salesAmount.confidence)) {
    applyTemplateResult(fields, selectedWords, "salesAmount", tableItems.salesAmount, 0.85);
    fields.items = tableItems.items || [];
  }
  if (summaryAmounts.taxAmount?.value != null) applyTemplateResult(fields, selectedWords, "taxAmount", summaryAmounts.taxAmount, 0.75);
  if (summaryAmounts.totalAmount?.value != null) applyTemplateResult(fields, selectedWords, "totalAmount", summaryAmounts.totalAmount, 0.75);
  fields.financial = { lineAmounts: financialLineItems, ...summaryAmounts };
  if (!fields.quantity || fields.confidence.quantity < 0.8) {
    const quantityWord = nearestNumber(anchors.quantity, words, (value) => Number(value) >= 1 && Number(value) <= 999);
    if (quantityWord) applyTemplateResult(fields, selectedWords, "quantity", { value: quantityWord.numeric, words: [quantityWord] }, 0.6);
  }

  if (!fields.unitPrice || fields.confidence.unitPrice < 0.8) {
    const unitPriceWord = nearestNumber(anchors.unitPrice, words, (value) => Number(value) > 0 && Number(value) <= 1000000);
    if (unitPriceWord) applyTemplateResult(fields, selectedWords, "unitPrice", { value: unitPriceWord.numeric, words: [unitPriceWord] }, 0.6);
  }

  if (!fields.salesAmount && fields.quantity && fields.unitPrice && !fields.quantity.includes(",") && !fields.unitPrice.includes(",")) {
    fields.salesAmount = String(Number(fields.quantity) * Number(fields.unitPrice));
    fields.confidence.salesAmount = Math.min(fields.confidence.quantity || 0, fields.confidence.unitPrice || 0);
  }

  fields.buyerTaxId = fields.taxId;
  fields.identityEvidence = identityEvidence;

  return {
    fields,
    anchors,
    identityEvidence,
    selectedWords,
    vendorProfile: templateDetection?.template ? {
      vendorName: templateDetection.template.vendorName,
      vendorTaxId: templateDetection.template.vendorTaxId,
      templateName: templateDetection.template.templateName,
      reason: templateDetection.reason
    } : null,
    profileCorrection: null
  };
}
