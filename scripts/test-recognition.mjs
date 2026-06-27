import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { recognizeInvoiceWithPaddleOcr } from "../lib/server/paddleOcrProvider.js";
import { mergeInvoiceRecognitionResults, validateProviderCandidate } from "../lib/server/mergeInvoiceRecognitionResults.js";
import { processInvoiceRecord } from "../lib/server/processInvoice.js";
import { validateInvoiceRecognition } from "../lib/server/validateInvoiceRecognition.js";

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(() => console.log(`ok - ${name}`));
    }
    console.log(`ok - ${name}`);
    return null;
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("PaddleOCR disabled or service unavailable does not crash", async () => {
  const oldEnabled = process.env.PADDLE_OCR_ENABLED;
  const oldProvider = process.env.OCR_PROVIDER;
  const oldUrl = process.env.PADDLE_OCR_SERVICE_URL;
  process.env.PADDLE_OCR_ENABLED = "true";
  process.env.PADDLE_OCR_SERVICE_URL = "http://127.0.0.1:9";
  try {
    const result = await recognizeInvoiceWithPaddleOcr("/tmp/non-existent-invoice.jpg");
    assert.equal(result.ok, false);
    assert.equal(result.source, "paddleocr");
    assert.equal(typeof result.error, "string");
  } finally {
    if (oldEnabled == null) delete process.env.PADDLE_OCR_ENABLED;
    else process.env.PADDLE_OCR_ENABLED = oldEnabled;
    if (oldProvider == null) delete process.env.OCR_PROVIDER;
    else process.env.OCR_PROVIDER = oldProvider;
    if (oldUrl == null) delete process.env.PADDLE_OCR_SERVICE_URL;
    else process.env.PADDLE_OCR_SERVICE_URL = oldUrl;
  }
});

test("multi item formula calculation uses quantity and unit price", () => {
  const result = validateInvoiceRecognition({
    invoiceNo: "VT17832862",
    buyerTaxId: "49403043",
    items: [
      { quantity: 1, unitPrice: 150000 },
      { quantity: 1, unitPrice: 10000 }
    ],
    confidence: 0.9
  }, { source: "macos_vision", defaultConfidence: 0.9 });
  assert.equal(result.amount.value, 160000);
  assert.equal(result.tax.value, 8000);
  assert.equal(result.total.value, 168000);
  assert.equal(result.overallStatus, "auto");
});

test("provider conflicts become low confidence", () => {
  const local = validateProviderCandidate({
    invoiceNo: "VT17832862",
    buyerTaxId: "49403043",
    items: [{ quantity: 1, unitPrice: 150000 }],
    confidence: 0.9
  }, { source: "macos_vision", defaultConfidence: 0.9 });
  const google = validateProviderCandidate({
    invoiceNo: "ZX17803850",
    buyerTaxId: "49403043",
    items: [{ quantity: 1, unitPrice: 150000 }],
    confidence: 0.9
  }, { source: "google_vision", defaultConfidence: 0.9 });
  const merged = mergeInvoiceRecognitionResults({ candidates: [google, local], mode: "hybrid" });
  assert.equal(merged.recognitionResult.invoiceNo.status, "low_confidence");
  assert.equal(merged.flatFields.invoiceNumber, "");
});

test("invalid fields are manual required", () => {
  const result = validateInvoiceRecognition({
    invoiceNo: "17832862",
    buyerTaxId: "ABC",
    items: [{ quantity: 0, unitPrice: "一萬" }],
    confidence: 0.9
  }, { source: "tesseract", defaultConfidence: 0.9 });
  assert.equal(result.invoiceNo.status, "manual_required");
  assert.equal(result.buyerTaxId.status, "manual_required");
  assert.equal(result.items[0].quantity.status, "manual_required");
  assert.equal(result.amount.status, "manual_required");
});

test("low confidence but valid numeric fields are retained for manual review", () => {
  const result = validateInvoiceRecognition({
    invoiceNo: "VT17832862",
    buyerTaxId: "49403043",
    items: [{ quantity: 1, unitPrice: 150000 }],
    confidence: {
      invoiceNo: 0.7,
      buyerTaxId: 0.59
    }
  }, { source: "macos_vision", defaultConfidence: 0.13 });
  assert.equal(result.buyerTaxId.value, "49403043");
  assert.equal(result.buyerTaxId.status, "low_confidence");
  assert.equal(result.items[0].quantity.value, 1);
  assert.equal(result.items[0].unitPrice.value, 150000);
  assert.equal(result.amount.value, 150000);
  assert.equal(result.amount.status, "low_confidence");
});

test("PaddleOCR service extractor documents quantity and unit price only", () => {
  const source = readFileSync(resolve("ocr-service/paddle_invoice_ocr.py"), "utf8");
  assert.equal(source.includes("amount // quantity if quantity"), false);
  assert.equal(source.includes("quantity * unit_price"), true);
  assert.equal(source.includes("數量欄與單價欄筆數不一致"), true);
});


test("Excel export route does not export raw OCR text fields", () => {
  const source = readFileSync(resolve("app/api/export/route.js"), "utf8");
  assert.equal(source.includes("ocrRawJson"), false);
  assert.equal(source.includes("rawText"), false);
  assert.equal(source.includes("aiVisionRaw"), false);
});

test("Excel export expands invoice line items", () => {
  const source = readFileSync(resolve("app/api/export/route.js"), "utf8");
  assert.equal(source.includes("records.flatMap"), true);
  assert.equal(source.includes("明細序號"), true);
  assert.equal(source.includes("recordItems(record)"), true);
});

test("frontend provider display is fixed to hybrid and does not expose cloud choices", () => {
  const source = readFileSync(resolve("app/page.jsx"), "utf8");
  assert.equal(source.includes("provider="), true);
  assert.equal(source.includes("const ocrProvider = \"hybrid\""), true);
  assert.equal(source.includes("<select value={ocrProvider}"), false);
  assert.equal(source.includes("<option value=\"google-vision\""), false);
  assert.equal(source.includes("<option value=\"openai-vision\""), false);
});

test("process API accepts provider parameter server side", () => {
  const source = readFileSync(resolve("app/api/records/[id]/process/route.js"), "utf8");
  assert.equal(source.includes("body.provider"), true);
});

test("manual provider returns empty manual-required record without OCR", async () => {
  const result = await processInvoiceRecord({
    id: "test-manual",
    batchId: "TEST",
    filename: "manual.jpg",
    imagePath: "data/uploads/TEST/manual.jpg"
  }, { provider: "manual" });
  assert.equal(result.actualProvider, "manual");
  assert.equal(result.providerStatus, "manual_required");
  assert.equal(result.processingStatus, "need_review");
  assert.equal(result.fieldSources.invoiceNumber, "manual");
});
