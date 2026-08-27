import { readFileSync } from "node:fs";
import { basename } from "node:path";

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8765";

function enabled(options = {}) {
  return Boolean(options.force)
    || process.env.PADDLE_OCR_ENABLED === "true"
    || process.env.OCR_PROVIDER === "paddleocr";
}

function serviceUrl() {
  return String(process.env.PADDLE_OCR_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/+$/, "");
}

function timeoutMs(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return number > 1 ? Math.max(0, Math.min(1, number / 100)) : Math.max(0, Math.min(1, number));
}

function valueOf(value) {
  return value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value") ? value.value : value;
}

function normalizeProviderField(value, fallback = {}) {
  if (value == null) return null;
  const object = value && typeof value === "object" ? value : {};
  return {
    value: valueOf(value) ?? null,
    rawText: object.rawText ?? String(valueOf(value) ?? ""),
    source: object.source || fallback.source || "paddleocr",
    confidence: normalizeConfidence(object.confidence ?? fallback.confidence ?? 0),
    status: object.status === "CONFIRMED" || object.status === "auto" ? "auto" : object.status === "REVIEW_REQUIRED" || object.status === "manual_required" ? "manual_required" : object.status === "INVALID" ? "manual_required" : "low_confidence",
    evidence: Array.isArray(object.evidence) ? object.evidence : object.evidence ? [object.evidence] : [],
    resolverReason: object.resolverReason || ""
  };
}

function normalizeItem(item = {}) {
  const quantityRaw = item.quantity;
  const unitPriceRaw = item.unitPrice ?? item.unit_price;
  const amountRaw = item.lineAmount ?? item.amount ?? item.salesAmount;
  const quantity = Number(valueOf(quantityRaw));
  const unitPrice = Number(valueOf(unitPriceRaw));
  const amount = Number(valueOf(amountRaw));
  return {
    lineNo: Number(item.lineNo || item.rowId?.replace?.("row-", "") || 0) || null,
    rowId: item.rowId || null,
    rowBbox: item.rowBbox || item.rowBox || null,
    rowType: item.rowType || null,
    quantity: Number.isFinite(quantity) ? quantity : null,
    unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
    lineAmount: Number.isFinite(amount) ? amount : null,
    amount: Number.isFinite(amount) ? amount : null,
    amountReference: item.amountReference || null,
    name: item.name ?? item.itemName ?? "",
    itemName: item.itemName ?? item.name ?? "",
    nameEvidence: item.nameEvidence || null,
    lineAmountEvidence: item.lineAmountEvidence || item.amountEvidence || item.evidence?.amount || null,
    quantityEvidence: item.quantityEvidence || item.evidence?.quantity || null,
    unitPriceEvidence: item.unitPriceEvidence || item.evidence?.unitPrice || null,
    evidence: item.evidence || null,
    cells: item.cells || null,
    source: item.source || "paddleocr",
    confidence: {
      lineAmount: normalizeConfidence(item.confidence?.lineAmount ?? item.lineAmountEvidence?.confidence ?? item.amountEvidence?.confidence ?? item.confidence),
      quantity: normalizeConfidence(item.confidence?.quantity ?? item.quantityEvidence?.confidence ?? item.confidence),
      unitPrice: normalizeConfidence(item.confidence?.unitPrice ?? item.unitPriceEvidence?.confidence ?? item.confidence),
      row: normalizeConfidence(item.confidence?.row ?? item.confidence)
    },
    status: item.status === "CONFIRMED" || item.status === "auto" ? "auto" : item.status === "REVIEW_REQUIRED" || item.status === "manual_required" ? "manual_required" : "low_confidence"
  };
}

function fieldValue(value) {
  return valueOf(value) ?? null;
}

function normalizeResult(data = {}) {
  const fields = data.fields || {};
  const financialInput = data.financial || fields.financial || {};
  const invoiceField = fields.invoiceNo || fields.invoiceNumber || {};
  const buyerField = fields.buyerTaxId || fields.taxId || {};
  const sellerField = fields.sellerTaxId || {};
  const items = Array.isArray(fields.items)
    ? fields.items.map(normalizeItem)
    : Array.isArray(financialInput.lineAmounts) ? financialInput.lineAmounts.map(normalizeItem) : [];
  const salesField = fields.salesAmount ?? fields.subtotal ?? financialInput.salesAmount;
  const taxField = fields.taxAmount ?? fields.tax ?? financialInput.taxAmount;
  const totalField = fields.totalAmount ?? fields.total ?? financialInput.totalAmount;
  const normalizedSeller = normalizeProviderField(sellerField, { source: "paddleocr" });
  const normalizedBuyer = normalizeProviderField(buyerField, { source: "paddleocr" });
  return {
    financialScope: true,
    invoiceNo: fieldValue(invoiceField),
    sellerTaxId: normalizedSeller,
    buyerTaxId: fieldValue(buyerField),
    taxId: fieldValue(buyerField),
    items,
    amount: fieldValue(salesField),
    tax: fieldValue(taxField),
    total: fieldValue(totalField),
    salesAmount: fieldValue(salesField),
    taxAmount: fieldValue(taxField),
    totalAmount: fieldValue(totalField),
    financial: {
      lineAmounts: items.map((item) => ({
        lineNo: item.lineNo,
        lineAmount: item.lineAmount,
        amount: item.amount,
        rowBbox: item.rowBbox,
        confidence: item.confidence.lineAmount,
        source: item.source,
        evidence: item.lineAmountEvidence || item.evidence?.amount || null,
        status: item.status
      })),
      salesAmount: normalizeProviderField(salesField, { source: "paddleocr" }),
      taxAmount: normalizeProviderField(taxField, { source: "paddleocr" }),
      totalAmount: normalizeProviderField(totalField, { source: "paddleocr" }),
      reconciliation: data.reconciliation || null,
      status: data.financialStatus || financialInput.status || null
    },
    financialStatus: data.financialStatus || financialInput.status || null,
    confidence: {
      invoiceNo: normalizeConfidence(invoiceField.confidence),
      sellerTaxId: normalizedSeller?.confidence || 0,
      buyerTaxId: normalizeConfidence(buyerField.confidence),
      salesAmount: normalizeConfidence(salesField?.confidence),
      taxAmount: normalizeConfidence(taxField?.confidence),
      totalAmount: normalizeConfidence(totalField?.confidence)
    },
    warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : [],
    identityEvidence: {
      invoiceNumber: {
        candidates: Array.isArray(invoiceField.evidence) ? invoiceField.evidence : [],
        selected: fieldValue(invoiceField),
        resolverReason: invoiceField.resolverReason || ""
      },
      sellerTaxId: {
        candidates: Array.isArray(sellerField.evidence) ? sellerField.evidence : [],
        selected: fieldValue(sellerField),
        resolverReason: sellerField.resolverReason || ""
      },
      buyerTaxId: {
        candidates: Array.isArray(buyerField.evidence) ? buyerField.evidence : [],
        selected: fieldValue(buyerField),
        resolverReason: buyerField.resolverReason || ""
      },
      taxId: {
        candidates: Array.isArray(buyerField.evidence) ? buyerField.evidence : [],
        selected: fieldValue(buyerField),
        resolverReason: buyerField.resolverReason || ""
      }
    }
  };
}

export async function recognizeInvoiceWithPaddleOcr(imagePath, options = {}) {
  if (!enabled(options)) {
    return {
      ok: false,
      skipped: true,
      source: "paddleocr",
      raw: null,
      result: null,
      ocrText: "",
      ocrWords: [],
      error: "PaddleOCR disabled"
    };
  }

  try {
    const buffer = readFileSync(imagePath);
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "image/jpeg" }), basename(imagePath));
    if (options.scope) form.append("scope", String(options.scope));
    const response = await fetch(`${serviceUrl()}/ocr/invoice`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs("PADDLE_OCR_TIMEOUT_MS", 120000))
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data?.error || `PaddleOCR HTTP ${response.status}`);
    return {
      ok: true,
      source: "paddleocr",
      raw: data,
      result: normalizeResult(data),
      ocrText: data.rawText || "",
      ocrWords: Array.isArray(data.lines) ? data.lines.map((line) => ({
        text: line.text || "",
        confidence: Math.round(normalizeConfidence(line.confidence) * 100),
        left: Number(line.box?.x1 || 0),
        top: Number(line.box?.y1 || 0),
        width: Math.max(1, Number(line.box?.x2 || 0) - Number(line.box?.x1 || 0)),
        height: Math.max(1, Number(line.box?.y2 || 0) - Number(line.box?.y1 || 0))
      })) : [],
      confidence: normalizeConfidence(data.fields?.invoiceNo?.confidence || data.fields?.sellerTaxId?.confidence || data.fields?.buyerTaxId?.confidence || 0),
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      source: "paddleocr",
      raw: null,
      result: null,
      ocrText: "",
      ocrWords: [],
      error: error?.message || "PaddleOCR provider failed"
    };
  }
}
