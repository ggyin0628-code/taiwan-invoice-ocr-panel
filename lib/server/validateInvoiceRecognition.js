const FIELD_LABELS = {
  invoiceNo: "發票號碼",
  buyerTaxId: "統一編號",
  quantity: "數量",
  unitPrice: "單價",
  amount: "金額",
  tax: "稅金",
  total: "總金額"
};

export function normalizeSource(source) {
  return ["paddleocr", "hybrid", "ollama", "easyocr", "tesseract", "macos_vision", "google_vision", "openai_vision", "formula", "manual"].includes(source) ? source : "tesseract";
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

export function makeField(value, { rawText = value, source = "tesseract", confidence: score = 0, status = "manual_required", reason = "" } = {}) {
  return {
    value: value ?? null,
    rawText: rawText == null ? "" : String(rawText),
    source: normalizeSource(source),
    confidence: confidence(score),
    status,
    reason
  };
}

function invalidField(rawText, source, score, reason) {
  return makeField(null, { rawText, source, confidence: score, status: "manual_required", reason });
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

function validateTaxId(value, source, score) {
  const normalized = digits(value);
  if (!normalized) return invalidField(value, source, score, `${FIELD_LABELS.buyerTaxId}需人工確認`);
  if (!/^[0-9]{8}$/.test(normalized)) return invalidField(value, source, score, "統一編號必須是 8 碼數字");
  if (confidence(score) < 0.8) return lowConfidenceField(normalized, value, source, score, "統一編號信心不足");
  return makeField(normalized, { rawText: value, source, confidence: score, status: "auto" });
}

function validatePositiveInteger(value, source, score, label) {
  const number = integerOrNull(value);
  if (!number || number <= 0) return invalidField(value, source, score, `${label}必須是正整數`);
  if (confidence(score) < 0.6) return lowConfidenceField(number, value, source, score, `${label}信心不足`);
  return makeField(number, { rawText: value, source, confidence: score, status: "auto" });
}

function extractItems(input = {}) {
  if (Array.isArray(input.items)) return input.items;
  const quantities = String(input.quantity ?? "").split(/[,\s/]+/).filter(Boolean);
  const unitPrices = String(input.unitPrice ?? input.unit_price ?? "").split(/[,\s/]+/).filter(Boolean);
  const length = Math.max(quantities.length, unitPrices.length);
  return Array.from({ length }, (_, index) => ({
    quantity: quantities[index] ?? null,
    unitPrice: unitPrices[index] ?? null
  }));
}

export function validateInvoiceRecognition(input = {}, { source = "tesseract", defaultConfidence = 0 } = {}) {
  const score = confidence(input.confidence ?? defaultConfidence);
  const warnings = Array.isArray(input.warnings) ? input.warnings.map(String) : [];
  const result = {
    invoiceNo: validateInvoiceNo(input.invoiceNo ?? input.invoiceNumber ?? input.invoice_number, source, input.confidence?.invoiceNo ?? input.confidence?.invoiceNumber ?? score),
    buyerTaxId: validateTaxId(input.buyerTaxId ?? input.taxId ?? input.tax_id, source, input.confidence?.buyerTaxId ?? input.confidence?.taxId ?? score),
    items: [],
    amount: makeField(null, { source: "formula", confidence: 0, status: "manual_required", reason: "沒有可計算的品項" }),
    tax: makeField(null, { source: "formula", confidence: 0, status: "manual_required", reason: "沒有可計算的金額" }),
    total: makeField(null, { source: "formula", confidence: 0, status: "manual_required", reason: "沒有可計算的金額" }),
    overallStatus: "needs_review",
    warnings,
    debug: {}
  };

  const rawItems = extractItems(input);
  result.items = rawItems.map((item) => {
    const quantity = validatePositiveInteger(item?.quantity, source, item?.confidence?.quantity ?? score, FIELD_LABELS.quantity);
    const unitPrice = validatePositiveInteger(item?.unitPrice ?? item?.unit_price, source, item?.confidence?.unitPrice ?? item?.confidence?.unit_price ?? score, FIELD_LABELS.unitPrice);
    const hasValues = quantity.value != null && unitPrice.value != null;
    const canAutoCalculate = quantity.status === "auto" && unitPrice.status === "auto";
    return {
      name: String(item?.name ?? item?.itemName ?? "").slice(0, 80),
      quantity,
      unitPrice,
      amount: hasValues
        ? makeField(quantity.value * unitPrice.value, {
          source: "formula",
          confidence: Math.min(quantity.confidence, unitPrice.confidence),
          status: canAutoCalculate ? "auto" : "low_confidence",
          reason: canAutoCalculate ? "" : "數量或單價信心不足，金額需人工確認"
        })
        : makeField(null, { source: "formula", confidence: 0, status: "manual_required", reason: "數量或單價缺失，無法計算金額" })
    };
  });

  const validItems = result.items.filter((item) => item.amount.value != null);
  if (validItems.length) {
    const amount = validItems.reduce((sum, item) => sum + Number(item.amount.value || 0), 0);
    const calcConfidence = Math.min(...validItems.flatMap((item) => [item.quantity.confidence, item.unitPrice.confidence]));
    const formulaStatus = validItems.every((item) => item.amount.status === "auto") ? "auto" : "low_confidence";
    const tax = Math.round(amount * 0.05);
    result.amount = makeField(amount, { source: "formula", confidence: calcConfidence, status: formulaStatus, reason: formulaStatus === "auto" ? "" : "來源欄位低信心，需人工確認" });
    result.tax = makeField(tax, { source: "formula", confidence: calcConfidence, status: formulaStatus, reason: formulaStatus === "auto" ? "" : "來源欄位低信心，需人工確認" });
    result.total = makeField(amount + tax, { source: "formula", confidence: calcConfidence, status: formulaStatus, reason: formulaStatus === "auto" ? "" : "來源欄位低信心，需人工確認" });
  } else {
    result.warnings.push("沒有可成立的數量與單價組合");
  }

  const hasManual = [
    result.invoiceNo,
    result.buyerTaxId,
    result.amount,
    result.tax,
    result.total,
    ...result.items.flatMap((item) => [item.quantity, item.unitPrice, item.amount])
  ].some((field) => field.status !== "auto");
  result.overallStatus = hasManual ? "needs_review" : "auto";
  return result;
}

export function recognitionToFlatFields(result) {
  const quantities = (result.items || []).map((item) => item.quantity.value).filter((value) => value != null);
  const unitPrices = (result.items || []).map((item) => item.unitPrice.value).filter((value) => value != null);
  const items = (result.items || [])
    .map((item, index) => ({
      lineNo: index + 1,
      itemName: item.name || "",
      quantity: item.quantity.value ?? null,
      unitPrice: item.unitPrice.value ?? null,
      amount: item.amount.value ?? (
        item.quantity.value != null && item.unitPrice.value != null
          ? Number(item.quantity.value) * Number(item.unitPrice.value)
          : null
      ),
      source: item.quantity.source || item.unitPrice.source || "tesseract",
      status: [item.quantity.status, item.unitPrice.status, item.amount.status].includes("manual_required")
        ? "manual_required"
        : [item.quantity.status, item.unitPrice.status, item.amount.status].includes("low_confidence")
          ? "low_confidence"
          : "auto",
      confidence: Math.min(item.quantity.confidence || 0, item.unitPrice.confidence || 0)
    }))
    .filter((item) => item.quantity != null || item.unitPrice != null || item.amount != null);
  return {
    invoiceNumber: result.invoiceNo.value ? String(result.invoiceNo.value) : "",
    taxId: result.buyerTaxId.value ? String(result.buyerTaxId.value) : "",
    items,
    quantity: quantities.length ? quantities.join(",") : "",
    unitPrice: unitPrices.length ? unitPrices.join(",") : "",
    salesAmount: result.amount.value != null ? String(result.amount.value) : "",
    taxAmount: result.tax.value != null ? String(result.tax.value) : "",
    totalAmount: result.total.value != null ? String(result.total.value) : ""
  };
}

function aggregateFields(fields = []) {
  const validFields = fields.filter(Boolean);
  if (!validFields.length) return makeField(null);
  const status = validFields.some((field) => field.status === "manual_required")
    ? "manual_required"
    : validFields.some((field) => field.status === "low_confidence")
      ? "low_confidence"
      : "auto";
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
  if (field === result.buyerTaxId) return "taxId";
  if (field === result.amount) return "salesAmount";
  if (field === result.tax) return "taxAmount";
  if (field === result.total) return "totalAmount";
  for (const item of result.items || []) {
    if (field === item.quantity) return "quantity";
    if (field === item.unitPrice) return "unitPrice";
    if (field === item.amount) return "salesAmount";
  }
  return "recognition";
}

export function recognitionToRecordMeta(result) {
  const quantityField = aggregateFields((result.items || []).map((item) => item.quantity));
  const unitPriceField = aggregateFields((result.items || []).map((item) => item.unitPrice));
  return {
    fieldSources: {
      invoiceNumber: result.invoiceNo.source,
      taxId: result.buyerTaxId.source,
      quantity: quantityField.source,
      unitPrice: unitPriceField.source,
      salesAmount: result.amount.source,
      taxAmount: result.tax.source,
      totalAmount: result.total.source
    },
    fieldStatuses: {
      invoiceNumber: result.invoiceNo.status,
      taxId: result.buyerTaxId.status,
      quantity: quantityField.status,
      unitPrice: unitPriceField.status,
      salesAmount: result.amount.status,
      taxAmount: result.tax.status,
      totalAmount: result.total.status
    },
    confidence: {
      invoiceNumber: result.invoiceNo.confidence,
      taxId: result.buyerTaxId.confidence,
      quantity: quantityField.confidence,
      unitPrice: unitPriceField.confidence,
      salesAmount: result.amount.confidence,
      taxAmount: result.tax.confidence,
      totalAmount: result.total.confidence
    },
    validationErrors: [
      result.invoiceNo,
      result.buyerTaxId,
      ...result.items.flatMap((item) => [item.quantity, item.unitPrice]),
      result.amount
    ]
      .filter((field) => field.status !== "auto")
      .map((field) => ({
        field: fieldNameFor(field, result),
        reason: field.reason || "需人工確認",
        status: field.status,
        source: field.source
      }))
  };
}
