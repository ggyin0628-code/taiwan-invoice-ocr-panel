const INVOICE_PATTERN = /^[A-Z]{2}[0-9]{8}$/;
const TAX_PATTERN = /^[0-9]{8}$/;
const BUYER_LABEL_PATTERN = /統一編號|統編|统一編號|统一编号|买受人：|買受人：|买受人(?!註記|注记)|買受人(?!註記|注记)/;
const SELLER_LABEL_PATTERN = /營業人|营业人|發票專用章|发票专用章/;

function textOf(word) {
  return String(word?.text || "").trim();
}

function digits(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function normalizeInvoice(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function confidenceOf(words = []) {
  const values = words.map((word) => Number(word?.confidence)).filter((value) => Number.isFinite(value));
  if (!values.length) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.max(0, Math.min(1, average > 1 ? average / 100 : average));
}

function center(word) {
  return {
    x: Number(word?.left || 0) + Number(word?.width || 0) / 2,
    y: Number(word?.top || 0) + Number(word?.height || 0) / 2
  };
}

function bboxFromWords(words = []) {
  const usable = words.filter(Boolean);
  if (!usable.length) return null;
  const left = Math.min(...usable.map((word) => Number(word.left || 0)));
  const top = Math.min(...usable.map((word) => Number(word.top || 0)));
  const right = Math.max(...usable.map((word) => Number(word.left || 0) + Number(word.width || 0)));
  const bottom = Math.max(...usable.map((word) => Number(word.top || 0) + Number(word.height || 0)));
  return { x1: Math.round(left), y1: Math.round(top), x2: Math.round(right), y2: Math.round(bottom) };
}

function relationFor(kind, bbox, imageWidth, imageHeight, anchorPresent = false) {
  if (!bbox) return "text-only-no-bbox";
  const cx = (bbox.x1 + bbox.x2) / 2;
  const cy = (bbox.y1 + bbox.y2) / 2;
  const nx = cx / Math.max(1, imageWidth);
  const ny = cy / Math.max(1, imageHeight);
  if (kind === "invoice") {
    if (ny <= 0.34 && nx <= 0.52) return anchorPresent ? "invoice-anchor-header-left" : "invoice-header-left";
    if (ny <= 0.34) return "invoice-header";
    return "outside-invoice-header";
  }
  if (anchorPresent && ny <= 0.42 && nx <= 0.76) return "buyer-label-region";
  if (nx >= 0.68 && ny >= 0.30) return "seller-region-excluded";
  if (ny <= 0.42 && nx <= 0.76) return "buyer-region-unanchored";
  return "other-region";
}

function scoreEvidence({ kind, normalized, confidence, relation, anchorPresent, split = false, sellerExcluded = false, invoiceCollision = false }) {
  const pattern = kind === "invoice" ? INVOICE_PATTERN.test(normalized) : TAX_PATTERN.test(normalized);
  if (!pattern) return 0;
  if (sellerExcluded || invoiceCollision) return 0;
  const geometry = kind === "invoice"
    ? ({ "invoice-anchor-header-left": 0.34, "invoice-header-left": 0.28, "invoice-header": 0.22, "outside-invoice-header": 0.02 }[relation] || 0)
    : ({ "buyer-label-region": 0.38, "buyer-region-unanchored": 0.12, "seller-region-excluded": 0, "other-region": 0.01 }[relation] || 0);
  const anchor = anchorPresent ? 0.12 : 0;
  const splitBonus = split ? 0.08 : 0;
  const bboxBonus = relation === "text-only-no-bbox" ? 0 : 0.06;
  return Math.max(0, Math.min(1, 0.42 + geometry + anchor + splitBonus + bboxBonus + Math.min(0.2, confidence * 0.2)));
}

function evidenceRecord({ kind, rawCandidate, normalizedCandidate, words = [], imageWidth, imageHeight, anchorPresent = false, split = false, resolverReason = "" }) {
  const bbox = bboxFromWords(words);
  const confidence = confidenceOf(words);
  const relation = relationFor(kind, bbox, imageWidth, imageHeight, anchorPresent);
  const invoiceCollision = kind === "tax" && false;
  const sellerExcluded = relation === "seller-region-excluded";
  return {
    rawCandidate: String(rawCandidate || ""),
    normalizedCandidate,
    bbox,
    confidence,
    anchorRelationship: relation,
    evidenceScore: Number(scoreEvidence({ kind, normalized: normalizedCandidate, confidence, relation, anchorPresent, split, sellerExcluded, invoiceCollision }).toFixed(4)),
    resolverReason: resolverReason || "candidate emitted by constrained identity resolver"
  };
}

function invoiceCandidate({ raw, normalized, words, imageWidth, imageHeight, anchorPresent = false, split = false, reason }) {
  if (!INVOICE_PATTERN.test(normalized)) return null;
  return {
    ...evidenceRecord({ kind: "invoice", rawCandidate: raw, normalizedCandidate: normalized, words, imageWidth, imageHeight, anchorPresent, split, resolverReason: reason }),
    words
  };
}

function taxCandidate({ raw, normalized, words, imageWidth, imageHeight, anchorPresent, invoiceDigits, reason }) {
  if (!TAX_PATTERN.test(normalized) || normalized === invoiceDigits) return null;
  const evidence = evidenceRecord({ kind: "tax", rawCandidate: raw, normalizedCandidate: normalized, words, imageWidth, imageHeight, anchorPresent, resolverReason: reason });
  if (evidence.anchorRelationship === "seller-region-excluded") {
    evidence.evidenceScore = 0;
    evidence.resolverReason = "seller-region candidate excluded from buyer tax resolution";
  }
  return { ...evidence, words };
}

function attachSelection(candidates, selected, resolverReason) {
  return {
    value: selected?.normalizedCandidate || "",
    words: selected?.words || [],
    confidence: selected?.confidence || 0,
    candidates: candidates.map(({ words: _words, ...candidate }) => candidate),
    selected: selected ? (() => { const { words: _words, ...candidate } = selected; return candidate; })() : null,
    resolverReason
  };
}

function selectCandidate(candidates, threshold, missingReason) {
  const eligible = candidates.filter((candidate) => candidate.evidenceScore >= threshold);
  const selected = [...eligible].sort((a, b) => b.evidenceScore - a.evidenceScore || b.confidence - a.confidence)[0] || null;
  return { selected, reason: selected ? "selected highest-scoring constrained identity evidence" : missingReason };
}

export function resolveInvoiceIdentity({ words = [], text = "", regionWords = [], regionText = "", imageWidth = 1200, imageHeight = 700 } = {}) {
  const candidates = [];
  const addDirect = (raw, candidateWords, sourceReason, anchorPresent = false) => {
    const normalized = normalizeInvoice(raw);
    const candidate = invoiceCandidate({ raw, normalized, words: candidateWords, imageWidth, imageHeight, anchorPresent, reason: sourceReason });
    if (candidate) candidates.push(candidate);
  };

  for (const word of [...regionWords, ...words]) {
    const raw = textOf(word);
    const match = raw.toUpperCase().match(/[A-Z]{2}\s*\d{8}/);
    if (match) addDirect(match[0], [word], "complete invoice pattern in anchored OCR box", true);
  }

  const prefixWords = words.filter((word) => /^[A-Z]{2}$/.test(normalizeInvoice(textOf(word))));
  const numberWords = words.filter((word) => digits(textOf(word)).length === 8);
  for (const prefix of prefixWords) {
    for (const number of numberWords) {
      const pc = center(prefix);
      const nc = center(number);
      const sameRow = Math.abs(pc.y - nc.y) <= Math.max(24, imageHeight * 0.05);
      const ordered = Number(number.left || 0) > Number(prefix.left || 0);
      const header = Math.min(Number(prefix.top || 0), Number(number.top || 0)) <= imageHeight * 0.34;
      if (sameRow && ordered && header) {
        addDirect(`${textOf(prefix)}${digits(textOf(number))}`, [prefix, number], "joined split prefix and number on same invoice header row", true);
      }
    }
  }

  const combinedText = `${regionText}\n${text}`;
  for (const match of combinedText.toUpperCase().matchAll(/[A-Z]{2}\s*\d{8}/g)) {
    const normalized = normalizeInvoice(match[0]);
    if (!candidates.some((candidate) => candidate.normalizedCandidate === normalized)) {
      const candidate = invoiceCandidate({
        raw: match[0],
        normalized,
        words: [],
        imageWidth,
        imageHeight,
        anchorPresent: false,
        reason: "context text candidate without recoverable OCR bbox; review-only fallback"
      });
      if (candidate) candidates.push(candidate);
    }
  }

  const unique = [...new Map(candidates.map((candidate) => [`${candidate.normalizedCandidate}:${candidate.bbox?.x1 || 0}:${candidate.bbox?.y1 || 0}`, candidate])).values()];
  const { selected, reason } = selectCandidate(unique, 0.70, "no invoice candidate met format, header geometry and confidence threshold");
  return attachSelection(unique, selected, reason);
}

export function resolveBuyerTaxIdentity({ words = [], text = "", invoiceNumber = "", imageWidth = 1200, imageHeight = 700 } = {}) {
  const candidates = [];
  const invoiceDigits = digits(invoiceNumber).slice(-8);
  const labelWords = words.filter((word) => BUYER_LABEL_PATTERN.test(textOf(word)) && !/買受人註記|买受人注记/.test(textOf(word)));
  const sellerWords = words.filter((word) => SELLER_LABEL_PATTERN.test(textOf(word)));
  const allNumericWords = words.filter((word) => digits(textOf(word)).length >= 8);

  const addTax = (raw, candidateWords, anchorPresent, reason) => {
    const normalizedValues = String(raw || "").match(/\d{8}/g) || [];
    for (const normalized of normalizedValues) {
      const candidate = taxCandidate({ raw, normalized, words: candidateWords, imageWidth, imageHeight, anchorPresent, invoiceDigits, reason });
      if (candidate) candidates.push(candidate);
    }
  };

  for (const label of labelWords) {
    const lc = center(label);
    const labelY = lc.y;
    const nearby = allNumericWords
      .filter((word) => {
        const wc = center(word);
        const sameRow = Math.abs(wc.y - labelY) <= Math.max(24, imageHeight * 0.05);
        const below = wc.y > labelY && Math.abs(wc.x - lc.x) <= Math.max(220, imageWidth * 0.22);
        return (sameRow && wc.x > lc.x) || below;
      })
      .sort((a, b) => Math.hypot(center(a).x - lc.x, center(a).y - lc.y) - Math.hypot(center(b).x - lc.x, center(b).y - lc.y));
    addTax(textOf(label), [label], true, "buyer label anchor found; searching same-row/nearest numeric candidate");
    for (const number of nearby) {
      addTax(textOf(number), [label, number], true, "buyer label plus same-row/nearest numeric candidate");
    }
  }

  // A combined OCR line may contain label + ID + date, so inspect every word that is anchored by a buyer label.
  for (const word of words) {
    const raw = textOf(word);
    if (BUYER_LABEL_PATTERN.test(raw)) addTax(raw, [word], true, "combined buyer label and tax ID/date OCR line");
  }

  // Preserve seller-region numeric evidence for diagnostics, but it receives score 0 and is never selected.
  for (const number of allNumericWords) {
    const relation = relationFor("tax", bboxFromWords([number]), imageWidth, imageHeight, false);
    if (relation === "seller-region-excluded") addTax(textOf(number), [number], false, "numeric candidate in seller/stamp region");
  }

  const unique = [...new Map(candidates.map((candidate) => [`${candidate.normalizedCandidate}:${candidate.bbox?.x1 || 0}:${candidate.bbox?.y1 || 0}:${candidate.anchorRelationship}`, candidate])).values()];
  const { selected, reason } = selectCandidate(unique, 0.70, labelWords.length ? "buyer anchor found but no non-colliding candidate met geometry/confidence threshold" : "buyer tax anchor missing; unrelated eight-digit values are not accepted");
  return attachSelection(unique, selected, reason);
}

export function normalizeInvoiceContextCandidate(value) {
  return normalizeInvoice(value);
}

export function normalizeTaxContextCandidate(value) {
  return digits(value);
}
