import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { recognizeInvoiceWithPaddleOcr } from "../lib/server/paddleOcrProvider.js";
import { mergeInvoiceRecognitionResults, validateProviderCandidate } from "../lib/server/mergeInvoiceRecognitionResults.js";
import { processInvoiceRecord } from "../lib/server/processInvoice.js";
import { validateInvoiceRecognition } from "../lib/server/validateInvoiceRecognition.js";
import { REVIEW_STATUS } from "../lib/server/invoiceStatus.js";
import { tableLineItemsFromWords } from "../lib/server/anchorExtractor.js";
import { probeModel } from "../lib/server/providerHealth.js";

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

test("informational Paddle warning does not create validation failure", () => {
  const result = validateInvoiceRecognition({
    invoiceNo: "VT17832862",
    buyerTaxId: "49403043",
    items: [{ quantity: 1, unitPrice: 150000 }],
    warnings: ["PaddleOCR 僅供初步填入，仍需人工確認"],
    confidence: 0.9
  }, { source: "paddleocr", defaultConfidence: 0.9 });
  assert.equal(result.reviewStatus, REVIEW_STATUS.AUTO_OK);
  assert.equal(result.overallStatus, "auto");
});

test("valid low-confidence fields are retained as review recommended", () => {
  const result = validateInvoiceRecognition({
    invoiceNo: "VT17832862",
    buyerTaxId: "49403043",
    items: [{ quantity: 1, unitPrice: 150000 }],
    confidence: { invoiceNo: 0.9, buyerTaxId: 0.65, quantity: 0.9, unitPrice: 0.9 }
  }, { source: "paddleocr", defaultConfidence: 0.9 });
  assert.equal(result.buyerTaxId.value, "49403043");
  assert.equal(result.buyerTaxId.status, "low_confidence");
  assert.equal(result.reviewStatus, REVIEW_STATUS.REVIEW_RECOMMENDED);
  assert.equal(result.items[0].amount.value, 150000);
});

test("identity merge prefers materially stronger candidate", () => {
  const paddle = validateProviderCandidate({
    invoiceNo: "TT00000001",
    buyerTaxId: "00000001",
    items: [{ quantity: 1, unitPrice: 2530 }],
    confidence: 0.96
  }, { source: "paddleocr", defaultConfidence: 0.96 });
  const local = validateProviderCandidate({
    invoiceNo: "TT99999999",
    buyerTaxId: "99999999",
    items: [{ quantity: 1, unitPrice: 2530 }],
    confidence: 0.6
  }, { source: "tesseract", defaultConfidence: 0.6 });
  const merged = mergeInvoiceRecognitionResults({ candidates: [paddle, local], mode: "hybrid" });
  assert.equal(merged.recognitionResult.invoiceNo.value, "TT00000001");
  assert.equal(merged.recognitionResult.invoiceNo.status, "auto");
  assert.equal(merged.recognitionResult.buyerTaxId.value, "00000001");
});

test("identity merge keeps close-confidence conflict reviewable", () => {
  const first = validateProviderCandidate({
    invoiceNo: "TT00000001",
    buyerTaxId: "00000001",
    items: [{ quantity: 1, unitPrice: 2530 }],
    confidence: 0.9
  }, { source: "paddleocr", defaultConfidence: 0.9 });
  const second = validateProviderCandidate({
    invoiceNo: "TT99999999",
    buyerTaxId: "99999999",
    items: [{ quantity: 1, unitPrice: 2530 }],
    confidence: 0.82
  }, { source: "tesseract", defaultConfidence: 0.82 });
  const merged = mergeInvoiceRecognitionResults({ candidates: [first, second], mode: "hybrid" });
  assert.equal(merged.recognitionResult.invoiceNo.value, null);
  assert.equal(merged.recognitionResult.invoiceNo.status, "low_confidence");
});

test("invalid and missing fields remain required review errors", () => {
  const result = validateInvoiceRecognition({
    invoiceNo: "17832862",
    buyerTaxId: "ABC",
    items: [{ quantity: 0, unitPrice: "一萬" }],
    confidence: 0.9
  }, { source: "paddleocr", defaultConfidence: 0.9 });
  assert.equal(result.reviewStatus, REVIEW_STATUS.INVALID);
  assert.ok(result.items[0].quantity.severity === "invalid");
});

test("confirmation path validates before clearing errors", () => {
  const source = readFileSync(resolve("app/api/records/[id]/route.js"), "utf8");
  assert.ok(source.indexOf('if (body.status === "confirmed")') < source.indexOf('const validation = validateInvoiceRecord(validationInput(current, patch));'));
  assert.ok(source.includes('status: 422'));
});

test("OCR benchmark fails explicitly without private samples", () => {
  const source = readFileSync(resolve("scripts/test-ocr-samples.mjs"), "utf8");
  assert.ok(source.includes("samples-private"));
  assert.ok(source.includes("process.exitCode = 2"));
  assert.ok(source.includes("fieldAccuracy"));
  assert.ok(source.includes("providerFailureRate"));
});

test("frontend line item editor supports row editing operations", () => {
  const source = readFileSync(resolve("app/page.jsx"), "utf8");
  assert.ok(source.includes("function updateRecordItems"));
  assert.ok(source.includes("新增列"));
  assert.ok(source.includes("刪除"));
  assert.ok(source.includes("確認列"));
  assert.ok(source.includes("editableLineItemsTable"));
});

test("health and doctor expose degradation states", () => {
  const healthRoute = readFileSync(resolve("app/api/health/route.js"), "utf8");
  const doctor = readFileSync(resolve("scripts/doctor.mjs"), "utf8");
  assert.ok(healthRoute.includes("collectProviderHealth"));
  assert.ok(healthRoute.includes("degradation"));
  assert.ok(doctor.includes('readiness("PaddleOCR"'));
  assert.ok(doctor.includes('readiness("Model"'));
  assert.ok(doctor.includes('"MISSING"'));
  assert.equal(probeModel({ status: "READY", models: [{ name: "qwen2.5vl:7b" }] }).status, "READY");
  assert.equal(probeModel({ status: "READY", models: [] }).status, "MISSING");
});

test("table extraction scales from detected headers", () => {
  const result = tableLineItemsFromWords([
    { text: "數量", left: 580, top: 90, width: 70, height: 30, confidence: 95 },
    { text: "單價", left: 880, top: 90, width: 70, height: 30, confidence: 95 },
    { text: "金額", left: 1280, top: 90, width: 70, height: 30, confidence: 95 },
    { text: "2", left: 600, top: 180, width: 30, height: 30, confidence: 95 },
    { text: "100", left: 900, top: 180, width: 60, height: 30, confidence: 95 },
    { text: "200", left: 1300, top: 180, width: 60, height: 30, confidence: 95 }
  ], { imageWidth: 2000, imageHeight: 1000 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].quantity, 2);
  assert.equal(result.items[0].unitPrice, 100);
  assert.equal(result.items[0].amount, 200);
});
