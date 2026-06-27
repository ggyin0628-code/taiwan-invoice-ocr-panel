import {
  makeField,
  recognitionToFlatFields,
  recognitionToRecordMeta,
  validateInvoiceRecognition
} from "./validateInvoiceRecognition.js";

function sameValue(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function providerLabel(source) {
  return {
    paddleocr: "PaddleOCR",
    easyocr: "EasyOCR",
    tesseract: "Tesseract",
    macos_vision: "macOS Vision",
    google_vision: "Google Vision",
    openai_vision: "OpenAI Vision"
  }[source] || source;
}

function chooseField(candidates, fieldName) {
  const fields = candidates.map((candidate) => candidate?.[fieldName]).filter(Boolean);
  const valid = fields.filter((field) => field.status === "auto");
  if (!valid.length) return fields[0] || makeField(null, { reason: "需人工確認" });
  const [first, ...rest] = valid;
  const conflict = rest.find((field) => !sameValue(first.value, field.value));
  if (conflict) {
    return makeField(null, {
      rawText: valid.map((field) => `${providerLabel(field.source)}:${field.rawText || field.value}`).join(" / "),
      source: first.source,
      confidence: Math.min(first.confidence, conflict.confidence),
      status: "low_confidence",
      reason: "不同 Provider 結果不一致"
    });
  }
  const agreeing = valid.length;
  return {
    ...first,
    confidence: Math.min(1, first.confidence + (agreeing > 1 ? 0.08 : 0))
  };
}

function itemsSignature(items = []) {
  return items.map((item) => `${item.quantity.value ?? ""}x${item.unitPrice.value ?? ""}`).join("|");
}

function chooseItems(candidates, warnings) {
  const validSets = candidates
    .map((candidate) => (candidate.items || []).filter((item) => item.quantity.status === "auto" && item.unitPrice.status === "auto"))
    .filter((items) => items.length);
  if (!validSets.length) return candidates.find((candidate) => candidate.items?.length)?.items || [];

  const first = validSets[0];
  const conflict = validSets.slice(1).find((items) => itemsSignature(items) !== itemsSignature(first));
  if (conflict) {
    warnings.push("不同 Provider 的品項數量/單價不一致");
    return first.map((item) => ({
      quantity: { ...item.quantity, status: "low_confidence", reason: "不同 Provider 結果不一致" },
      unitPrice: { ...item.unitPrice, status: "low_confidence", reason: "不同 Provider 結果不一致" },
      amount: { ...item.amount, status: "low_confidence", reason: "不同 Provider 結果不一致" }
    }));
  }
  return first;
}

function calculateFormulaFields(items) {
  const validItems = items.filter((item) => item.quantity.status === "auto" && item.unitPrice.status === "auto");
  if (!validItems.length) {
    return {
      amount: makeField(null, { source: "formula", confidence: 0, status: "manual_required", reason: "沒有可計算的品項" }),
      tax: makeField(null, { source: "formula", confidence: 0, status: "manual_required", reason: "沒有可計算的金額" }),
      total: makeField(null, { source: "formula", confidence: 0, status: "manual_required", reason: "沒有可計算的金額" })
    };
  }
  const amount = validItems.reduce((sum, item) => sum + Number(item.quantity.value) * Number(item.unitPrice.value), 0);
  const confidence = Math.min(...validItems.flatMap((item) => [item.quantity.confidence, item.unitPrice.confidence]));
  const tax = Math.round(amount * 0.05);
  return {
    amount: makeField(amount, { source: "formula", confidence, status: "auto" }),
    tax: makeField(tax, { source: "formula", confidence, status: "auto" }),
    total: makeField(amount + tax, { source: "formula", confidence, status: "auto" })
  };
}

export function validateProviderCandidate(fields, { source, defaultConfidence = 0.8, warnings = [] } = {}) {
  const recognition = validateInvoiceRecognition({ ...(fields || {}), warnings }, { source, defaultConfidence });
  return recognition;
}

export function mergeInvoiceRecognitionResults({ candidates = [], mode = "local", providerEvents = [] } = {}) {
  const warnings = providerEvents.map((event) => event.error).filter(Boolean);
  const validCandidates = candidates.filter(Boolean);
  const baseCandidates = validCandidates.length ? validCandidates : [
    validateInvoiceRecognition({}, { source: "manual", defaultConfidence: 0 })
  ];
  const items = chooseItems(baseCandidates, warnings);
  const formula = calculateFormulaFields(items);
  const result = {
    invoiceNo: chooseField(baseCandidates, "invoiceNo"),
    buyerTaxId: chooseField(baseCandidates, "buyerTaxId"),
    items,
    ...formula,
    overallStatus: "needs_review",
    warnings: [...new Set([...warnings, ...baseCandidates.flatMap((candidate) => candidate.warnings || [])].filter(Boolean))],
    debug: {
      mode,
      providers: providerEvents,
      candidates: baseCandidates
    }
  };

  const allFields = [
    result.invoiceNo,
    result.buyerTaxId,
    result.amount,
    result.tax,
    result.total,
    ...(result.items || []).flatMap((item) => [item.quantity, item.unitPrice, item.amount])
  ];
  result.overallStatus = allFields.some((field) => field?.status !== "auto") ? "needs_review" : "auto";

  return {
    recognitionResult: result,
    flatFields: recognitionToFlatFields(result),
    meta: recognitionToRecordMeta(result)
  };
}

