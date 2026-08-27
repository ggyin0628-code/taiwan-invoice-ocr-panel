import {
  buildFinancialCore,
  calculateDeterministicFinancials,
  FINANCIAL_STATUS,
  numericValue
} from "./financialCore.js";
import {
  makeField,
  recognitionToFlatFields,
  recognitionToRecordMeta,
  validateInvoiceRecognition
} from "./validateInvoiceRecognition.js";
import { deriveReviewStatus } from "./invoiceStatus.js";

function sameValue(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function identityEvidenceScore(field) {
  const candidates = field?.identityEvidence?.candidates || [];
  const selected = field?.identityEvidence?.selected;
  const selectedValue = typeof selected === "string" ? selected : selected?.normalizedCandidate || selected?.value;
  const selectedCandidate = candidates.find((candidate) => candidate.normalizedCandidate === selectedValue || candidate.value === selectedValue);
  return Number(selectedCandidate?.evidenceScore || field?.identityEvidence?.evidenceScore || field?.evidence?.evidenceScore || 0);
}

function fieldEvidence(field) {
  return field?.identityEvidence ? { identityEvidence: field.identityEvidence, resolverReason: field.resolverReason || field.identityEvidence.resolverReason || "" } : {};
}

function providerLabel(source) {
  return {
    paddleocr: "PaddleOCR",
    easyocr: "EasyOCR",
    tesseract: "Tesseract",
    macos_vision: "macOS Vision",
    google_vision: "Google Vision",
    openai_vision: "OpenAI Vision",
    "line-amount-sum": "line amount sum",
    formula: "formula"
  }[source] || source;
}

function chooseField(candidates, fieldName) {
  const fields = candidates.map((candidate) => candidate?.[fieldName]).filter(Boolean);
  const valid = fields.filter((field) => ["auto", "low_confidence"].includes(field.status));
  if (!valid.length) return fields[0] || makeField(null, { reason: "需人工確認" });
  const [strongest, ...rest] = [...valid].sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  const conflict = rest.find((field) => !sameValue(strongest.value, field.value));
  if (conflict) {
    const confidenceGap = Number(strongest.confidence || 0) - Number(conflict.confidence || 0);
    const evidenceWinner = [...valid].sort((a, b) => identityEvidenceScore(b) - identityEvidenceScore(a))[0];
    const evidenceGap = identityEvidenceScore(evidenceWinner) - identityEvidenceScore(conflict);
    if (confidenceGap >= 0.2 && strongest.value != null) {
      return { ...strongest, ...fieldEvidence(strongest), reason: `已選用較高信心 ${providerLabel(strongest.source)} 結果` };
    }
    if (evidenceWinner?.value != null && identityEvidenceScore(evidenceWinner) >= 0.70 && evidenceGap >= 0.18) {
      return { ...evidenceWinner, ...fieldEvidence(evidenceWinner), reason: `已選用較強 identity evidence：${providerLabel(evidenceWinner.source)}` };
    }
    return makeField(null, {
      rawText: valid.map((field) => `${providerLabel(field.source)}:${field.rawText || field.value}`).join(" / "),
      source: strongest.source,
      confidence: Math.min(strongest.confidence, conflict.confidence),
      status: "low_confidence",
      reason: "不同 Provider 結果不一致",
      identityEvidence: {
        candidates: valid.flatMap((field) => field.identityEvidence?.candidates || []),
        selected: null,
        resolverReason: "close-confidence identity conflict retained for review"
      },
      resolverReason: "close-confidence identity conflict retained for review"
    });
  }
  const agreeing = valid.length;
  return { ...strongest, ...fieldEvidence(strongest), confidence: Math.min(1, strongest.confidence + (agreeing > 1 ? 0.08 : 0)) };
}

function itemValue(item, name) {
  const value = item?.[name];
  return value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value") ? value.value : value;
}

function itemsSignature(items = []) {
  return items.map((item) => `${itemValue(item, "quantity") ?? ""}x${itemValue(item, "unitPrice") ?? ""}=${itemValue(item, "lineAmount") ?? itemValue(item, "amount") ?? ""}`).join("|");
}

function itemCenterY(item) {
  const box = item?.rowBbox || item?.rowBox;
  if (!box) return null;
  const y1 = Number(box.y1 ?? box.top ?? 0);
  const y2 = Number(box.y2 ?? ((box.top ?? 0) + (box.height ?? 0)));
  return (y1 + y2) / 2;
}

function mergeItemSets(baseItems, supplementItems) {
  const merged = baseItems.map((item) => ({ ...item }));
  for (const supplement of supplementItems) {
    const supplementY = itemCenterY(supplement);
    let targetIndex = Number(supplement.lineNo || 0) - 1;
    if (targetIndex < 0 || targetIndex >= merged.length) targetIndex = -1;
    if (targetIndex < 0 && supplementY != null) {
      const ranked = merged.map((item, index) => ({ index, distance: Math.abs((itemCenterY(item) ?? supplementY) - supplementY) })).sort((a, b) => a.distance - b.distance)[0];
      if (ranked && ranked.distance <= 70) targetIndex = ranked.index;
    }
    if (targetIndex < 0) {
      if (supplement.quantity?.value != null || supplement.unitPrice?.value != null || supplement.lineAmount?.value != null || supplement.amount?.value != null) merged.push({ ...supplement });
      continue;
    }
    const target = merged[targetIndex];
    for (const fieldName of ["quantity", "unitPrice"]) {
      const incoming = supplement[fieldName];
      const existing = target[fieldName];
      const shouldUse = incoming?.value != null && (!existing?.value || existing.status === "manual_required" || (existing.status === "low_confidence" && incoming.status === "auto"));
      if (shouldUse) {
        target[fieldName] = incoming;
        const evidenceKey = `${fieldName}Evidence`;
        if (supplement[evidenceKey]) target[evidenceKey] = supplement[evidenceKey];
      }
    }
    for (const fieldName of ["lineAmount", "amount"]) {
      const incoming = supplement[fieldName];
      const existing = target[fieldName];
      if (incoming?.value != null && (!existing?.value || existing.source === "formula")) target[fieldName] = incoming;
    }
    target.evidence = { ...(target.evidence || {}), ...(supplement.evidence || {}) };
    target.cells = { ...(target.cells || {}), ...(supplement.cells || {}) };
  }
  return merged;
}

function chooseItems(candidates, warnings) {
  const validSets = candidates
    .map((candidate) => (candidate.items || []).filter((item) => item.quantity?.value != null || item.unitPrice?.value != null || item.lineAmount?.value != null || item.amount?.value != null))
    .filter((items) => items.length);
  if (!validSets.length) return candidates.find((candidate) => candidate.items?.length)?.items || [];
  let merged = [];
  for (const items of validSets) merged = mergeItemSets(merged, items);
  const signatures = validSets.map(itemsSignature);
  if (new Set(signatures).size > 1 && validSets.some((items) => items.some((item) => item.quantity?.value != null && item.unitPrice?.value != null))) warnings.push("不同 Provider 的金融列資料存在部分差異，已保留欄位級證據");
  return merged;
}

function chooseMonetaryField(candidates, fieldName, fallback) {
  const fields = candidates.map((candidate) => candidate?.[fieldName]).filter((field) => field && field.value != null && !["manual_required", "invalid"].includes(field.status));
  if (!fields.length) return fallback;
  const observed = fields.filter((field) => !["formula", "line-amount-sum"].includes(field.source));
  const pool = observed.length ? observed : fields;
  const values = [...new Set(pool.map((field) => numericValue(field.value)).filter((value) => value != null))];
  if (values.length > 1) {
    return makeField(null, {
      source: pool[0].source,
      rawText: pool.map((field) => field.rawText || field.value).join(" / "),
      confidence: Math.min(...pool.map((field) => field.confidence || 0)),
      status: "manual_required",
      severity: "invalid",
      reason: `conflicting ${fieldName} monetary candidates`
    });
  }
  return [...pool].sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0];
}

function calculateLegacyFormulaFields(items) {
  const validItems = items.filter((item) => item.quantity?.status === "auto" && item.unitPrice?.status === "auto");
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

function calculateFinancialFields(items, candidates, financialScope) {
  const legacy = calculateLegacyFormulaFields(items);
  if (!financialScope) return legacy;
  const lineAmountFields = items.map((item) => item.lineAmount || item.amount).filter((field) => field?.value != null);
  const lineSum = lineAmountFields.length
    ? makeField(lineAmountFields.reduce((sum, item) => sum + Number(item.value), 0), {
      source: "line-amount-sum",
      confidence: Math.min(...lineAmountFields.map((item) => item.confidence || 0)),
      status: lineAmountFields.every((item) => item.status === "auto") ? "auto" : "low_confidence",
      reason: "sum of observed line amounts"
    })
    : legacy.amount;
  return {
    amount: chooseMonetaryField(candidates, "amount", lineSum),
    tax: chooseMonetaryField(candidates, "tax", makeField(null, { source: "paddleocr", confidence: 0, status: "manual_required", reason: "沒有可取得的稅額" })),
    total: chooseMonetaryField(candidates, "total", makeField(null, { source: "paddleocr", confidence: 0, status: "manual_required", reason: "沒有可取得的總額" }))
  };
}

export function validateProviderCandidate(fields, { source, defaultConfidence = 0.8, warnings = [] } = {}) {
  const recognition = validateInvoiceRecognition({ ...(fields || {}), warnings }, { source, defaultConfidence });
  return recognition;
}

export function mergeInvoiceRecognitionResults({ candidates = [], mode = "local", providerEvents = [] } = {}) {
  const warnings = providerEvents.map((event) => event.error).filter(Boolean);
  const validCandidates = candidates.filter(Boolean);
  const baseCandidates = validCandidates.length ? validCandidates : [validateInvoiceRecognition({}, { source: "manual", defaultConfidence: 0 })];
  const financialScope = baseCandidates.some((candidate) => candidate.financialScope);
  const initialItems = chooseItems(baseCandidates, warnings);
  const printedSummary = financialScope ? {
    salesAmount: chooseMonetaryField(baseCandidates, "amount", null),
    taxAmount: chooseMonetaryField(baseCandidates, "tax", null),
    totalAmount: chooseMonetaryField(baseCandidates, "total", null)
  } : {};
  const deterministic = financialScope ? calculateDeterministicFinancials({ items: initialItems, printedSummary }) : null;
  const items = deterministic ? deterministic.items : initialItems;
  const formula = deterministic
    ? { amount: deterministic.salesAmount, tax: deterministic.taxAmount, total: deterministic.totalAmount }
    : calculateFinancialFields(items, baseCandidates, financialScope);
  const result = {
    invoiceNo: chooseField(baseCandidates, "invoiceNo"),
    ...(financialScope ? { sellerTaxId: chooseField(baseCandidates, "sellerTaxId") } : { sellerTaxId: makeField(null, { source: "manual", confidence: 0, status: "manual_required", reason: "financial scope未啟用" }) }),
    buyerTaxId: chooseField(baseCandidates, "buyerTaxId"),
    taxId: chooseField(baseCandidates, "buyerTaxId"),
    items,
    ...formula,
    financialScope,
    overallStatus: "needs_review",
    warnings: [...new Set([...warnings, ...baseCandidates.flatMap((candidate) => candidate.warnings || [])].filter(Boolean))],
    debug: { mode, providers: providerEvents, candidates: baseCandidates }
  };
  const financial = buildFinancialCore({
    sellerTaxId: result.sellerTaxId,
    buyerTaxId: result.buyerTaxId,
    items: result.items,
    salesAmount: result.amount,
    taxAmount: result.tax,
    totalAmount: result.total,
    optionalEvidenceAvailable: result.items.every((item) => item.quantity?.value != null && item.unitPrice?.value != null && item.itemName),
    confidence: Math.min(result.sellerTaxId.confidence || 0, result.amount.confidence || 0, result.total.confidence || 0),
    calculation: deterministic
  });
  result.financial = deterministic
    ? { ...financial, calculation: { taxRate: deterministic.taxRate, taxRounding: deterministic.taxRounding, taxPolicyConfirmed: deterministic.taxPolicyConfirmed, secondaryVerification: deterministic.secondaryVerification, secondarySummaryVerification: deterministic.secondarySummaryVerification } }
    : financial;
  result.financialStatus = financial.status;
  result.warnings = [...new Set([...result.warnings, ...(financial.reconciliation?.warnings || [])])];

  const allFields = [
    result.invoiceNo,
    result.buyerTaxId,
    result.amount,
    result.tax,
    result.total,
    ...(result.items || []).flatMap((item) => [item.quantity, item.unitPrice, item.amount || item.lineAmount])
  ];
  result.overallStatus = allFields.some((field) => field?.status !== "auto") ? "needs_review" : "auto";
  const meta = recognitionToRecordMeta(result);
  result.reviewStatus = financialScope
    ? result.financialStatus
    : deriveReviewStatus({ validationErrors: meta.validationErrors, fieldStatuses: meta.fieldStatuses, warnings: result.warnings });
  meta.reviewStatus = result.reviewStatus;
  meta.financialStatus = result.financialStatus;

  return { recognitionResult: result, flatFields: recognitionToFlatFields(result), meta };
}
