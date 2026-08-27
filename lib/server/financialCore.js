export const FINANCIAL_STATUS = Object.freeze({
  AUTO_OK: "AUTO_OK",
  REVIEW_RECOMMENDED: "REVIEW_RECOMMENDED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  INVALID: "INVALID"
});

const SELLER_LABEL_PATTERN = /賣方|賣人|賣受人|營業人|营业人|賣方統一編號|賣方統編|發票專用章|发票专用章|統一發票專用章|统一发票专用章|seller|vendor/i;
const SALES_LABEL_PATTERN = /銷售額|销售额|銷售|销售|小計|小计|subtotal/i;
const TAX_LABEL_PATTERN = /稅額|税额|營業稅|营业税|營業税|营业稅|稅金|税金|tax/i;
const TOTAL_LABEL_PATTERN = /總計|总计|總額|总额|應收|应收|合計金額|合计金额|合計|合计|total/i;
const AMOUNT_HEADER_PATTERN = /金額|金额|小計|小计|amount/i;
const TAX_ID_PATTERN = /^\d{8}$/;
const MONEY_PATTERN = /\d[\d,.]*/g;

function asNumber(value) {
  if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) return asNumber(value.value);
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(String(value).replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function asDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizeMoneyText(value) {
  return String(value ?? "")
    .replace(/[Oo]/g, "0")
    .replace(/[Il|]/g, "1")
    .replace(/[Ss¢]/g, "5")
    .replace(/[Bb]/g, "8")
    .replace(/[G]/g, "6");
}

function normalizedMoneyCandidates(value, { minDigits = 1 } = {}) {
  const text = normalizeMoneyText(value);
  return [...text.matchAll(MONEY_PATTERN)]
    .map((match) => ({ raw: match[0], value: asNumber(match[0]), offset: match.index || 0 }))
    .filter((candidate) => candidate.value != null && String(Math.trunc(candidate.value)).length >= minDigits && candidate.value > 0)
    .sort((a, b) => String(b.raw).replace(/\D/g, "").length - String(a.raw).replace(/\D/g, "").length || b.value - a.value);
}

function wordText(word) {
  return String(word?.text ?? "").trim();
}

function wordBox(word) {
  if (word?.box) {
    return {
      x1: Number(word.box.x1 ?? 0),
      y1: Number(word.box.y1 ?? 0),
      x2: Number(word.box.x2 ?? 0),
      y2: Number(word.box.y2 ?? 0)
    };
  }
  const left = Number(word?.left ?? 0);
  const top = Number(word?.top ?? 0);
  const width = Number(word?.width ?? 0);
  const height = Number(word?.height ?? 0);
  return { x1: left, y1: top, x2: left + width, y2: top + height };
}

function wordCenter(word) {
  const box = wordBox(word);
  return { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
}

function confidenceOf(words = []) {
  const values = words.map((word) => Number(word?.confidence ?? word?.score)).filter((value) => Number.isFinite(value));
  if (!values.length) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.max(0, Math.min(1, average > 1 ? average / 100 : average));
}

function unionBox(words = []) {
  const boxes = words.map(wordBox);
  if (!boxes.length) return null;
  return {
    x1: Math.round(Math.min(...boxes.map((box) => box.x1))),
    y1: Math.round(Math.min(...boxes.map((box) => box.y1))),
    x2: Math.round(Math.max(...boxes.map((box) => box.x2))),
    y2: Math.round(Math.max(...boxes.map((box) => box.y2)))
  };
}

function field(value, { rawText = value, confidence = 0, source = "tesseract", status = "REVIEW_REQUIRED", reason = "", evidence = [] } = {}) {
  return {
    value: value ?? null,
    rawText: String(rawText ?? ""),
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
    source,
    status,
    reason,
    evidence
  };
}

function rowGroups(words = [], tolerance = 30) {
  const rows = [];
  for (const word of [...words].sort((a, b) => wordCenter(a).y - wordCenter(b).y || wordCenter(a).x - wordCenter(b).x)) {
    const y = wordCenter(word).y;
    const target = rows.find((row) => Math.abs(row.y - y) <= tolerance);
    if (target) {
      target.words.push(word);
      target.y = target.words.reduce((sum, item) => sum + wordCenter(item).y, 0) / target.words.length;
    } else {
      rows.push({ y, words: [word] });
    }
  }
  return rows.map((row) => ({ ...row, words: [...row.words].sort((a, b) => wordCenter(a).x - wordCenter(b).x) }));
}

function numericWordCandidates(word, { minDigits = 1, maxValue = 100000000 } = {}) {
  return normalizedMoneyCandidates(wordText(word), { minDigits })
    .filter((candidate) => candidate.value <= maxValue)
    .map((candidate) => ({ ...candidate, word }));
}

function sellerRelation(candidateWord, sellerLabels, imageWidth, imageHeight, knownSellerTaxIds) {
  const candidateCenter = wordCenter(candidateWord);
  const normalized = asDigits(wordText(candidateWord));
  if (knownSellerTaxIds.has(normalized)) {
    return { relation: "known-seller-profile", score: 0.54, reason: "candidate matches configured/template seller tax ID" };
  }
  for (const label of sellerLabels) {
    const labelCenter = wordCenter(label);
    const sameRow = Math.abs(labelCenter.y - candidateCenter.y) <= Math.max(24, imageHeight * 0.045);
    const rightOfLabel = candidateCenter.x >= labelCenter.x - 12;
    const nearBelow = candidateCenter.y > labelCenter.y && candidateCenter.y - labelCenter.y <= Math.max(70, imageHeight * 0.10) && Math.abs(candidateCenter.x - labelCenter.x) <= Math.max(300, imageWidth * 0.28);
    if (sameRow && rightOfLabel) return { relation: "seller-label-same-row", score: 0.42, reason: "seller/vendor anchor and 8-digit candidate share a row" };
    if (nearBelow) return { relation: "seller-label-nearby", score: 0.32, reason: "seller/vendor anchor is immediately above or nearby" };
  }
  const normalizedX = candidateCenter.x / Math.max(1, imageWidth);
  const normalizedY = candidateCenter.y / Math.max(1, imageHeight);
  if (normalizedX >= 0.58 && normalizedY >= 0.28) return { relation: "seller-stamp-or-footer-region", score: 0.16, reason: "candidate lies in seller stamp/footer geometry" };
  if (normalizedY >= 0.72) return { relation: "seller-footer-region", score: 0.12, reason: "candidate lies in lower seller/footer region" };
  return { relation: "unanchored", score: 0.01, reason: "no seller anchor or seller geometry" };
}

export function resolveSellerTaxId({ words = [], text = "", imageWidth = 1200, imageHeight = 700, buyerTaxId = "", invoiceNumber = "", knownSellerTaxIds = [], templateVendorTaxId = "", source = "tesseract" } = {}) {
  const configured = [...knownSellerTaxIds, templateVendorTaxId].map(asDigits).filter((value) => TAX_ID_PATTERN.test(value));
  const known = new Set(configured);
  const invoiceDigits = asDigits(invoiceNumber).slice(-8);
  const sellerLabels = words.filter((word) => SELLER_LABEL_PATTERN.test(wordText(word)));
  const candidates = [];
  const seen = new Set();

  const addCandidate = (rawText, candidateWords, normalized, relationOverride = null) => {
    if (!TAX_ID_PATTERN.test(normalized)) return;
    const key = `${normalized}:${unionBox(candidateWords)?.x1 ?? 0}:${unionBox(candidateWords)?.y1 ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    const confidence = confidenceOf(candidateWords);
    const relationInfo = relationOverride || sellerRelation(candidateWords[0], sellerLabels, imageWidth, imageHeight, known);
    const excludedBuyer = normalized === asDigits(buyerTaxId);
    const excludedInvoice = normalized === invoiceDigits;
    const evidenceScore = excludedBuyer || excludedInvoice
      ? 0
      : Math.min(1, 0.38 + relationInfo.score + Math.min(0.20, confidence * 0.20) + (known.has(normalized) ? 0.12 : 0));
    const resolverReason = excludedBuyer
      ? "candidate excluded because it equals known buyer tax ID"
      : excludedInvoice
        ? "candidate excluded because it equals invoice-number numeric segment"
        : relationInfo.reason;
    candidates.push({
      rawCandidate: rawText,
      normalizedCandidate: normalized,
      bbox: unionBox(candidateWords),
      confidence,
      anchorRelationship: excludedBuyer || excludedInvoice ? "identity-collision-excluded" : relationInfo.relation,
      evidenceScore: Number(evidenceScore.toFixed(4)),
      resolverReason,
      source,
      words: candidateWords
    });
  };

  for (const word of words) {
    for (const candidate of numericWordCandidates(word, { minDigits: 8, maxValue: 99999999 })) {
      addCandidate(candidate.raw, [word], String(Math.trunc(candidate.value)).padStart(8, "0"));
    }
  }
  for (const match of String(text || "").matchAll(/\d{8}/g)) {
    const normalized = match[0];
    if (!candidates.some((candidate) => candidate.normalizedCandidate === normalized)) {
      addCandidate(match[0], [], normalized);
    }
  }

  const evidence = candidates.map(({ words: _words, ...candidate }) => candidate);
  const eligible = candidates.filter((candidate) => candidate.evidenceScore >= 0.70);
  const ranked = [...eligible].sort((a, b) => b.evidenceScore - a.evidenceScore || b.confidence - a.confidence);
  if (!ranked.length) {
    const hasCollision = candidates.some((candidate) => candidate.anchorRelationship === "identity-collision-excluded");
    return {
      ...field(null, { source, confidence: 0, status: "REVIEW_REQUIRED", reason: hasCollision ? "seller candidate collided with buyer/invoice identity" : "seller/vendor tax anchor candidate missing", evidence }),
      candidates: evidence,
      selected: null,
      resolverReason: hasCollision ? "seller candidate collided with buyer/invoice identity" : "seller/vendor tax anchor candidate missing"
    };
  }
  const selected = ranked[0];
  const ambiguous = ranked.slice(1).some((candidate) => candidate.normalizedCandidate !== selected.normalizedCandidate && selected.evidenceScore - candidate.evidenceScore < 0.08);
  if (ambiguous) {
    return {
      ...field(null, { source, confidence: Math.min(selected.confidence, ranked[1].confidence), status: "REVIEW_REQUIRED", reason: "multiple seller tax IDs have close evidence scores", evidence }),
      candidates: evidence,
      selected: null,
      resolverReason: "multiple seller tax IDs have close evidence scores"
    };
  }
  const status = selected.confidence >= 0.80 && selected.evidenceScore >= 0.78 ? "auto" : "low_confidence";
  const selectedWithoutWords = Object.fromEntries(Object.entries(selected).filter(([key]) => key !== "words"));
  return {
    ...field(selected.normalizedCandidate, {
      rawText: selected.rawCandidate,
      confidence: selected.confidence,
      source,
      status,
      reason: selected.resolverReason,
      evidence
    }),
    candidates: evidence,
    selected: selectedWithoutWords,
    resolverReason: selected.resolverReason
  };
}

function amountHeader(words) {
  return words.find((word) => AMOUNT_HEADER_PATTERN.test(wordText(word)) && !TAX_LABEL_PATTERN.test(wordText(word)) && !TOTAL_LABEL_PATTERN.test(wordText(word))) || null;
}

function makeCellEvidence(word, value, column, relation, source) {
  return {
    rawText: wordText(word),
    normalizedValue: value,
    bbox: wordBox(word),
    confidence: confidenceOf([word]),
    source,
    column,
    relation
  };
}

export function extractLineAmounts({ words = [], imageWidth = 1200, imageHeight = 700, source = "tesseract" } = {}) {
  if (!Array.isArray(words) || !words.length) return [];
  const headerWords = words.filter((word) => /(品名|數量|数量|單價|单价|金額|金额|小計|小计|amount)/i.test(wordText(word)));
  const amountHeaderWord = amountHeader(words);
  const headerY = headerWords.length ? Math.min(...headerWords.map((word) => wordCenter(word).y)) : imageHeight * 0.30;
  const typicalHeight = headerWords.length ? Math.max(...headerWords.map((word) => wordBox(word).y2 - wordBox(word).y1)) : imageHeight * 0.035;
  const amountX = amountHeaderWord ? wordCenter(amountHeaderWord).x : imageWidth * 0.66;
  const quantityHeaderWord = words.find((word) => /數量|数量/i.test(wordText(word)));
  const unitPriceHeaderWord = words.find((word) => /單價|单价/i.test(wordText(word)));
  const quantityX = quantityHeaderWord ? wordCenter(quantityHeaderWord).x : imageWidth * 0.37;
  const unitPriceX = unitPriceHeaderWord ? wordCenter(unitPriceHeaderWord).x : imageWidth * 0.48;
  const amountHalf = Math.max(imageWidth * 0.055, Math.abs(amountX - unitPriceX) * 0.38);
  const quantityHalf = Math.max(imageWidth * 0.035, Math.abs(unitPriceX - quantityX) * 0.45);
  const unitPriceHalf = Math.max(imageWidth * 0.045, Math.abs(amountX - unitPriceX) * 0.42);
  const summaryLabels = words.filter((word) => SALES_LABEL_PATTERN.test(wordText(word)) || TAX_LABEL_PATTERN.test(wordText(word)) || TOTAL_LABEL_PATTERN.test(wordText(word)) || /營業人|营业人|專用章|专用章/.test(wordText(word)));
  const firstSummaryY = summaryLabels.map((word) => wordCenter(word).y).filter((y) => y > headerY + typicalHeight * 2).sort((a, b) => a - b)[0];
  const cutoffY = Math.min(imageHeight * 0.86, firstSummaryY ? firstSummaryY - typicalHeight * 0.7 : imageHeight * 0.80);
  const tableWords = words.filter((word) => {
    const center = wordCenter(word);
    return center.y > headerY + Math.max(typicalHeight * 1.4, imageHeight * 0.025) && center.y < cutoffY && center.x < imageWidth * 0.90;
  });
  const rows = rowGroups(tableWords, Math.max(14, Math.min(42, typicalHeight * 1.8)));
  const lineItems = [];
  for (const row of rows) {
    const amountCandidates = row.words
      .flatMap((word) => numericWordCandidates(word, { minDigits: 2, maxValue: 100000000 }))
      .filter((candidate) => Math.abs(wordCenter(candidate.word).x - amountX) <= amountHalf)
      .sort((a, b) => Math.abs(wordCenter(a.word).x - amountX) - Math.abs(wordCenter(b.word).x - amountX) || b.value - a.value);
    if (!amountCandidates.length) continue;
    const amountCandidate = amountCandidates[0];
    const quantityCandidates = row.words
      .flatMap((word) => numericWordCandidates(word, { minDigits: 1, maxValue: 999 }))
      .filter((candidate) => Math.abs(wordCenter(candidate.word).x - quantityX) <= quantityHalf)
      .sort((a, b) => Math.abs(wordCenter(a.word).x - quantityX) - Math.abs(wordCenter(b.word).x - quantityX));
    const unitPriceCandidates = row.words
      .flatMap((word) => numericWordCandidates(word, { minDigits: 2, maxValue: 10000000 }))
      .filter((candidate) => Math.abs(wordCenter(candidate.word).x - unitPriceX) <= unitPriceHalf)
      .sort((a, b) => Math.abs(wordCenter(a.word).x - unitPriceX) - Math.abs(wordCenter(b.word).x - unitPriceX));
    const excludedSummary = row.words.some((word) => SALES_LABEL_PATTERN.test(wordText(word)) || TAX_LABEL_PATTERN.test(wordText(word)) || TOTAL_LABEL_PATTERN.test(wordText(word)));
    if (excludedSummary) continue;
    const amount = Math.trunc(amountCandidate.value);
    const amountEvidence = makeCellEvidence(amountCandidate.word, amount, "lineAmount", "row-local numeric token in amount column", source);
    const quantity = quantityCandidates[0] ? Math.trunc(quantityCandidates[0].value) : null;
    const unitPrice = unitPriceCandidates[0] ? Math.trunc(unitPriceCandidates[0].value) : null;
    const rowBox = unionBox(row.words);
    const itemNameTokens = row.words.filter((word) => !numericWordCandidates(word, { minDigits: 1, maxValue: 100000000 }).length && !/(品名|數量|数量|單價|单价|金額|金额|小計|小计)/i.test(wordText(word)));
    lineItems.push({
      lineNo: lineItems.length + 1,
      lineAmount: amount,
      amount,
      quantity,
      unitPrice,
      itemName: itemNameTokens.map(wordText).join(" ").slice(0, 80),
      rowBbox: rowBox,
      confidence: confidenceOf([amountCandidate.word]),
      source,
      evidence: {
        amount: amountEvidence,
        quantity: quantityCandidates[0] ? makeCellEvidence(quantityCandidates[0].word, quantity, "quantity", "optional row-local quantity evidence", source) : null,
        unitPrice: unitPriceCandidates[0] ? makeCellEvidence(unitPriceCandidates[0].word, unitPrice, "unitPrice", "optional row-local unit-price evidence", source) : null,
        rowBbox: rowBox
      },
      status: confidenceOf([amountCandidate.word]) >= 0.80 ? "auto" : "low_confidence"
    });
  }
  return lineItems.slice(0, 30);
}

function summaryKind(label) {
  const text = wordText(label);
  if (TAX_LABEL_PATTERN.test(text)) return "taxAmount";
  if (TOTAL_LABEL_PATTERN.test(text) && !SALES_LABEL_PATTERN.test(text)) return "totalAmount";
  if (SALES_LABEL_PATTERN.test(text)) return "salesAmount";
  return null;
}

export function extractSummaryAmounts({ words = [], imageWidth = 1200, imageHeight = 700, source = "tesseract" } = {}) {
  const labels = words.filter((word) => summaryKind(word));
  const summary = { salesAmount: null, taxAmount: null, totalAmount: null };
  const candidatesByKind = { salesAmount: [], taxAmount: [], totalAmount: [] };
  for (const label of labels) {
    const kind = summaryKind(label);
    if (!kind) continue;
    const labelCenter = wordCenter(label);
    const inline = normalizedMoneyCandidates(wordText(label), { minDigits: 2 }).map((candidate) => ({ ...candidate, words: [label], relation: "summary-label-inline" }));
    const nearby = words
      .flatMap((word) => numericWordCandidates(word, { minDigits: 2, maxValue: 100000000 }).map((candidate) => ({ ...candidate, words: [label, word] })))
      .filter((candidate) => {
        const center = wordCenter(candidate.word);
        const sameRow = Math.abs(center.y - labelCenter.y) <= Math.max(22, imageHeight * 0.04) && center.x >= labelCenter.x - 10;
        const below = center.y > labelCenter.y && center.y - labelCenter.y <= Math.max(55, imageHeight * 0.08) && Math.abs(center.x - labelCenter.x) <= Math.max(320, imageWidth * 0.30);
        return (sameRow || below) && center.y >= imageHeight * 0.45;
      })
      .map((candidate) => ({ ...candidate, relation: "summary-label-neighbor" }));
    const all = [...inline, ...nearby]
      .filter((candidate) => candidate.value != null && candidate.value > 0)
      .sort((a, b) => (a.relation === "summary-label-inline" ? -1 : 1) - (b.relation === "summary-label-inline" ? -1 : 1) || b.value - a.value);
    const candidate = all[0];
    if (candidate) {
      candidatesByKind[kind].push({
        value: Math.trunc(candidate.value),
        rawText: candidate.raw || wordText(candidate.word),
        confidence: confidenceOf(candidate.words),
        source,
        evidence: {
          rawText: candidate.raw || wordText(candidate.word),
          normalizedValue: Math.trunc(candidate.value),
          bbox: unionBox(candidate.words),
          confidence: confidenceOf(candidate.words),
          anchorRelationship: candidate.relation,
          label: wordText(label)
        }
      });
    }
  }
  for (const kind of Object.keys(candidatesByKind)) {
    const candidates = candidatesByKind[kind];
    if (!candidates.length) continue;
    const distinct = [...new Set(candidates.map((candidate) => candidate.value))];
    if (distinct.length > 1) {
      summary[kind] = field(null, { source, confidence: Math.min(...candidates.map((candidate) => candidate.confidence)), status: "REVIEW_REQUIRED", reason: `conflicting ${kind} candidates`, evidence: candidates.map((candidate) => candidate.evidence) });
    } else {
      const selected = candidates.sort((a, b) => b.confidence - a.confidence)[0];
      summary[kind] = field(selected.value, { rawText: selected.rawText, confidence: selected.confidence, source, status: selected.confidence >= 0.80 ? "auto" : "low_confidence", reason: "summary label and nearby monetary candidate", evidence: candidates.map((candidate) => candidate.evidence) });
    }
  }
  return summary;
}

export function reconcileFinancials({ lineAmounts = [], salesAmount = null, taxAmount = null, totalAmount = null, quantities = [], unitPrices = [], tolerance = Number(process.env.FINANCIAL_MONEY_TOLERANCE || 1) } = {}) {
  const numericLines = (Array.isArray(lineAmounts) ? lineAmounts : []).map((item) => asNumber(item?.value ?? item?.amount ?? item?.lineAmount ?? item)).filter((value) => value != null);
  const sales = asNumber(salesAmount?.value ?? salesAmount);
  const tax = asNumber(taxAmount?.value ?? taxAmount);
  const total = asNumber(totalAmount?.value ?? totalAmount);
  const within = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(0, Number(tolerance) || 0);
  const lineSum = numericLines.length ? numericLines.reduce((sum, value) => sum + value, 0) : null;
  const lineSumVsSales = lineSum == null || sales == null ? "UNAVAILABLE" : within(lineSum, sales) ? "PASS" : "MISMATCH";
  const salesPlusTaxVsTotal = sales == null || tax == null || total == null ? "UNAVAILABLE" : within(sales + tax, total) ? "PASS" : "MISMATCH";
  const formulaChecks = [];
  const maxRows = Math.max(quantities.length, unitPrices.length, numericLines.length);
  for (let index = 0; index < maxRows; index += 1) {
    const quantity = asNumber(quantities[index]);
    const unitPrice = asNumber(unitPrices[index]);
    const amount = numericLines[index];
    if (quantity == null || unitPrice == null || amount == null) {
      formulaChecks.push({ lineNo: index + 1, status: "UNAVAILABLE" });
    } else {
      formulaChecks.push({ lineNo: index + 1, status: within(quantity * unitPrice, amount) ? "PASS" : "MISMATCH", expected: quantity * unitPrice, observed: amount });
    }
  }
  const taxRate = sales && sales > 0 && tax != null ? tax / sales : null;
  const warnings = [];
  if (lineSumVsSales === "MISMATCH") warnings.push("line amount sum does not reconcile to sales amount");
  if (salesPlusTaxVsTotal === "MISMATCH") warnings.push("sales amount plus tax does not reconcile to total amount");
  if (formulaChecks.some((check) => check.status === "MISMATCH")) warnings.push("quantity × unit price does not reconcile to line amount");
  return {
    lineSumVsSales,
    salesPlusTaxVsTotal,
    lineFormulaChecks: formulaChecks,
    taxPlausibility: taxRate == null ? "UNAVAILABLE" : taxRate >= 0 && taxRate <= 1 ? "PLAUSIBLE" : "OUTLIER",
    taxRate,
    tolerance: Number(tolerance) || 0,
    warnings
  };
}

export function deriveFinancialStatus({ sellerTaxId = null, items = [], salesAmount = null, taxAmount = null, totalAmount = null, reconciliation = {}, optionalEvidenceAvailable = true, confidence = 0 } = {}) {
  if (sellerTaxId?.status === "invalid" || sellerTaxId?.status === "manual_required" || sellerTaxId?.status === "REVIEW_REQUIRED") return FINANCIAL_STATUS.REVIEW_REQUIRED;
  if (!sellerTaxId?.value) return FINANCIAL_STATUS.REVIEW_REQUIRED;
  if (!totalAmount?.value && totalAmount?.value !== 0) return FINANCIAL_STATUS.REVIEW_REQUIRED;
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length || rows.some((item) => !(item?.amount?.value != null || item?.lineAmount != null || item?.amount != null))) return FINANCIAL_STATUS.REVIEW_REQUIRED;
  if ([reconciliation.lineSumVsSales, reconciliation.salesPlusTaxVsTotal, ...(reconciliation.lineFormulaChecks || []).map((check) => check.status)].includes("MISMATCH")) return FINANCIAL_STATUS.REVIEW_REQUIRED;
  if ([salesAmount, taxAmount].some((fieldValue) => fieldValue?.status === "REVIEW_REQUIRED" || fieldValue?.status === "manual_required")) return FINANCIAL_STATUS.REVIEW_REQUIRED;
  if (!salesAmount?.value || !taxAmount?.value || !optionalEvidenceAvailable || confidence < 0.80 || reconciliation.lineSumVsSales === "UNAVAILABLE" || reconciliation.salesPlusTaxVsTotal === "UNAVAILABLE" || reconciliation.lineFormulaChecks?.some((check) => check.status === "UNAVAILABLE")) return FINANCIAL_STATUS.REVIEW_RECOMMENDED;
  return FINANCIAL_STATUS.AUTO_OK;
}

export const COMPANY_TAX_RATE = 0.05;

function taxRoundingFunction(policy) {
  if (policy === "round") return Math.round;
  if (policy === "floor") return Math.floor;
  if (policy === "ceil") return Math.ceil;
  return null;
}

export function calculateDeterministicFinancials({ items = [], taxRate = COMPANY_TAX_RATE, taxRounding = process.env.FINANCIAL_TAX_ROUNDING || "", taxPolicyConfirmed = process.env.FINANCIAL_TAX_ROUNDING_CONFIRMED === "true" } = {}) {
  const rows = (Array.isArray(items) ? items : []).map((item, index) => {
    const quantity = item?.quantity?.value ?? item?.quantity ?? null;
    const unitPrice = item?.unitPrice?.value ?? item?.unitPrice ?? null;
    const valid = Number.isInteger(Number(quantity)) && Number(quantity) > 0 && Number.isInteger(Number(unitPrice)) && Number(unitPrice) > 0;
    const printed = item?.lineAmount && !["formula", "line-amount-sum"].includes(item.lineAmount.source) ? item.lineAmount : null;
    if (!valid) return { ...item, calculatedLineAmount: null, printedLineAmount: printed, financialVerification: { status: "UNAVAILABLE", printedLineAmount: printed } };
    const calculatedValue = Number(quantity) * Number(unitPrice);
    const calculated = field(calculatedValue, {
      source: "formula",
      confidence: Math.min(Number(item.quantity?.confidence || 0), Number(item.unitPrice?.confidence || 0)),
      status: item.quantity?.status === "auto" && item.unitPrice?.status === "auto" ? "auto" : "low_confidence",
      reason: "company deterministic quantity × unit price calculation"
    });
    const verification = printed
      ? { status: numericValue(printed.value) === calculatedValue ? "CALCULATED_VERIFIED" : "MISMATCH_REVIEW_REQUIRED", printedLineAmount: printed, calculatedLineAmount: calculated }
      : { status: "CALCULATED_ONLY", printedLineAmount: null, calculatedLineAmount: calculated };
    return { ...item, printedLineAmount: printed, calculatedLineAmount: calculated, lineAmount: calculated, amount: calculated, financialVerification: verification };
  });
  const complete = rows.length > 0 && rows.every((row) => row.calculatedLineAmount?.value != null);
  const salesValue = complete ? rows.reduce((sum, row) => sum + Number(row.calculatedLineAmount.value), 0) : null;
  const salesAmount = salesValue == null ? field(null, { source: "formula", confidence: 0, status: "manual_required", reason: "quantity/unitPrice not complete for all accepted rows" }) : field(salesValue, { source: "formula", confidence: Math.min(...rows.map((row) => row.calculatedLineAmount.confidence)), status: rows.every((row) => row.calculatedLineAmount.status === "auto") ? "auto" : "low_confidence", reason: "sum of deterministic calculated line amounts" });
  const round = taxRoundingFunction(taxRounding);
  const taxValue = salesValue != null && round && taxPolicyConfirmed ? round(salesValue * Number(taxRate)) : null;
  const taxAmount = taxValue == null ? field(null, { source: "formula", confidence: 0, status: "manual_required", reason: round ? "company tax rounding policy is not confirmed" : "company tax rounding policy is not configured" }) : field(taxValue, { source: "formula", confidence: salesAmount.confidence, status: "auto", reason: `company tax rule ${Number(taxRate)} with ${taxRounding} rounding` });
  const totalAmount = salesValue != null && taxValue != null ? field(salesValue + taxValue, { source: "formula", confidence: Math.min(salesAmount.confidence, taxAmount.confidence), status: "auto", reason: "deterministic sales + tax calculation" }) : field(null, { source: "formula", confidence: 0, status: "manual_required", reason: "tax amount unavailable until company rounding policy is confirmed" });
  return { items: rows, salesAmount, taxAmount, totalAmount, salesValue, taxValue, totalValue: totalAmount.value, complete, taxRate: Number(taxRate), taxRounding: taxRounding || null, taxPolicyConfirmed: Boolean(taxPolicyConfirmed), secondaryVerification: rows.map((row) => row.financialVerification) };
}

export function buildFinancialCore({ sellerTaxId = null, buyerTaxId = null, items = [], salesAmount = null, taxAmount = null, totalAmount = null, optionalEvidenceAvailable = true, confidence = 0 } = {}) {
  const lineAmounts = (Array.isArray(items) ? items : []).map((item) => item?.amount?.value ?? item?.lineAmount ?? item?.amount).filter((value) => value != null).map((value) => Number(value));
  const quantities = (Array.isArray(items) ? items : []).map((item) => item?.quantity?.value ?? item?.quantity ?? null);
  const unitPrices = (Array.isArray(items) ? items : []).map((item) => item?.unitPrice?.value ?? item?.unitPrice ?? null);
  const reconciliation = reconcileFinancials({ lineAmounts, salesAmount, taxAmount, totalAmount, quantities, unitPrices });
  const status = deriveFinancialStatus({ sellerTaxId, items, salesAmount, taxAmount, totalAmount, reconciliation, optionalEvidenceAvailable, confidence });
  return {
    sellerTaxId,
    buyerTaxId,
    lineAmounts,
    salesAmount,
    taxAmount,
    totalAmount,
    reconciliation,
    status
  };
}

export function numericValue(value) {
  return asNumber(value);
}

export function boxForWord(word) {
  return wordBox(word);
}

export function confidenceForWords(words) {
  return confidenceOf(words);
}
