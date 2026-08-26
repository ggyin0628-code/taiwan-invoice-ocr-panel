import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { processInvoiceRecord } from "../lib/server/processInvoice.js";
import { fromDataRelativePath, toDataRelativePath, UPLOADS_DIR } from "../lib/server/paths.js";

const root = process.cwd();
const samplesDir = process.env.OCR_SAMPLES_DIR || join(root, "samples-private");
const groundTruthPath = process.env.OCR_GROUND_TRUTH || join(root, "ground-truth-private.json");
const documentGroupingPath = process.env.OCR_DOCUMENT_GROUPING || join(root, "document-grouping-private.json");
const documentGroundTruthPath = process.env.OCR_DOCUMENT_GROUND_TRUTH || join(root, "document-ground-truth-private.json");
const benchmarkDir = process.env.OCR_BENCHMARK_DIR || join(root, ".ocr-benchmark");
const supportedImage = /\.(jpe?g|png|webp|tiff?)$/i;
const scalarFields = ["invoiceNumber", "buyerTaxId", "salesAmount", "taxAmount", "totalAmount"];
const itemFields = ["itemName", "quantity", "unitPrice", "amount"];
const rootCauseLabels = [
  "document detection", "orientation", "perspective correction", "OCR recognition", "layout resolver",
  "field resolver", "row grouping", "invoice number", "tax ID", "quantity", "unit price",
  "formula validation", "provider unavailable", "other"
];

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, "").trim();
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
    amount: normalizeNumber(item?.amount ?? item?.salesAmount)
  }));
}

function normalizeExpected(expected = {}) {
  return {
    invoiceNumber: normalizeText(expected.invoiceNumber),
    buyerTaxId: normalizeText(expected.buyerTaxId ?? expected.taxId),
    items: normalizeItems(expected.items ?? expected.expectedLineItems),
    salesAmount: normalizeNumber(expected.salesAmount ?? expected.subtotal),
    taxAmount: normalizeNumber(expected.taxAmount ?? expected.tax),
    totalAmount: normalizeNumber(expected.totalAmount ?? expected.total)
  };
}

function normalizePredicted(record = {}) {
  return {
    invoiceNumber: normalizeText(record.invoiceNumber ?? record.invoiceNo),
    buyerTaxId: normalizeText(record.taxId ?? record.buyerTaxId),
    items: normalizeItems(record.items),
    salesAmount: normalizeNumber(record.salesAmount ?? record.amount),
    taxAmount: normalizeNumber(record.taxAmount ?? record.tax),
    totalAmount: normalizeNumber(record.totalAmount ?? record.total)
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

function loadJson(path, label) {
  if (!existsSync(path)) throw new Error(`找不到 ${label}：${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadGroundTruth() {
  const raw = loadJson(groundTruthPath, "ground truth");
  if (Array.isArray(raw)) return Object.fromEntries(raw.map((entry) => [entry.filename, entry]));
  if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") return raw.entries;
  return raw && typeof raw === "object" ? raw : {};
}

function loadDocumentGrouping() {
  const raw = loadJson(documentGroupingPath, "document grouping");
  const documents = Array.isArray(raw) ? raw : raw.documents;
  if (!Array.isArray(documents) || !documents.length) throw new Error(`document grouping schema 不完整：${documentGroupingPath}`);
  const imageToDocument = {};
  for (const document of documents) {
    const documentId = String(document.documentId || "");
    const images = document.sourceImageIds || document.sourcePageIds || document.images || [];
    if (!documentId || !Array.isArray(images) || !images.length) throw new Error("document grouping 含無效 document entry");
    for (const image of images) imageToDocument[basename(String(image))] = documentId;
  }
  return { documents, imageToDocument };
}

function loadDocumentGroundTruth() {
  const raw = loadJson(documentGroundTruthPath, "document ground truth");
  const documents = Array.isArray(raw) ? raw : raw.documents;
  if (!Array.isArray(documents) || !documents.length) throw new Error(`document ground truth schema 不完整：${documentGroundTruthPath}`);
  return Object.fromEntries(documents.map((entry) => [String(entry.documentId), normalizeExpected(entry)]));
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
    ? predictedItems.slice(0, expectedCount).filter((item) => itemFields.every((field) => hasValue(item[field]))).length
    : predictedCount === 0 ? 1 : 0;
  const exactRows = expectedItems.filter((expected, index) => predictedItems[index] && itemFields.every((field) => expected[field] === predictedItems[index][field])).length;
  return {
    exactMatch: JSON.stringify(expectedItems) === JSON.stringify(predictedItems),
    expectedCount,
    predictedCount,
    exactRows,
    exactRowRate: expectedCount ? exactRows / expectedCount : predictedCount === 0 ? 1 : 0,
    completeness: expectedCount ? completeRows / expectedCount : predictedCount === 0 ? 1 : 0,
    missingRows: Math.max(0, expectedCount - predictedCount),
    extraRows: Math.max(0, predictedCount - expectedCount)
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
  try { return JSON.parse(readFileSync(fromDataRelativePath(path), "utf8")); } catch { return null; }
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
  if (["salesAmount", "taxAmount", "totalAmount"].some((field) => comparison.fieldResults[field] === false)) causes.add("formula validation");
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
  const correct = eligible.filter((result) => result.comparison.fieldResults[field]).length;
  return { correct, total: eligible.length, accuracy: eligible.length ? correct / eligible.length : null };
}

function cellMetric(results, field) {
  let correct = 0;
  let total = 0;
  for (const result of results) {
    const expectedItems = result.expected.items || [];
    const predictedItems = result.predicted.items || [];
    for (let index = 0; index < expectedItems.length; index += 1) {
      total += 1;
      if (predictedItems[index] && expectedItems[index][field] === predictedItems[index][field]) correct += 1;
    }
  }
  return { correct, total, accuracy: total ? correct / total : null };
}

function rootCauseCounts(results) {
  const counts = Object.fromEntries(rootCauseLabels.map((label) => [label, 0]));
  for (const result of results) for (const cause of result.rootCauses || []) counts[cause] = (counts[cause] || 0) + 1;
  return counts;
}

function stagePerformanceSummary(results) {
  const stages = ["intakeMs", "preprocessMs", "localOcrMs", "regionOcrMs", "identityResolverMs", "paddleOcrMs", "targetedRoiPreprocessMs", "targetedRoiOcrMs", "targetedRoiTotalMs", "targetedRoiMs", "targetedTablePreprocessMs", "targetedTableOcrMs", "targetedTableTotalMs", "targetedTableMs", "mergeMs", "totalMs"];
  return Object.fromEntries(stages.map((stage) => {
    const values = results.map((result) => Number(result.performance?.[stage])).filter((value) => Number.isFinite(value));
    return [stage, values.length ? { samples: values.length, average: values.reduce((sum, value) => sum + value, 0) / values.length, min: Math.min(...values), max: Math.max(...values) } : null];
  }));
}

function aggregateMetrics(results, level) {
  const total = results.length;
  const exactComplete = results.filter((result) => result.comparison.items.completeness === 1).length;
  const exactLines = results.filter((result) => result.comparison.items.exactMatch).length;
  const totalExpectedRows = results.reduce((sum, result) => sum + result.expected.items.length, 0);
  const totalExactRows = results.reduce((sum, result) => sum + result.comparison.items.exactRows, 0);
  const totalMissingRows = results.reduce((sum, result) => sum + result.comparison.items.missingRows, 0);
  const totalExtraRows = results.reduce((sum, result) => sum + result.comparison.items.extraRows, 0);
  const processing = results.map((result) => Number(result.processingMs)).filter(Number.isFinite);
  const metrics = {
    level,
    totalUnits: total,
    successfullyProcessed: results.filter((result) => result.processingStatus !== "failed").length,
    providerFailures: results.filter((result) => result.providerFailure).length,
    providerFailureRate: total ? results.filter((result) => result.providerFailure).length / total : null,
    invoiceNumber: metricForField(results, "invoiceNumber"),
    buyerTaxId: metricForField(results, "buyerTaxId"),
    quantity: cellMetric(results, "quantity"),
    unitPrice: cellMetric(results, "unitPrice"),
    itemName: cellMetric(results, "itemName"),
    amountCell: cellMetric(results, "amount"),
    salesAmount: metricForField(results, "salesAmount"),
    taxAmount: metricForField(results, "taxAmount"),
    totalAmount: metricForField(results, "totalAmount"),
    lineItemExactMatch: { correct: exactLines, total, accuracy: total ? exactLines / total : null },
    lineItemCompleteness: { average: total ? results.reduce((sum, result) => sum + result.comparison.items.completeness, 0) / total : null, exactCompleteUnits: exactComplete, total },
    expectedRowCount: totalExpectedRows,
    exactRowCells: { correct: totalExactRows, total: totalExpectedRows, accuracy: totalExpectedRows ? totalExactRows / totalExpectedRows : null },
    missingRows: totalMissingRows,
    extraRows: totalExtraRows,
    rowCountExact: { correct: results.filter((result) => result.comparison.items.expectedCount === result.comparison.items.predictedCount).length, total, accuracy: total ? results.filter((result) => result.comparison.items.expectedCount === result.comparison.items.predictedCount).length / total : null },
    exactMatch: { correct: results.filter((result) => result.comparison.exactMatch).length, total, accuracy: total ? results.filter((result) => result.comparison.exactMatch).length / total : null },
    fieldAccuracy: total ? results.reduce((sum, result) => sum + result.comparison.fieldAccuracy, 0) / total : null,
    reviewRecommendedRate: total ? results.filter((result) => result.reviewStatus === "REVIEW_RECOMMENDED").length / total : null,
    reviewRequiredRate: total ? results.filter((result) => ["REVIEW_REQUIRED", "INVALID"].includes(result.reviewStatus)).length / total : null,
    zeroEditConfirmationRate: total ? results.filter((result) => result.comparison.exactMatch && result.reviewStatus === "AUTO_OK" && result.processingStatus === "done" && !result.providerFailure).length / total : null,
    averageProcessingMs: processing.length ? processing.reduce((sum, value) => sum + value, 0) / processing.length : null
  };
  return metrics;
}

function itemSignature(item) {
  return [item.itemName, item.quantity, item.unitPrice, item.amount].map((value) => String(value ?? "")).join("|");
}

function mergeDocumentItems(pageResults) {
  const merged = [];
  const provenance = [];
  for (const page of pageResults) {
    for (const [index, item] of page.predicted.items.entries()) {
      const signature = itemSignature(item);
      let target = merged.findIndex((candidate) => candidate.signature === signature);
      if (target < 0) {
        target = merged.length;
        merged.push({ ...item, signature, sourcePages: [page.filename], sourceRows: [index + 1], agreement: 1, conflicts: [] });
      } else {
        merged[target].agreement += 1;
        merged[target].sourcePages.push(page.filename);
        merged[target].sourceRows.push(index + 1);
      }
    }
  }
  for (const item of merged) {
    const { signature, sourcePages, sourceRows, ...canonical } = item;
    provenance.push({ sourcePageCount: sourcePages.length, sourceRowCount: sourceRows.length, agreement: item.agreement, conflictCount: item.conflicts.length });
    Object.assign(item, { sourcePages, sourceRows });
  }
  return { items: merged.map(({ signature, sourcePages, sourceRows, agreement, conflicts, ...item }) => ({ ...item, sourcePages, sourceRows, agreement, conflicts })), provenance };
}

function mergeDocumentResults(grouping, documentTruth, imageResults) {
  const byFilename = Object.fromEntries(imageResults.map((result) => [result.filename, result]));
  const documents = [];
  for (const group of grouping.documents) {
    const documentId = String(group.documentId);
    const pageIds = group.sourceImageIds || group.sourcePageIds || group.images || [];
    const pageResults = pageIds.map((page) => byFilename[basename(String(page))]).filter(Boolean);
    const expected = documentTruth[documentId];
    if (!expected) throw new Error(`document ground truth 缺少 ${documentId}`);
    const mergedItems = mergeDocumentItems(pageResults);
    const first = pageResults[0] || {};
    const predicted = {
      invoiceNumber: first.predicted?.invoiceNumber || "",
      buyerTaxId: first.predicted?.buyerTaxId || "",
      items: mergedItems.items,
      salesAmount: first.predicted?.salesAmount ?? null,
      taxAmount: first.predicted?.taxAmount ?? null,
      totalAmount: first.predicted?.totalAmount ?? null
    };
    const comparison = compareSample(expected, predicted);
    documents.push({ documentId, sourceImageIds: pageIds.map(String), observationCount: pageResults.length, expected, predicted, comparison, mergeEvidence: mergedItems.provenance });
  }
  return documents;
}

function invocationSummary(results) {
  const sum = (key) => results.reduce((total, result) => total + Number(result.performance?.[key] || 0), 0);
  const total = results.length;
  return {
    fullPageTotal: sum("fullPagePaddleOcrInvocationCount"),
    fullPageAveragePerSample: total ? sum("fullPagePaddleOcrInvocationCount") / total : 0,
    targetedRoiTotal: sum("targetedRoiInvocationCount"),
    targetedTableTotal: sum("targetedTableInvocationCount"),
    samplesWithTargetedRoiRecovery: results.filter((result) => Number(result.performance?.targetedRoiInvocationCount || 0) > 0).length,
    samplesWithTargetedTableRecovery: results.filter((result) => Number(result.performance?.targetedTableInvocationCount || 0) > 0).length
  };
}

async function run() {
  const samples = sampleFiles();
  if (!samples.length) {
    console.error("OCR benchmark BLOCKED: samples-private/ 不存在或沒有圖片，未執行任何 sample。");
    process.exitCode = 2;
    return;
  }
  const groundTruth = loadGroundTruth();
  const grouping = loadDocumentGrouping();
  const documentTruth = loadDocumentGroundTruth();
  const missingTruth = samples.map((samplePath) => basename(samplePath)).filter((filename) => !validGroundTruthEntry(normalizeExpected(groundTruth[filename])));
  if (missingTruth.length) throw new Error(`ground truth 缺少或 schema 不完整：${missingTruth.join(", ")}`);
  const missingGrouping = samples.map((samplePath) => basename(samplePath)).filter((filename) => !grouping.imageToDocument[filename]);
  if (missingGrouping.length) throw new Error(`document grouping 缺少 image：${missingGrouping.join(", ")}`);

  const batchId = `TLOCAL-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const uploadDir = join(UPLOADS_DIR, batchId);
  await mkdir(uploadDir, { recursive: true });
  const results = [];
  for (const samplePath of samples) {
    const filename = basename(samplePath);
    const storedPath = join(uploadDir, filename);
    await copyFile(samplePath, storedPath);
    const record = { id: `${batchId}-${results.length + 1}`, batchId, filename, imagePath: toDataRelativePath(storedPath) };
    const expected = normalizeExpected(groundTruth[filename]);
    const startedAt = performance.now();
    try {
      const predictedRecord = await processInvoiceRecord(record, { provider: process.env.OCR_PROVIDER || "hybrid" });
      const processingMs = performance.now() - startedAt;
      const predicted = normalizePredicted(predictedRecord);
      const comparison = compareSample(expected, predicted);
      const manualReview = predictedRecord.reviewStatus !== "AUTO_OK" || ["need_review", "provider_unavailable", "failed"].includes(predictedRecord.processingStatus);
      const providerFailure = predictedRecord.providerStatus === "provider_unavailable" || predictedRecord.processingStatus === "provider_unavailable" || predictedRecord.processingStatus === "failed";
      results.push({ filename, documentId: grouping.imageToDocument[filename], processingStatus: predictedRecord.processingStatus, reviewStatus: predictedRecord.reviewStatus || "UNKNOWN", providerStatus: predictedRecord.providerStatus || "UNKNOWN", manualReview, providerFailure, processingMs, performance: predictedRecord.debug?.performance || {}, expected, predicted, comparison, debug: predictedRecord.debug?.ocrJsonPath || "" });
    } catch (error) {
      const processingMs = performance.now() - startedAt;
      const predicted = normalizePredicted({});
      results.push({ filename, documentId: grouping.imageToDocument[filename], processingStatus: "failed", reviewStatus: "FAILED", providerStatus: "failed", manualReview: true, providerFailure: true, processingMs, performance: {}, expected, predicted, comparison: compareSample(expected, predicted), debug: "", error: error?.message || "OCR failed" });
    }
  }
  for (const result of results) result.rootCauses = classifyRootCauses(result);
  const documentResults = mergeDocumentResults(grouping, documentTruth, results);
  const metrics = {
    metricSchemaVersion: "r2-recovered-v1",
    imageLevelMetrics: aggregateMetrics(results, "image"),
    documentLevelMetrics: aggregateMetrics(documentResults, "document"),
    totalSamples: results.length,
    successfullyProcessed: results.filter((result) => result.processingStatus !== "failed").length,
    providerFailures: results.filter((result) => result.providerFailure).length,
    providerFailureRate: results.length ? results.filter((result) => result.providerFailure).length / results.length : null,
    averageProcessingMs: results.length ? results.reduce((sum, result) => sum + result.processingMs, 0) / results.length : null,
    stagePerformance: stagePerformanceSummary(results),
    paddleInvocation: invocationSummary(results),
    rootCauses: rootCauseCounts(results),
    documentCount: documentResults.length,
    canonicalRowCount: documentResults.reduce((sum, result) => sum + result.expected.items.length, 0)
  };
  const failureMatrix = results.map((result) => ({ filename: result.filename, documentId: result.documentId, processed: result.processingStatus !== "failed", processingStatus: result.processingStatus, processingMs: result.processingMs, providerStatus: result.providerStatus, reviewStatus: result.reviewStatus, fieldResults: result.comparison.fieldResults, missingFields: result.comparison.missingFields, falsePositiveFields: result.comparison.falsePositiveFields, lineItemExactMatch: result.comparison.items.exactMatch, lineItemCompleteness: result.comparison.items.completeness, missingRows: result.comparison.items.missingRows, extraRows: result.comparison.items.extraRows, performance: result.performance, rootCauses: result.rootCauses, error: result.error || "" }));
  const output = { generatedAt: new Date().toISOString(), samplesDir, groundTruthPath, documentGroupingPath, documentGroundTruthPath, metrics, failureMatrix, results, documentResults };
  await mkdir(benchmarkDir, { recursive: true });
  const outputPath = join(benchmarkDir, `ocr-results-${output.generatedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}.json`);
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await writeFile(join(benchmarkDir, "latest.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, metrics, failureMatrix, documentResults }, null, 2));
}

await run();
