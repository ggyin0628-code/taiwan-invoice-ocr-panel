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

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return number > 1 ? Math.max(0, Math.min(1, number / 100)) : Math.max(0, Math.min(1, number));
}

function normalizeItem(item = {}) {
  const quantity = Number(item.quantity);
  const amount = Number(item.amount);
  return {
    quantity: Number.isFinite(quantity) ? quantity : null,
    unitPrice: item.unitPrice ?? item.unit_price ?? null,
    amount: Number.isFinite(amount) ? amount : null,
    name: item.name ?? "",
    confidence: {
      quantity: normalizeConfidence(item.confidence),
      unitPrice: normalizeConfidence(item.confidence)
    }
  };
}

function normalizeResult(data = {}) {
  const fields = data.fields || {};
  const invoiceField = fields.invoiceNo || {};
  const taxIdField = fields.buyerTaxId || {};
  return {
    invoiceNo: invoiceField.value ?? null,
    buyerTaxId: taxIdField.value ?? null,
    items: Array.isArray(fields.items) ? fields.items.map(normalizeItem) : [],
    amount: fields.subtotal ?? null,
    tax: fields.tax ?? null,
    total: fields.total ?? null,
    confidence: {
      invoiceNo: normalizeConfidence(invoiceField.confidence),
      buyerTaxId: normalizeConfidence(taxIdField.confidence)
    },
    warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : []
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
    const response = await fetch(`${serviceUrl()}/ocr/invoice`, {
      method: "POST",
      body: form
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
      confidence: normalizeConfidence(data.fields?.invoiceNo?.confidence || data.fields?.buyerTaxId?.confidence || 0),
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
