import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { recognizeInvoiceWithPaddleOcr } from "../lib/server/paddleOcrProvider.js";
import { mergeInvoiceRecognitionResults, validateProviderCandidate } from "../lib/server/mergeInvoiceRecognitionResults.js";
import { processInvoiceRecord } from "../lib/server/processInvoice.js";
import { validateInvoiceRecognition } from "../lib/server/validateInvoiceRecognition.js";
import { REVIEW_STATUS } from "../lib/server/invoiceStatus.js";
import { tableLineItemsFromWords } from "../lib/server/anchorExtractor.js";
import { buildFinancialCore, calculateDeterministicFinancials, extractLineAmounts, extractSummaryAmounts, reconcileFinancials, resolveSellerTaxId } from "../lib/server/financialCore.js";
import { resolveBuyerTaxIdentity, resolveInvoiceIdentity } from "../lib/server/identityResolver.js";
import { deriveTargetedInvoiceRoi, hasCredibleInvoiceCandidate } from "../lib/server/targetedInvoiceRecovery.js";
import { deriveTargetedTableRoi, mergeTargetedTableRecovery, shouldRunTargetedTableRecovery } from "../lib/server/targetedTableRecovery.js";
import { InvoiceDocument, validateDocumentBoundary } from "../lib/server/invoiceDocument.js";
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

test("identity resolver preserves split invoice evidence and buyer/seller tax separation", () => {
  const invoice = resolveInvoiceIdentity({
    words: [
      { text: "TT", left: 120, top: 100, width: 40, height: 24, confidence: 95 },
      { text: "00000001", left: 180, top: 104, width: 120, height: 24, confidence: 98 }
    ],
    imageWidth: 600,
    imageHeight: 400
  });
  assert.equal(invoice.value, "TT00000001");
  assert.equal(invoice.selected.anchorRelationship, "invoice-anchor-header-left");
  assert.ok(invoice.selected.bbox.x2 > invoice.selected.bbox.x1);
  assert.ok(invoice.selected.evidenceScore >= 0.7);
  assert.match(invoice.selected.resolverReason, /joined split prefix/);

  const tax = resolveBuyerTaxIdentity({
    words: [
      { text: "統一編號", left: 80, top: 150, width: 90, height: 24, confidence: 96 },
      { text: "12345678", left: 190, top: 152, width: 120, height: 24, confidence: 98 },
      { text: "營業人蓋用統一發票專用章", left: 400, top: 250, width: 160, height: 24, confidence: 99 },
      { text: "87654321", left: 450, top: 300, width: 120, height: 24, confidence: 99 }
    ],
    invoiceNumber: "TT00000001",
    imageWidth: 600,
    imageHeight: 400
  });
  assert.equal(tax.value, "12345678");
  assert.equal(tax.selected.anchorRelationship, "buyer-label-region");
  assert.ok(tax.candidates.some((candidate) => candidate.anchorRelationship === "seller-region-excluded" && candidate.evidenceScore === 0));

  const unanchored = resolveBuyerTaxIdentity({
    words: [{ text: "87654321", left: 450, top: 300, width: 120, height: 24, confidence: 99 }],
    imageWidth: 600,
    imageHeight: 400
  });
  assert.equal(unanchored.value, "");
});

test("targeted invoice recovery uses normalized stacked-document ROI only when full-page identity is missing", () => {
  assert.equal(hasCredibleInvoiceCandidate("AB12345678"), true);
  assert.equal(hasCredibleInvoiceCandidate("AB1234"), false);
  const roi = deriveTargetedInvoiceRoi({
    width: 960,
    height: 1706,
    detection: { method: "synthetic-document-bounds", boundingBox: { left: 0, top: 223, width: 960, height: 1317 } },
    template: { fields: { invoiceNumber: { x: 0.105, y: 0.08, w: 0.25, h: 0.12 } } }
  });
  assert.equal(roi.documentSlotCount, 2);
  assert.equal(roi.documentSlotIndex, 0);
  assert.equal(roi.coordinateSpace, "original-image");
  assert.ok(roi.top > 223);
  assert.ok(roi.top + roi.height < 223 + 1317 / 2 + 20);
  assert.match(roi.selectionReason, /stacked invoice copies/);
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

test("InvoiceDocument collapses duplicate complete views and retains provenance", () => {
  const page = (filename) => ({ filename, predicted: {
    invoiceNumber: "ZZ00000000", buyerTaxId: "11112222", salesAmount: 200, taxAmount: 10, totalAmount: 210,
    items: [{ itemName: "SYNTHETIC_ITEM", quantity: 2, unitPrice: 100, amount: 200, rowBbox: { x1: 10, y1: 100, x2: 300, y2: 140 }, confidence: 0.9, source: "synthetic", cells: { quantity: {}, unitPrice: {} } }]
  } });
  const result = new InvoiceDocument({ documentId: "synthetic-document", pages: [page("view-a"), page("view-b")] }).toCanonical();
  assert.equal(result.observationType, "MULTIPLE_SINGLE_COMPLETE");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].agreement, 2);
  assert.deepEqual(result.items[0].sourcePages.sort(), ["view-a", "view-b"]);
  assert.equal(result.items[0].conflicts.length, 0);
  assert.equal(result.salesAmount, 200);
});

test("InvoiceDocument keeps strong-row conflicts reviewable instead of creating rows", () => {
  const page = (filename, unitPrice, amount) => ({ filename, predicted: {
    invoiceNumber: "ZZ00000000", buyerTaxId: "11112222", items: [{ itemName: "SYNTHETIC_CONFLICT", quantity: 1, unitPrice, amount, rowBbox: { x1: 10, y1: 100, x2: 300, y2: 140 } }]
  } });
  const result = new InvoiceDocument({ documentId: "synthetic-conflict", pages: [page("view-a", 100, 100), page("view-b", 110, 110)] }).toCanonical();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].unitPrice, 100);
  assert.ok(result.items[0].conflicts.some((conflict) => conflict.field === "unitPrice"));
  assert.equal(result.items[0].sourcePages.length, 2);
});

test("InvoiceDocument preserves single-image document invariant", () => {
  const result = new InvoiceDocument({ documentId: "synthetic-single", pages: [{ filename: "single", predicted: { items: [{ itemName: "SINGLE_ITEM", quantity: 1, unitPrice: 7, amount: 7, rowBbox: { x1: 1, y1: 1, x2: 20, y2: 20 } }] } }] }).toCanonical();
  assert.equal(result.observationType, "SINGLE_COMPLETE");
  assert.equal(result.observationCount, 1);
  assert.equal(result.items.length, 1);
});

test("bounded table ROI uses normalized geometry and only triggers on weak evidence", () => {
  const roi = deriveTargetedTableRoi({ width: 1200, height: 700 });
  assert.equal(roi.coordinateSpace, "corrected-image");
  assert.equal(roi.normalizedGeometry.x, 0.1);
  assert.equal(shouldRunTargetedTableRecovery({ items: [{ name: "SYNTHETIC_ITEM", rowBbox: {}, cells: {}, quantity: 1, unitPrice: 7 }] }), false);
  assert.equal(shouldRunTargetedTableRecovery({ items: [{ name: "", rowType: "numeric_only", quantity: 1, unitPrice: 7 }] }), true);
});

test("targeted table merge keeps the higher-evidence row set", () => {
  const base = { ok: true, result: { items: [{ name: "", rowType: "numeric_only", quantity: 1, unitPrice: 7 }] }, raw: {} };
  const recovery = { accepted: true, result: { items: [{ name: "SYNTHETIC_ITEM", quantity: 1, unitPrice: 7, rowBbox: {}, cells: {} }], warnings: [] }, performance: {} };
  const merged = mergeTargetedTableRecovery(base, recovery);
  assert.equal(merged.result.items[0].name, "SYNTHETIC_ITEM");
  assert.equal(merged.targetedTableRecovery.selected, "targeted-table-roi");
});

test("canonical rows retain row and cell evidence without changing formula", () => {
  const result = validateInvoiceRecognition({ invoiceNo: "ZZ00000000", buyerTaxId: "11112222", items: [{ itemName: "SYNTHETIC_ITEM", quantity: 2, unitPrice: 7, rowId: "row-1", rowBbox: { x1: 1, y1: 2, x2: 3, y2: 4 }, nameEvidence: { tokenCount: 1 }, cells: { quantity: { column: "quantity" } } }], confidence: 0.9 }, { source: "paddleocr", defaultConfidence: 0.9 });
  assert.equal(result.items[0].rowId, "row-1");
  assert.equal(result.items[0].rowBbox.x2, 3);
  assert.equal(result.items[0].nameEvidence.tokenCount, 1);
  assert.equal(result.amount.value, 14);
});

test("document boundary rejects duplicate image mappings and accepts complete observations", () => {
  const boundary = validateDocumentBoundary({ documents: [
    { documentId: "doc-a", sourceImageIds: ["view-a", "view-b"], observationType: "SINGLE_COMPLETE" },
    { documentId: "doc-b", sourceImageIds: ["view-c"], observationType: "SINGLE_COMPLETE" }
  ] });
  assert.equal(boundary.documentCount, 2);
  assert.equal(boundary.imageCount, 3);
  assert.throws(() => validateDocumentBoundary({ documents: [
    { documentId: "doc-a", sourceImageIds: ["view-a"] },
    { documentId: "doc-b", sourceImageIds: ["view-a"] }
  ] }), /multiple documents/);
});

test("seller tax resolver preserves seller anchor and excludes buyer/invoice collisions", () => {
  const result = resolveSellerTaxId({
    words: [
      { text: "買受人統編", left: 80, top: 150, width: 120, height: 24, confidence: 96 },
      { text: "12345678", left: 210, top: 152, width: 120, height: 24, confidence: 98 },
      { text: "營業人", left: 720, top: 270, width: 90, height: 24, confidence: 98 },
      { text: "87654321", left: 820, top: 272, width: 120, height: 24, confidence: 99 }
    ],
    buyerTaxId: "12345678",
    invoiceNumber: "TT00000001",
    imageWidth: 1200,
    imageHeight: 700
  });
  assert.equal(result.value, "87654321");
  assert.equal(result.status, "auto");
  assert.equal(result.selected.anchorRelationship, "seller-label-same-row");
  assert.ok(result.evidence.some((candidate) => candidate.normalizedCandidate === "12345678" && candidate.anchorRelationship === "identity-collision-excluded"));
});

test("financial line amount extraction does not require item-name recognition", () => {
  const rows = extractLineAmounts({ words: [
    { text: "品名", left: 100, top: 80, width: 80, height: 24, confidence: 95 },
    { text: "數量", left: 420, top: 80, width: 70, height: 24, confidence: 95 },
    { text: "單價", left: 560, top: 80, width: 70, height: 24, confidence: 95 },
    { text: "金額", left: 760, top: 80, width: 70, height: 24, confidence: 95 },
    { text: "2", left: 430, top: 150, width: 24, height: 24, confidence: 95 },
    { text: "100", left: 570, top: 150, width: 50, height: 24, confidence: 95 },
    { text: "200", left: 770, top: 150, width: 50, height: 24, confidence: 95 }
  ], imageWidth: 1200, imageHeight: 700 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lineAmount, 200);
  assert.equal(rows[0].itemName, "");
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].unitPrice, 100);
});

test("summary amounts are extracted independently from labels", () => {
  const summary = extractSummaryAmounts({ words: [
    { text: "銷售額 200", left: 700, top: 520, width: 180, height: 24, confidence: 95 },
    { text: "稅額 10", left: 700, top: 555, width: 150, height: 24, confidence: 95 },
    { text: "總計 210", left: 700, top: 590, width: 160, height: 24, confidence: 95 }
  ], imageWidth: 1200, imageHeight: 700 });
  assert.equal(summary.salesAmount.value, 200);
  assert.equal(summary.taxAmount.value, 10);
  assert.equal(summary.totalAmount.value, 210);
});

test("financial status recommends review for missing optional evidence, not item-name failure", () => {
  const result = validateInvoiceRecognition({
    invoiceNo: "TT00000001",
    sellerTaxId: { value: "87654321", confidence: 0.95 },
    buyerTaxId: "12345678",
    items: [{ itemName: "", lineAmount: 200, lineAmountEvidence: { confidence: 0.95 }, quantity: null, unitPrice: null }],
    salesAmount: 200,
    taxAmount: 10,
    totalAmount: 210,
    confidence: 0.95
  }, { source: "paddleocr", defaultConfidence: 0.95 });
  assert.equal(result.financialStatus, "REVIEW_RECOMMENDED");
  assert.equal(result.reviewStatus, "REVIEW_RECOMMENDED");
  assert.notEqual(result.reviewStatus, "REVIEW_REQUIRED");
  assert.equal(result.financial.reconciliation.lineSumVsSales, "PASS");
  assert.equal(result.financial.reconciliation.salesPlusTaxVsTotal, "PASS");
});

test("financial reconciliation mismatch is never silently accepted", () => {
  const result = buildFinancialCore({
    sellerTaxId: { value: "87654321", status: "auto", confidence: 0.95 },
    buyerTaxId: { value: "12345678", status: "auto", confidence: 0.95 },
    items: [{ lineAmount: 200, itemName: "" }],
    salesAmount: { value: 202, status: "auto", confidence: 0.95 },
    taxAmount: { value: 10, status: "auto", confidence: 0.95 },
    totalAmount: { value: 212, status: "auto", confidence: 0.95 }
  });
  assert.equal(result.reconciliation.lineSumVsSales, "MISMATCH");
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.ok(result.reconciliation.warnings.length > 0);
});

test("financial-core merges scoped quantity and unitPrice candidates into one row", () => {
  const base = validateProviderCandidate({
    sellerTaxId: { value: "87654321", confidence: 0.95 },
    items: [{ lineNo: 1, quantity: null, unitPrice: 100, lineAmount: 200, itemName: "" }]
  }, { source: "paddleocr", defaultConfidence: 0.95 });
  const quantityScope = validateProviderCandidate({
    sellerTaxId: { value: "87654321", confidence: 0.95 },
    items: [{ lineNo: 1, quantity: 2, unitPrice: null, itemName: "" }]
  }, { source: "paddleocr", defaultConfidence: 0.95 });
  const result = mergeInvoiceRecognitionResults({ candidates: [base, quantityScope], mode: "financial-core" });
  assert.equal(result.recognitionResult.items.length, 1);
  assert.equal(result.recognitionResult.items[0].quantity.value, 2);
  assert.equal(result.recognitionResult.items[0].unitPrice.value, 100);
  assert.equal(result.recognitionResult.items[0].lineAmount.value, 200);
});

test("deterministic financials use q times u for line and sales, independent of printed amount", () => {
  const calculated = calculateDeterministicFinancials({
    items: [{
      quantity: { value: 2, status: "auto", confidence: 0.95 },
      unitPrice: { value: 100, status: "auto", confidence: 0.95 },
      lineAmount: { value: 999, source: "paddleocr", confidence: 0.95 }
    }],
    taxRounding: "round",
    taxPolicyConfirmed: true
  });
  assert.equal(calculated.items[0].calculatedLineAmount.value, 200);
  assert.equal(calculated.salesAmount.value, 200);
  assert.equal(calculated.items[0].financialVerification.status, "MISMATCH_REVIEW_REQUIRED");
});

test("printed line matching and mismatch retain explicit secondary verification", () => {
  const matching = calculateDeterministicFinancials({
    items: [{ quantity: 2, unitPrice: 100, lineAmount: { value: 200, source: "paddleocr" } }],
    taxRounding: "round",
    taxPolicyConfirmed: true
  });
  const mismatch = calculateDeterministicFinancials({
    items: [{ quantity: 2, unitPrice: 100, lineAmount: { value: 201, source: "paddleocr" } }],
    taxRounding: "round",
    taxPolicyConfirmed: true
  });
  assert.equal(matching.items[0].financialVerification.status, "CALCULATED_VERIFIED");
  assert.equal(mismatch.items[0].financialVerification.status, "MISMATCH_REVIEW_REQUIRED");
});

test("unconfirmed tax rounding holds tax and total for review, explicit round calculates both", () => {
  const held = calculateDeterministicFinancials({ items: [{ quantity: 2, unitPrice: 100 }] });
  assert.equal(held.salesAmount.value, 200);
  assert.equal(held.taxAmount.value, null);
  assert.equal(held.totalAmount.value, null);
  assert.equal(held.taxPolicyConfirmed, false);
  const confirmed = calculateDeterministicFinancials({ items: [{ quantity: 2, unitPrice: 100 }], taxRounding: "round", taxPolicyConfirmed: true });
  assert.equal(confirmed.taxAmount.value, 10);
  assert.equal(confirmed.totalAmount.value, 210);
});

test("missing quantity or unit price remains REVIEW_REQUIRED regardless of item name", () => {
  const result = mergeInvoiceRecognitionResults({
    candidates: [validateProviderCandidate({
      sellerTaxId: { value: "87654321", confidence: 0.95 },
      items: [{ lineNo: 1, itemName: "ignored", quantity: null, unitPrice: 100 }]
    }, { source: "paddleocr", defaultConfidence: 0.95 })],
    mode: "financial-core"
  });
  assert.equal(result.recognitionResult.financialStatus, "REVIEW_REQUIRED");
  assert.equal(result.recognitionResult.financialStatus, result.recognitionResult.reviewStatus);
});
