import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { processInvoiceRecord } from "../lib/server/processInvoice.js";
import { fromDataRelativePath, toDataRelativePath, UPLOADS_DIR } from "../lib/server/paths.js";

const root = process.cwd();
const samplesDir = process.env.OCR_SAMPLES_DIR || join(root, "samples-private");
const groundTruthPath = process.env.OCR_GROUND_TRUTH || join(root, "ground-truth-private.json");
const benchmarkDir = process.env.OCR_BENCHMARK_DIR || join(root, ".ocr-benchmark");
const supportedImage = /\.(jpe?g|png|webp|tiff?)$/i;
const scalarFields = ["invoiceNumber", "buyerTaxId", "salesAmount", "taxAmount", "totalAmount"];
const itemFields = ["itemName", "quantity", "unitPrice", "amount"];
const rootCauseLabels = [
  "document detection",
  "orientation",
  "perspective correction",
  "OCR recognition",
  "layout resolver",
  "field resolver",
  "row grouping",
  "invoice number",
  "tax ID",
  "quantity",
  "unit price",
  "formula validation",
  "provider unavailable",
  "other"
];

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

function normalizeNumber(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function normalizeItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    itemName: normalizeText(item?.itemName ?? item?.name ?? ""),
    quantity: normalizeNumber(item?.quantity),
    unitPrice: normalizeNumber(item?.unitPrice ?? item?.unit_price),
    amount: normalizeNumber(item?.amount)
  }));
}

function normalizeExpected(expected = {}) {
  return {
    invoiceNumber: normalizeText(expected.invoiceNumber),
    buyerTaxId: normalizeText(expected.buyerTaxId),
    items: normalizeItems(expected.items),
    salesAmount: normalizeNumber(expected.salesAmount),
    taxAmount: normalizeNumber(expected.taxAmount),
    totalAmount: normalizeNumber(expected.totalAmount)
  };
}

function normalizePredicted(record = {}) {
  return {
    invoiceNumber: normalizeText(record.invoiceNumber),
    buyerTaxId: normalizeText(record.taxId),
    items: normalizeItems(record.items),
    salesAmount: normalizeNumber(record.salesAmount),
    taxAmount: normalizeNumber(record.taxAmount),
    totalAmount: normalizeNumber(record.totalAmount)
  };
}

function hasValue(value) {
  return value != null && value !== "";
}

function fieldEqual(field, expected, predicted) {
  if (field === "items") return JSON.stringify(expected.items) === JSON.stringify(predicted.items);
  return expected[field] === predicted[field];
}

function hasExpectedValue(field, expected) {
  return field === "items" ? expected.items.length > 0 : hasValue(expected[field]);
}

function hasPredictedValue(field, predicted) {
  return field === "items" ? predicted.items.length > 0 : hasValue(predicted[field]);
}

function loadGroundTruth() {
  if (!existsSync(groundTruthPath)) throw new Error(`找不到 ground truth：${groundTruthPath}`);
  const raw = JSON.parse(readFileSync(groundTruthPath, "utf8"));
  if (Array.isArray(raw)) return Object.fromEntries(raw.map((entry) => [entry.filename, entry]));
  return raw && typeof raw === "object" ? raw : {};
}

function sampleFiles() {
  if (!existsSync(samplesDir)) return [];
  return readdirSync(samplesDir)
    .filter((name) => supportedImage.test(name))
    .sort()
    .map((name) => join(samplesDir, name));
}

function validGroundTruthEntry(entry) {
  return entry
    && hasValue(entry.invoiceNumber)
    && hasValue(entry.buyerTaxId)
    && Array.isArray(entry.items)
    && entry.items.length > 0
    && entry.items.every((item) => item && hasValue(item.itemName) && hasValue(item.quantity) && hasValue(item.unitPrice))
    && hasValue(entry.salesAmount)
    && hasValue(entry.taxAmount)
    && hasValue(entry.totalAmount);
}

function compareItems(expectedItems, predictedItems) {
  const expectedCount = expectedItems.length;
  const predictedCount = predictedItems.length;
  const completeRows = expectedCount
    ? predictedItems.slice(0, expectedCount).filter((item) => ["quantity", "unitPrice", "amount"].every((field) => hasValue(item[field]))).length
    : predictedCount === 0 ? 1 : 0;
  const exactRows = expectedItems.filter((expected, index) => predictedItems[index] && itemFields.every((field) => expected[field] === predictedItems[index][field])).length;
  return {
    exactMatch: JSON.stringify(expectedItems) === JSON.stringify(predictedItems),
    expectedCount,
    predictedCount,
    exactRows,
    exactRowRate: expectedCount ? exactRows / expectedCount : predictedCount === 0 ? 1 : 0,
    completeness: expectedCount ? completeRows / expectedCount : predictedCount === 0 ? 1 : 0
  };
}

function compareSample(expected, predicted) {
  const fieldResults = Object.fromEntries([
    ...scalarFields.map((field) => [field, fieldEqual(field, expected, predicted)]),
    ["items", fieldEqual("items", expected, predicted)]
  ]);
  const expectedFields = scalarFields.filter((field) => hasExpectedValue(field, expected));
  const missingFields = expectedFields.filter((field) => !hasPredictedValue(field, predicted));
  const falsePositiveFields = scalarFields.filter((field) => !hasExpectedValue(field, expected) && hasPredictedValue(field, predicted));
  const items = compareItems(expected.items, predicted.items);
  const expectedFieldCount = expectedFields.length + (expected.items.length ? 1 : 0);
  const matchedFieldCount = expectedFields.filter((field) => fieldResults[field]).length + (expected.items.length && fieldResults.items ? 1 : 0);
  return {
    exactMatch: scalarFields.every((field) => fieldResults[field]) && items.exactMatch,
    fieldResults,
    expectedFieldCount,
    fieldAccuracy: expectedFieldCount ? matchedFieldCount / expectedFieldCount : 0,
    missingRate: expectedFields.length ? missingFields.length / expectedFields.length : 0,
    falsePositiveRate: scalarFields.filter((field) => !hasExpectedValue(field, expected)).length ? falsePositiveFields.length / scalarFields.filter((field) => !hasExpectedValue(field, expected)).length : 0,
    missingFields,
    falsePositiveFields,
    items
  };
}

function loadDebug(result) {
  const path = result?.debug;
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(fromDataRelativePath(path), "utf8"));
  } catch {
    return null;
  }
}

function classifyRootCauses(result) {
  const causes = new Set();
  const expected = result.expected;
  const predicted = result.predicted;
  const comparison = result.comparison;
  const debug = loadDebug(result);
  if (result.providerFailure) causes.add("provider unavailable");
  if (debug?.documentDetection && debug.documentDetection.detected === false) causes.add("document detection");
  if (debug?.documentDetection && ["orientation", "rotated"].some((key) => debug.documentDetection[key])) causes.add("orientation");
  if (debug?.documentDetection && ["perspective", "skew", "homography"].some((key) => debug.documentDetection[key])) causes.add("perspective correction");
  if (comparison.fieldResults.invoiceNumber === false) causes.add(hasValue(predicted.invoiceNumber) ? "OCR recognition" : "invoice number");
  if (comparison.fieldResults.buyerTaxId === false) causes.add(hasValue(predicted.buyerTaxId) ? "OCR recognition" : "tax ID");
  if (comparison.fieldResults.salesAmount === false || comparison.fieldResults.taxAmount === false || comparison.fieldResults.totalAmount === false) causes.add("formula validation");
  if (expected.items.length !== predicted.items.length) causes.add("row grouping");
  if (expected.items.length && !predicted.items.length) causes.add("layout resolver");
  expected.items.forEach((expectedItem, index) => {
    const predictedItem = predicted.items[index];
    if (!predictedItem) return;
    if (expectedItem.quantity !== predictedItem.quantity) causes.add("quantity");
    if (expectedItem.unitPrice !== predictedItem.unitPrice) causes.add("unit price");
    if (expectedItem.itemName !== predictedItem.itemName) causes.add("OCR recognition");
    if (expectedItem.amount !== predictedItem.amount) causes.add("formula validation");
  });
  if (!comparison.exactMatch && !causes.size) causes.add("field resolver");
  if (!causes.size && result.processingStatus === "failed") causes.add("other");
  return [...causes];
}

function metricForField(results, field) {
  const eligible = results.filter((result) => hasExpectedValue(field, result.expected));
  return {
    correct: eligible.filter((result) => result.comparison.fieldResults[field]).length,
    total: eligible.length,
    accuracy: eligible.length ? eligible.filter((result) => result.comparison.fieldResults[field]).length / eligible.length : null
  };
}

function rootCauseCounts(results) {
  const counts = Object.fromEntries(rootCauseLabels.map((label) => [label, 0]));
  for (const result of results) for (const cause of result.rootCauses || []) counts[cause] = (counts[cause] || 0) + 1;
  return counts;
}

function stagePerformanceSummary(results) {
  const stages = ["intakeMs", "preprocessMs", "localOcrMs", "regionOcrMs", "identityResolverMs", "paddleOcrMs", "targetedRoiPreprocessMs", "targetedRoiOcrMs", "targetedRoiTotalMs", "targetedRoiMs", "mergeMs", "totalMs"];
  return Object.fromEntries(stages.map((stage) => {
    const values = results.map((result) => Number(result.performance?.[stage])).filter((value) => Number.isFinite(value));
    return [stage, values.length ? {
      samples: values.length,
      average: values.reduce((sum, value) => sum + value, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values)
    } : null];
  }));
}

async function run() {
  const samples = sampleFiles();
  if (!samples.length) {
    console.error("OCR benchmark BLOCKED: samples-private/ 不存在或沒有圖片，未執行任何 sample。");
    process.exitCode = 2;
    return;
  }
  const groundTruth = loadGroundTruth();
  const missingTruth = samples.map((samplePath) => basename(samplePath)).filter((filename) => !validGroundTruthEntry(groundTruth[filename]));
  if (missingTruth.length) throw new Error(`ground truth 缺少或 schema 不完整：${missingTruth.join(", ")}`);

  const batchId = `TLOCAL-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const uploadDir = join(UPLOADS_DIR, batchId);
  await mkdir(uploadDir, { recursive: true });
  const results = [];

  for (const samplePath of samples) {
    const filename = basename(samplePath);
    const storedPath = join(uploadDir, filename);
    await copyFile(samplePath, storedPath);
    const record = {
      id: `${batchId}-${results.length + 1}`,
      batchId,
      filename,
      imagePath: toDataRelativePath(storedPath)
    };
    const expected = normalizeExpected(groundTruth[filename]);
    const startedAt = performance.now();
    try {
      const predictedRecord = await processInvoiceRecord(record, { provider: process.env.OCR_PROVIDER || "hybrid" });
      const processingMs = performance.now() - startedAt;
      const predicted = normalizePredicted(predictedRecord);
      const comparison = compareSample(expected, predicted);
      const manualReview = predictedRecord.reviewStatus !== "AUTO_OK" || ["need_review", "provider_unavailable", "failed"].includes(predictedRecord.processingStatus);
      const providerFailure = predictedRecord.providerStatus === "provider_unavailable" || predictedRecord.processingStatus === "provider_unavailable" || predictedRecord.processingStatus === "failed";
      results.push({
        filename,
        processingStatus: predictedRecord.processingStatus,
        reviewStatus: predictedRecord.reviewStatus || "UNKNOWN",
        providerStatus: predictedRecord.providerStatus || "UNKNOWN",
        manualReview,
        providerFailure,
        processingMs,
        performance: predictedRecord.debug?.performance || {},
        expected,
        predicted,
        comparison,
        debug: predictedRecord.debug?.ocrJsonPath || ""
      });
    } catch (error) {
      const processingMs = performance.now() - startedAt;
      const predicted = normalizePredicted({});
      results.push({
        filename,
        processingStatus: "failed",
        reviewStatus: "FAILED",
        providerStatus: "failed",
        manualReview: true,
        providerFailure: true,
        processingMs,
        performance: {},
        expected,
        predicted,
        comparison: compareSample(expected, predicted),
        debug: "",
        error: error?.message || "OCR failed"
      });
    }
  }

  for (const result of results) result.rootCauses = classifyRootCauses(result);
  const total = results.length;
  const successfullyProcessed = results.filter((result) => result.processingStatus !== "failed").length;
  const zeroEditConfirmable = results.filter((result) => result.comparison.exactMatch && result.reviewStatus === "AUTO_OK" && result.processingStatus === "done" && !result.providerFailure).length;
  const metrics = {
    totalSamples: total,
    successfullyProcessed,
    providerFailures: results.filter((result) => result.providerFailure).length,
    providerFailureRate: total ? results.filter((result) => result.providerFailure).length / total : null,
    invoiceNumber: metricForField(results, "invoiceNumber"),
    buyerTaxId: metricForField(results, "buyerTaxId"),
    quantity: {
      correct: results.reduce((sum, result) => sum + result.comparison.items.expectedCount - result.comparison.items.exactRows, 0) === 0 ? results.reduce((sum, result) => sum + result.comparison.items.exactRows, 0) : results.reduce((sum, result) => sum + result.comparison.items.exactRows, 0),
      total: results.reduce((sum, result) => sum + result.comparison.items.expectedCount, 0),
      accuracy: results.reduce((sum, result) => sum + result.comparison.items.expectedCount, 0) ? results.reduce((sum, result) => sum + result.comparison.items.exactRows, 0) / results.reduce((sum, result) => sum + result.comparison.items.expectedCount, 0) : null
    },
    unitPrice: {
      correct: results.reduce((sum, result) => sum + result.expected.items.filter((item, index) => result.predicted.items[index]?.unitPrice === item.unitPrice).length, 0),
      total: results.reduce((sum, result) => sum + result.expected.items.length, 0),
      accuracy: results.reduce((sum, result) => sum + result.expected.items.length, 0) ? results.reduce((sum, result) => sum + result.expected.items.filter((item, index) => result.predicted.items[index]?.unitPrice === item.unitPrice).length, 0) / results.reduce((sum, result) => sum + result.expected.items.length, 0) : null
    },
    salesAmount: metricForField(results, "salesAmount"),
    taxAmount: metricForField(results, "taxAmount"),
    totalAmount: metricForField(results, "totalAmount"),
    lineItemExactMatch: {
      correct: results.filter((result) => result.comparison.items.exactMatch).length,
      total,
      accuracy: total ? results.filter((result) => result.comparison.items.exactMatch).length / total : null
    },
    lineItemCompleteness: {
      average: total ? results.reduce((sum, result) => sum + result.comparison.items.completeness, 0) / total : null,
      exactCompleteSamples: results.filter((result) => result.comparison.items.completeness === 1).length,
      total
    },
    fieldAccuracy: total ? results.reduce((sum, result) => sum + result.comparison.fieldAccuracy, 0) / total : null,
    reviewRecommendedRate: total ? results.filter((result) => result.reviewStatus === "REVIEW_RECOMMENDED").length / total : null,
    reviewRequiredRate: total ? results.filter((result) => ["REVIEW_REQUIRED", "INVALID"].includes(result.reviewStatus)).length / total : null,
    zeroEditConfirmationRate: total ? zeroEditConfirmable / total : null,
    zeroEditConfirmable,
    averageProcessingMs: total ? results.reduce((sum, result) => sum + result.processingMs, 0) / total : null,
    stagePerformance: stagePerformanceSummary(results),
    paddleInvocation: {
      fullPageTotal: results.reduce((sum, result) => sum + Number(result.performance?.fullPagePaddleOcrInvocationCount || 0), 0),
      fullPageAveragePerSample: total ? results.reduce((sum, result) => sum + Number(result.performance?.fullPagePaddleOcrInvocationCount || 0), 0) / total : 0,
      targetedTotal: results.reduce((sum, result) => sum + Number(result.performance?.targetedRoiInvocationCount || 0), 0),
      targetedAveragePerSample: total ? results.reduce((sum, result) => sum + Number(result.performance?.targetedRoiInvocationCount || 0), 0) / total : 0,
      samplesWithTargetedRecovery: results.filter((result) => Number(result.performance?.targetedRoiInvocationCount || 0) > 0).length
    },
    rootCauses: rootCauseCounts(results)
  };
  const failureMatrix = results.map((result) => ({
    filename: result.filename,
    processed: result.processingStatus !== "failed",
    processingStatus: result.processingStatus,
    processingMs: result.processingMs,
    providerStatus: result.providerStatus,
    reviewStatus: result.reviewStatus,
    fieldResults: result.comparison.fieldResults,
    missingFields: result.comparison.missingFields,
    falsePositiveFields: result.comparison.falsePositiveFields,
    lineItemExactMatch: result.comparison.items.exactMatch,
    lineItemCompleteness: result.comparison.items.completeness,
    performance: result.performance,
    rootCauses: result.rootCauses,
    error: result.error || ""
  }));
  const output = {
    generatedAt: new Date().toISOString(),
    samplesDir,
    groundTruthPath,
    metrics,
    failureMatrix,
    results
  };
  await mkdir(benchmarkDir, { recursive: true });
  const outputPath = join(benchmarkDir, `ocr-results-${output.generatedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}.json`);
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await writeFile(join(benchmarkDir, "latest.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, metrics, failureMatrix }, null, 2));
}

await run();
