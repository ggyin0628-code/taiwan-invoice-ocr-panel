import { buildFinancialCore, numericValue } from "./financialCore.js";
import { deriveReviewStatus } from "./invoiceStatus.js";

const FIELD_LABELS = {
  invoiceNo: "發票號碼",
  buyerTaxId: "買受人統一編號",
  sellerTaxId: "賣方統一編號",
  quantity: "數量",
  unitPrice: "單價",
  amount: "金額",
  tax: "稅金",
  total: "總金額"
};

export function normalizeSource(source) {
  return ["paddleocr", "hybrid", "ollama", "easyocr", "tesseract", "macos_vision", "google_vision", "openai_vision", "formula", "line-amount-sum", "manual"].includes(source) ? source : "tesseract";
}

function confidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return number > 1 ? Math.max(0, Math.min(1, number / 100)) : Math.max(0, Math.min(1, number));
}

function digits(value) {
  return String(value ?? "").replace(/[^\d]/g, "");
}

function invoiceNo(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function integerOrNull(value) {
  const numeric = digits(value);
  if (!numeric) return null;
  const number = Number(numeric);
  return Number.isSafeInteger(number) ? number : null;
}

function monetaryOrNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const normalized = String(value).replace(/,/g, "").replace(/[^\d.-]/g, "");
  if (!normalized || !/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function rawValue(value) {
  return value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value") ? value.value : value;
}

function rawConfidence(value, fallback) {
  return value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "confidence") ? value.confidence : fallback;
}

function rawSource(value, fallback) {
  return value && typeof value === "object" && value.source ? value.source : fallback;
}

export function makeField(value, { rawText = value, source = "tesseract", confidence: score = 0, status = "manual_required", reason = "", severity = "", identityEvidence = null, resolverReason = "", evidence = null } = {}) {
  return {
    value: value ?? null,
    rawText: rawText == null ? "" : String(rawText),
    source: normalizeSource(source),
    confidence: confidence(score),
    status,
    reason,
    ...(severity ? { severity } : {}),
    ...(identityEvidence ? { identityEvidence } : {}),
    ...(resolverReason ? { resolverReason } : {}),
    ...(evidence ? { evidence } : {})
  };
}

function invalidField(rawText, source, score, reason) {
  return makeField(null, { rawText, source, confidence: score, status: "manual_required", reason, severity: "invalid" });
}

function lowConfidenceField(value, rawText, source, score, reason) {
  return makeField(value, { rawText, source, confidence: score, status: "low_confidence", reason });
}

function validateInvoiceNo(value, source, score) {
  const normalized = invoiceNo(value);
  if (!normalized) return invalidField(value, source, score, `${FIELD_LABELS.invoiceNo}需人工確認`);
  if (!/^[A-Z]{2}[0-9]{8}$/.test(normalized)) return invalidField(value, source, score, "發票號碼格式不符");
  if (confidence(score) < 0.6) return lowConfidenceField(normalized, value, source, score, "發票號碼信心不足");
  return makeField(normalized, { rawText: value, source, confidence: score, status: "auto" });
}

function validateTaxId(value, source, score, label) {
  const normalized = digits(value);
  if (!normalized) return invalidField(value, source, score, `${label}需人工確認`);
  if (!/^\d{8}$/.test(normalized)) return invalidField(value, source, score, `${label}必須是 8 碼數字`);
  if (confidence(score) < 0.8) return lowConfidenceField(normalized, value, source, score, `${label}信心不足`);
  return makeField(normalized, { rawText: value, source, confidence: score, status: "auto" });
}

function validatePositiveInteger(value, source, score, label) {
  const number = integerOrNull(value);
  if (!number || number <= 0) return invalidField(value, source, score, `${label}必須是正整數`);
  if (confidence(score) < 0.6) return lowConfidenceField(number, value, source, score, `${label}信心不足`);
  return makeField(number, { rawText: value, source, confidence: score, status: "auto" });
}

function validateMoney(value, source, score, label, evidence = null) {
  const number = monetaryOrNull(value);
  if (number == null) return invalidField(value, source, score, `${label}必須是非負整數金額`);
  if (confidence(score) < 0.6) return makeField(number, { rawText: value, source, confidence: score, status: "low_confidence", reason: `${label}信心不足`, evidence });
  return makeField(number, { rawText: value, source, confidence: score, status: "auto", evidence });
}

function extractItems(input = {}) {
  if (Array.isArray(input.items) && input.items.length) return input.items;
  const lineAmounts = input.financial?.lineAmounts ?? input.lineAmounts;
  if (Array.isArray(lineAmounts) && lineAmounts.length) return lineAmounts.map((lineAmount, index) => ({ lineNo: index + 1, lineAmount }));
  const quantities = String(input.quantity ?? "").split(/[,\s/]+/).filter(Boolean);
  const unitPrices = String(input.unitPrice ?? input.unit_price ?? "").split(/[,\s/]+/).filter(Boolean);
  const length = Math.max(quantities.length, unitPrices.length);
  return Array.from({ length }, (_, index) => ({
    quantity: quantities[index] ?? null,
    unitPrice: unitPrices[index] ?? null
  }));
}

function aggregateStatus(fields) {
  if (!fields.length) return "manual_required";
  if (fields.some((field) => field.status === "manual_required")) return "manual_required";
  if (fields.some((field) => field.status === "low_confidence")) return "low_confidence";
  return "auto";
}

function itemFieldStatuses(items) {
  return {
    quantity: aggregateStatus(items.map((item) => item.quantity)),
    unitPrice: aggregateStatus(items.map((item) => item.unitPrice))
  };
}

function fieldInput(input, financialInput, primary, aliases = []) {
  for (const key of [primary, ...aliases]) {
    if (Object.prototype.hasOwnProperty.call(financialInput, key)) return financialInput[key];
    if (Object.prototype.hasOwnProperty.call(input, key)) return input[key];
  }
  return undefined;
}

function hasExplicitFinancialScope(input = {}) {
  return Object.prototype.hasOwnProperty.call(input, "sellerTaxId")
    || Object.prototype.hasOwnProperty.call(input, "financial")
    || Object.prototype.hasOwnProperty.call(input, "lineAmounts")
    || Object.prototype.hasOwnProperty.call(input, "salesAmount")
    || Object.prototype.hasOwnProperty.call(input, "taxAmount")
    || Object.prototype.hasOwnProperty.call(input, "totalAmount")
    || (Array.isArray(input.items) && input.items.some((item) => item && (Object.prototype.hasOwnProperty.call(item, "lineAmount") || Object.prototype.hasOwnProperty.call(item, "amountEvidence"))));
}

export function validateInvoiceRecognition(input = {}, { source = "tesseract", defaultConfidence = 0 } = {}) {
  const financialInput = input.financial && typeof input.financial === "object" ? input.financial : {};
  const inputConfidence = input.confidence;
  const score = typeof inputConfidence === "object" ? confidence(defaultConfidence) : confidence(inputConfidence ?? defaultConfidence);
  const warnings = Array.isArray(input.warnings) ? input.warnings.map(String) : [];
  const financialScope = hasExplicitFinancialScope(input);
  const sellerInput = input.sellerTaxId ?? financialInput.sellerTaxId;
  const buyerInput = input.buyerTaxId ?? input.taxId ?? input.tax_id ?? financialInput.buyerTaxId;
  const sellerField = validateTaxId(rawValue(sellerInput), rawSource(sellerInput, source), rawConfidence(sellerInput, input.confidence?.sellerTaxId ?? score), FIELD_LABELS.sellerTaxId);
  const buyerField = validateTaxId(rawValue(buyerInput), rawSource(buyerInput, source), rawConfidence(buyerInput, input.confidence?.buyerTaxId ?? input.confidence?.taxId ?? score), FIELD_LABELS.buyerTaxId);
  const result = {
    invoiceNo: validateInvoiceNo(input.invoiceNo ?? input.invoiceNumber ?? input.invoice_number, source, input.confidence?.invoiceNo ?? input.confidence?.invoiceNumber ?? score),
    sellerTaxId: sellerField,
    buyerTaxId: buyerField,
    items: [],
    amount: makeField(null, { source: "formula", confidence: 0, status: "manual_required", reason: "沒有可成立的金額" }),
    tax: makeField(null, { source: "formula", confidence: 0, status: "manual_required", reason: "沒有可取得的稅額" }),
    total: makeField(null, { source: "formula", confidence: 0, status: "manual_required", reason: "沒有可取得的總額" }),
    financialScope,
    overallStatus: "needs_review",
    reviewStatus: "REVIEW_REQUIRED",
    warnings,
    debug: {}
  };
  result.taxId = result.buyerTaxId;

  if (input.identityEvidence?.invoiceNumber) {
    result.invoiceNo.identityEvidence = input.identityEvidence.invoiceNumber;
    result.invoiceNo.resolverReason = input.identityEvidence.invoiceNumber.resolverReason || result.invoiceNo.reason;
  }
  if (input.identityEvidence?.taxId || input.identityEvidence?.buyerTaxId) {
    result.buyerTaxId.identityEvidence = input.identityEvidence.taxId || input.identityEvidence.buyerTaxId;
    result.buyerTaxId.resolverReason = result.buyerTaxId.identityEvidence.resolverReason || result.buyerTaxId.reason;
  }
  if (input.identityEvidence?.sellerTaxId) {
    result.sellerTaxId.identityEvidence = input.identityEvidence.sellerTaxId;
    result.sellerTaxId.resolverReason = input.identityEvidence.sellerTaxId.resolverReason || result.sellerTaxId.reason;
  }

  const rawItems = extractItems(input);
  result.items = rawItems.map((item, index) => {
    const itemSource = item?.source || source;
    const itemConfidence = item?.confidence && typeof item.confidence === "object" ? item.confidence : {};
    const quantity = item?.quantity == null ? makeField(null, { source: itemSource, confidence: 0, status: "manual_required", reason: "數量未提供" }) : validatePositiveInteger(item.quantity, itemSource, itemConfidence.quantity ?? score, FIELD_LABELS.quantity);
    const unitPriceValue = item?.unitPrice ?? item?.unit_price;
    const unitPrice = unitPriceValue == null ? makeField(null, { source: itemSource, confidence: 0, status: "manual_required", reason: "單價未提供" }) : validatePositiveInteger(unitPriceValue, itemSource, itemConfidence.unitPrice ?? itemConfidence.unit_price ?? score, FIELD_LABELS.unitPrice);
    const rawLineAmount = financialScope
      ? item?.lineAmount ?? item?.amount?.value ?? (item?.lineAmountEvidence || item?.amountEvidence || item?.evidence?.amount ? item?.amount : null)
      : item?.lineAmount ?? item?.amount?.value ?? item?.amount ?? item?.salesAmount;
    const hasObservedLineAmount = rawLineAmount != null && String(rawLineAmount).trim() !== "";
    const observedConfidence = item?.lineAmountEvidence?.confidence ?? item?.amountEvidence?.confidence ?? itemConfidence.lineAmount ?? itemConfidence.amount ?? score;
    const amount = hasObservedLineAmount
      ? validateMoney(rawValue(rawLineAmount), rawSource(rawLineAmount, itemSource), rawConfidence(rawLineAmount, observedConfidence), FIELD_LABELS.amount, item?.lineAmountEvidence || item?.amountEvidence || item?.evidence?.amount || null)
      : quantity.value != null && unitPrice.value != null
        ? makeField(quantity.value * unitPrice.value, { source: "formula", confidence: Math.min(quantity.confidence, unitPrice.confidence), status: quantity.status === "auto" && unitPrice.status === "auto" ? "auto" : "low_confidence", reason: "數量 × 單價計算出的 optional amount" })
        : makeField(null, { source: "formula", confidence: 0, status: "manual_required", reason: "line amount與數量/單價均未足以成立" });
    return {
      lineNo: Number(item?.lineNo || index + 1),
      rowId: item?.rowId || null,
      rowBbox: item?.rowBbox || item?.rowBox || null,
      rowType: item?.rowType || (item?.itemName || item?.name ? "named" : "numeric_only"),
      name: String(item?.name ?? item?.itemName ?? "").slice(0, 80),
      itemName: String(item?.itemName ?? item?.name ?? "").slice(0, 80),
      nameEvidence: item?.nameEvidence || null,
      cells: item?.cells || null,
      evidence: item?.evidence || null,
      quantityEvidence: item?.quantityEvidence || item?.evidence?.quantity || null,
      unitPriceEvidence: item?.unitPriceEvidence || item?.evidence?.unitPrice || null,
      lineAmountEvidence: item?.lineAmountEvidence || item?.amountEvidence || item?.evidence?.amount || null,
      amountReference: item?.amountReference || null,
      source: itemSource,
      quantity,
      unitPrice,
      lineAmount: amount,
      amount
    };
  });

  const lineAmountFields = result.items.map((item) => item.lineAmount).filter((item) => item.value != null && (item.source !== "formula" || !financialScope));
  const explicitSales = fieldInput(input, financialInput, "salesAmount", ["subtotal"]);
  const explicitTax = fieldInput(input, financialInput, "taxAmount", ["tax"]);
  const explicitTotal = fieldInput(input, financialInput, "totalAmount", ["total"]);
  const hasExplicitSales = explicitSales !== undefined && rawValue(explicitSales) != null && String(rawValue(explicitSales)).trim() !== "";
  const hasExplicitTax = explicitTax !== undefined && rawValue(explicitTax) != null && String(rawValue(explicitTax)).trim() !== "";
  const hasExplicitTotal = explicitTotal !== undefined && rawValue(explicitTotal) != null && String(rawValue(explicitTotal)).trim() !== "";

  if (hasExplicitSales) {
    result.amount = validateMoney(rawValue(explicitSales), rawSource(explicitSales, source), rawConfidence(explicitSales, input.confidence?.salesAmount ?? score), "銷售額", financialInput.salesAmount?.evidence || null);
  } else if (lineAmountFields.length) {
    const value = lineAmountFields.reduce((sum, item) => sum + Number(item.value), 0);
    result.amount = makeField(value, { source: "line-amount-sum", confidence: Math.min(...lineAmountFields.map((item) => item.confidence)), status: lineAmountFields.every((item) => item.status === "auto") ? "auto" : "low_confidence", reason: "sum of observed line amounts" });
  } else {
    const formulaItems = result.items.filter((item) => item.quantity.status === "auto" && item.unitPrice.status === "auto");
    if (formulaItems.length) {
      const value = formulaItems.reduce((sum, item) => sum + Number(item.quantity.value) * Number(item.unitPrice.value), 0);
      result.amount = makeField(value, { source: "formula", confidence: Math.min(...formulaItems.flatMap((item) => [item.quantity.confidence, item.unitPrice.confidence])), status: "auto", reason: "legacy quantity × unit price calculation" });
    }
  }
  if (hasExplicitTax) {
    result.tax = validateMoney(rawValue(explicitTax), rawSource(explicitTax, source), rawConfidence(explicitTax, input.confidence?.taxAmount ?? score), FIELD_LABELS.tax, financialInput.taxAmount?.evidence || null);
  } else if (!financialScope && result.amount.value != null) {
    const taxValue = Math.round(Number(result.amount.value) * 0.05);
    result.tax = makeField(taxValue, { source: "formula", confidence: result.amount.confidence, status: result.amount.status, reason: "legacy 5% formula compatibility; not authoritative" });
  }
  if (hasExplicitTotal) {
    result.total = validateMoney(rawValue(explicitTotal), rawSource(explicitTotal, source), rawConfidence(explicitTotal, input.confidence?.totalAmount ?? score), FIELD_LABELS.total, financialInput.totalAmount?.evidence || null);
  } else if (!financialScope && result.amount.value != null && result.tax.value != null) {
    result.total = makeField(Number(result.amount.value) + Number(result.tax.value), { source: "formula", confidence: Math.min(result.amount.confidence, result.tax.confidence), status: result.amount.status === "auto" && result.tax.status === "auto" ? "auto" : "low_confidence", reason: "legacy sales + tax formula compatibility" });
  }

  const financial = buildFinancialCore({
    sellerTaxId: result.sellerTaxId,
    buyerTaxId: result.buyerTaxId,
    items: result.items,
    salesAmount: result.amount,
    taxAmount: result.tax,
    totalAmount: result.total,
    optionalEvidenceAvailable: result.items.every((item) => item.quantity.value != null && item.unitPrice.value != null && item.itemName),
    confidence: Math.min(result.sellerTaxId.confidence, result.amount.confidence, result.total.confidence)
  });
  result.financial = financial;
  result.financialStatus = financial.status;
  if (financial.warnings?.length) result.warnings.push(...financial.reconciliation.warnings);

  const itemStatuses = itemFieldStatuses(result.items);
  const fieldStatuses = {
    invoiceNumber: result.invoiceNo.status,
    taxId: result.buyerTaxId.status,
    ...itemStatuses,
    salesAmount: result.amount.status,
    taxAmount: result.tax.status,
    totalAmount: result.total.status
  };
  const legacyRequiredFields = [
    result.invoiceNo,
    result.buyerTaxId,
    result.amount,
    result.tax,
    result.total,
    ...result.items.flatMap((item) => [item.quantity, item.unitPrice, item.amount])
  ].filter((field) => field.status === "manual_required" || field.severity === "invalid");

  result.reviewStatus = financialScope
    ? financial.status
    : deriveReviewStatus({ validationErrors: legacyRequiredFields, fieldStatuses, warnings: result.warnings });
  result.overallStatus = result.reviewStatus === "AUTO_OK" ? "auto" : "needs_review";
  return result;
}

export function recognitionToFlatFields(result) {
  const quantities = (result.items || []).map((item) => item.quantity.value).filter((value) => value != null);
  const unitPrices = (result.items || []).map((item) => item.unitPrice.value).filter((value) => value != null);
  const items = (result.items || [])
    .map((item, index) => ({
      lineNo: item.lineNo || index + 1,
      rowId: item.rowId || null,
      rowBbox: item.rowBbox || null,
      rowType: item.rowType || (item.name ? "named" : "numeric_only"),
      itemName: item.itemName || item.name || "",
      quantity: item.quantity.value ?? null,
      unitPrice: item.unitPrice.value ?? null,
      lineAmount: item.lineAmount?.value ?? item.amount?.value ?? null,
      amount: item.amount?.value ?? item.lineAmount?.value ?? null,
      amountReference: item.amountReference || null,
      nameEvidence: item.nameEvidence || null,
      quantityEvidence: item.quantityEvidence || null,
      unitPriceEvidence: item.unitPriceEvidence || null,
      lineAmountEvidence: item.lineAmountEvidence || null,
      evidence: item.evidence || null,
      cells: item.cells || null,
      source: item.source || item.quantity.source || item.unitPrice.source || "tesseract",
      status: [item.quantity.status, item.unitPrice.status, item.amount.status].includes("manual_required") && item.amount.status === "manual_required"
        ? "manual_required"
        : [item.quantity.status, item.unitPrice.status, item.amount.status].includes("low_confidence")
          ? "low_confidence"
          : "auto",
      confidence: item.amount?.confidence ?? Math.min(item.quantity.confidence || 0, item.unitPrice.confidence || 0)
    }))
    .filter((item) => item.quantity != null || item.unitPrice != null || item.amount != null);
  return {
    invoiceNumber: result.invoiceNo.value ? String(result.invoiceNo.value) : "",
    sellerTaxId: result.sellerTaxId?.value ? String(result.sellerTaxId.value) : "",
    buyerTaxId: result.buyerTaxId.value ? String(result.buyerTaxId.value) : "",
    taxId: result.buyerTaxId.value ? String(result.buyerTaxId.value) : "",
    items,
    quantity: quantities.length ? quantities.join(",") : "",
    unitPrice: unitPrices.length ? unitPrices.join(",") : "",
    salesAmount: result.amount.value != null ? String(result.amount.value) : "",
    taxAmount: result.tax.value != null ? String(result.tax.value) : "",
    totalAmount: result.total.value != null ? String(result.total.value) : "",
    financial: result.financial || null,
    financialStatus: result.financialStatus || null
  };
}

function aggregateFields(fields = []) {
  const validFields = fields.filter(Boolean);
  if (!validFields.length) return makeField(null);
  const status = aggregateStatus(validFields);
  const confidenceValues = validFields.map((field) => field.confidence).filter((value) => Number.isFinite(Number(value)));
  const confidenceValue = confidenceValues.length ? Math.min(...confidenceValues) : 0;
  const first = validFields[0];
  return {
    ...first,
    status,
    confidence: confidenceValue,
    reason: status === "auto" ? first.reason : validFields.find((field) => field.status !== "auto")?.reason || first.reason
  };
}

function fieldNameFor(field, result) {
  if (field === result.invoiceNo) return "invoiceNumber";
  if (field === result.sellerTaxId) return "sellerTaxId";
  if (field === result.buyerTaxId) return "taxId";
  if (field === result.amount) return "salesAmount";
  if (field === result.tax) return "taxAmount";
  if (field === result.total) return "totalAmount";
  for (const item of result.items || []) {
    if (field === item.quantity) return "quantity";
    if (field === item.unitPrice) return "unitPrice";
    if (field === item.lineAmount || field === item.amount) return "lineAmount";
  }
  return "recognition";
}

export function recognitionToRecordMeta(result) {
  const quantityField = aggregateFields((result.items || []).map((item) => item.quantity));
  const unitPriceField = aggregateFields((result.items || []).map((item) => item.unitPrice));
  const fieldStatuses = {
    invoiceNumber: result.invoiceNo.status,
    sellerTaxId: result.sellerTaxId?.status || "manual_required",
    taxId: result.buyerTaxId.status,
    quantity: quantityField.status,
    unitPrice: unitPriceField.status,
    salesAmount: result.amount.status,
    taxAmount: result.tax.status,
    totalAmount: result.total.status,
    financialStatus: result.financialStatus || "REVIEW_REQUIRED"
  };
  const fields = [
    result.invoiceNo,
    ...(result.financialScope ? [result.sellerTaxId] : []),
    result.buyerTaxId,
    ...result.items.flatMap((item) => [item.quantity, item.unitPrice, item.amount]),
    result.amount,
    result.tax,
    result.total
  ];
  return {
    fieldSources: {
      invoiceNumber: result.invoiceNo.source,
      sellerTaxId: result.sellerTaxId?.source || "tesseract",
      taxId: result.buyerTaxId.source,
      quantity: quantityField.source,
      unitPrice: unitPriceField.source,
      salesAmount: result.amount.source,
      taxAmount: result.tax.source,
      totalAmount: result.total.source
    },
    fieldStatuses,
    confidence: {
      invoiceNumber: result.invoiceNo.confidence,
      sellerTaxId: result.sellerTaxId?.confidence || 0,
      taxId: result.buyerTaxId.confidence,
      quantity: quantityField.confidence,
      unitPrice: unitPriceField.confidence,
      salesAmount: result.amount.confidence,
      taxAmount: result.tax.confidence,
      totalAmount: result.total.confidence
    },
    reviewStatus: result.reviewStatus,
    financialStatus: result.financialStatus,
    validationErrors: fields
      .filter((field) => field.status === "manual_required" || field.severity === "invalid")
      .map((field) => ({
        field: fieldNameFor(field, result),
        reason: field.reason || "需人工確認",
        status: field.status,
        severity: field.severity || "required",
        source: field.source
      }))
  };
}

export { numericValue };
