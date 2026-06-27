import { mkdirSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import sharp from "sharp";
import { detectDocumentRectangle } from "../imagePreprocess/documentDetector.js";
import { perspectiveCorrect } from "../imagePreprocess/perspectiveCorrect.js";
import { CANONICAL_SIZE } from "../templates/taiwanTriplicateInvoiceTemplate.js";
import { extractAnchoredFields } from "./anchorExtractor.js";
import { DEBUG_DIR, fromDataRelativePath, PROCESSED_DIR, toDataRelativePath } from "./paths.js";
import { runTesseractOcr, runTesseractRegions } from "./tesseractOcr.js";
import { mergeVisionAndTesseract, runMacosVisionImage, runMacosVisionRegions } from "./macosVisionOcr.js";
import { detectLayoutAnchor, resolveTemplate } from "./templates.js";
import { recognizeInvoiceWithPaddleOcr } from "./paddleOcrProvider.js";
import { recognizeInvoiceWithHybrid } from "./hybridInvoiceRecognizer.js";
import { mergeInvoiceRecognitionResults, validateProviderCandidate } from "./mergeInvoiceRecognitionResults.js";

async function cropBlueInvoice(buffer) {
  const image = sharp(buffer).rotate();
  const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
  if (info.height < info.width * 0.95) return { buffer, crop: null };
  const rowBlue = new Array(info.height).fill(0);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const index = (y * info.width + x) * info.channels;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      if (b > 85 && b > r * 1.12 && b > g * 1.04 && r < 190) rowBlue[y] += 1;
    }
  }
  const rowThreshold = Math.max(4, Math.round(info.width * 0.01));
  const bands = [];
  let start = -1;
  let score = 0;
  for (let y = 0; y < info.height; y += 1) {
    if (rowBlue[y] >= rowThreshold) {
      if (start < 0) {
        start = y;
        score = 0;
      }
      score += rowBlue[y];
    } else if (start >= 0) {
      if (y - start > info.height * 0.08) bands.push({ top: start, bottom: y - 1, score });
      start = -1;
      score = 0;
    }
  }
  if (start >= 0) bands.push({ top: start, bottom: info.height - 1, score });
  const upperBands = bands.filter((band) => band.top < info.height * 0.62);
  const best = (upperBands.length ? upperBands : bands).sort((a, b) => b.score - a.score)[0];
  if (!best) return { buffer, crop: null };
  const top = Math.max(0, best.top - Math.round(info.height * 0.08));
  const bottom = Math.min(info.height - 1, best.bottom + Math.round(info.height * 0.055));
  const crop = { left: 0, top, width: info.width, height: bottom - top + 1 };
  const separatedBands = bands.filter((band) => band.bottom - band.top > info.height * 0.08);
  if (crop.width < info.width * 0.4 || crop.height < info.height * 0.18) return { buffer, crop: null };
  if (crop.height < info.height * 0.45 && separatedBands.length < 2) return { buffer, crop: null };
  return { buffer: await image.clone().extract(crop).jpeg({ quality: 95 }).toBuffer(), crop };
}

function outputPaths(record) {
  const batchId = record.batchId || "default";
  const name = parse(record.filename || record.imagePath || "invoice.jpg").name.replace(/[^\w.-]+/g, "_");
  const processedDir = join(PROCESSED_DIR, batchId);
  const debugDir = join(DEBUG_DIR, batchId);
  mkdirSync(processedDir, { recursive: true });
  mkdirSync(debugDir, { recursive: true });
  return {
    gray: join(debugDir, `${name}.gray.jpg`),
    binary: join(debugDir, `${name}.binary.jpg`),
    corrected: join(processedDir, `${name}.corrected.jpg`),
    bbox: join(debugDir, `${name}.bbox.jpg`),
    ocrJson: join(debugDir, `${name}.ocr.json`),
    regionCrop: (field) => join(debugDir, `${name}.${field}.crop.jpg`)
  };
}

async function preprocessImages(sourceBuffer, paths) {
  const sourceImage = sharp(sourceBuffer).rotate();
  const grayBuffer = await sourceImage.clone().grayscale().normalize().jpeg({ quality: 92 }).toBuffer();
  const binaryBuffer = await sourceImage.clone().grayscale().normalize().median(1).threshold(168).jpeg({ quality: 92 }).toBuffer();
  writeFileSync(paths.gray, grayBuffer);
  writeFileSync(paths.binary, binaryBuffer);
  const detection = await detectDocumentRectangle(sourceImage);
  const corrected = await perspectiveCorrect(sourceImage, detection, CANONICAL_SIZE);
  const correctedBuffer = await sharp(corrected.buffer)
    .grayscale()
    .normalize()
    .linear(1.25, -8)
    .resize({ width: CANONICAL_SIZE.width, withoutEnlargement: true })
    .jpeg({ quality: 94 })
    .toBuffer();
  writeFileSync(paths.corrected, correctedBuffer);
  return { grayBuffer, binaryBuffer, correctedBuffer, detection };
}

async function drawBboxOverlay(imageBuffer, selectedWords, outputPath, regions = []) {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  const palette = {
    invoiceNumber: "#2563eb",
    taxId: "#16a34a",
    quantity: "#f97316",
    unitPrice: "#dc2626"
  };
  const boxes = Object.entries(selectedWords || {}).flatMap(([field, words]) => (Array.isArray(words) ? words : []).map((word) => ({ ...word, field }))).map((word) => {
    const color = palette[word.field] || "#dc2626";
    const label = `${word.field}: ${String(word.text).replace(/[<>&]/g, "")}`;
    return `<rect x="${word.left}" y="${word.top}" width="${word.width}" height="${word.height}" fill="none" stroke="${color}" stroke-width="3"/><text x="${word.left}" y="${Math.max(14, word.top - 4)}" font-size="14" fill="${color}" font-family="Arial">${label}</text>`;
  }).join("");
  const templateBoxes = regions.map((region) => {
    const color = palette[region.name] || "#0f766e";
    return `<rect x="${region.left}" y="${region.top}" width="${region.width}" height="${region.height}" fill="rgba(15,118,110,0.04)" stroke="${color}" stroke-width="3" stroke-dasharray="10 6"/><text x="${region.left}" y="${Math.max(16, region.top - 8)}" font-size="16" fill="${color}" font-family="Arial" font-weight="700">template:${region.name}</text>`;
  }).join("");
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${templateBoxes}${boxes}</svg>`;
  const output = await sharp(imageBuffer).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 92 }).toBuffer();
  writeFileSync(outputPath, output);
}

function mapRegionToCurrentAnchor(region, referenceAnchor, currentAnchor) {
  if (!region || !referenceAnchor || !currentAnchor) return region;
  const refW = referenceAnchor.w || 1;
  const refH = referenceAnchor.h || 1;
  return {
    x: currentAnchor.x + ((region.x - referenceAnchor.x) / refW) * currentAnchor.w,
    y: currentAnchor.y + ((region.y - referenceAnchor.y) / refH) * currentAnchor.h,
    w: (region.w / refW) * currentAnchor.w,
    h: (region.h / refH) * currentAnchor.h
  };
}

function clampRegion(region) {
  const x = Math.max(0, Math.min(0.99, Number(region.x) || 0));
  const y = Math.max(0, Math.min(0.99, Number(region.y) || 0));
  const w = Math.max(0.01, Math.min(1 - x, Number(region.w) || 0.01));
  const h = Math.max(0.01, Math.min(1 - y, Number(region.h) || 0.01));
  return { x, y, w, h };
}

function templateRegions(profile, imageWidth, imageHeight, _currentAnchor) {
  if (!profile?.fields) return [];
  const configs = [
    ["invoiceNumber", profile.fields.invoiceNumber, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "7"],
    ["taxId", profile.fields.taxId, "0123456789", "7"],
    ["quantity", profile.fields.quantity, "0123456789", "6"],
    ["unitPrice", profile.fields.unitPrice, "0123456789,¢SOoIl|", "6"]
  ];
  return configs.filter(([, region]) => region).map(([name, region, whitelist, psm]) => {
    const mapped = clampRegion(region);
    const left = Math.max(0, Math.min(imageWidth - 1, Math.round(mapped.x * imageWidth)));
    const top = Math.max(0, Math.min(imageHeight - 1, Math.round(mapped.y * imageHeight)));
    const width = Math.max(1, Math.min(imageWidth - left, Math.round(mapped.w * imageWidth)));
    const height = Math.max(1, Math.min(imageHeight - top, Math.round(mapped.h * imageHeight)));
    return { name, left, top, width, height, whitelist, psm, scale: 3 };
  });
}

async function saveRegionCrops(imageBuffer, regions, paths) {
  const crops = {};
  for (const region of regions) {
    const cropPath = paths.regionCrop(region.name);
    const buffer = await sharp(imageBuffer)
      .extract({ left: region.left, top: region.top, width: region.width, height: region.height })
      .grayscale()
      .normalize()
      .linear(region.linearA || 1.65, region.linearB ?? -18)
      .resize({ width: Math.max(region.width * 3, region.width), withoutEnlargement: false })
      .jpeg({ quality: 94 })
      .toBuffer();
    writeFileSync(cropPath, buffer);
    region.cropImagePath = toDataRelativePath(cropPath);
    crops[region.name] = region.cropImagePath;
  }
  return crops;
}

const MODES = new Set(["local", "tesseract", "paddleocr", "google-vision", "openai-vision", "hybrid", "manual"]);

function configuredDefaultMode() {
  const provider = String(process.env.OCR_PROVIDER || "local").toLowerCase();
  if (MODES.has(provider)) return provider;
  if (provider === "paddle_ocr") return "paddleocr";
  if (provider === "google_vision") return "google-vision";
  if (provider === "openai_vision") return "openai-vision";
  return "local";
}

function effectiveMode(mode) {
  const requested = String(mode || configuredDefaultMode()).toLowerCase();
  return MODES.has(requested) ? requested : "local";
}

function emptyManualResult(record, paths, reason = "manual mode") {
  const recognitionResult = {
    invoiceNo: { value: null, rawText: "", source: "manual", confidence: 0, status: "manual_required", reason },
    buyerTaxId: { value: null, rawText: "", source: "manual", confidence: 0, status: "manual_required", reason },
    items: [],
    amount: { value: null, rawText: "", source: "formula", confidence: 0, status: "manual_required", reason },
    tax: { value: null, rawText: "", source: "formula", confidence: 0, status: "manual_required", reason },
    total: { value: null, rawText: "", source: "formula", confidence: 0, status: "manual_required", reason },
    overallStatus: "needs_review",
    warnings: [reason],
    debug: { mode: "manual", providers: [] }
  };
  const validationErrors = [
    { field: "invoiceNumber", reason: "需人工輸入", status: "manual_required", source: "manual" },
    { field: "taxId", reason: "需人工輸入", status: "manual_required", source: "manual" },
    { field: "quantity", reason: "需人工輸入", status: "manual_required", source: "manual" },
    { field: "unitPrice", reason: "需人工輸入", status: "manual_required", source: "manual" }
  ];
  const debugJson = {
    originalImagePath: record.imagePath,
    recognitionMode: "manual",
    requestedProvider: "manual",
    actualProvider: "manual",
    providerStatus: "manual_required",
    finalMergedResult: recognitionResult,
    validationErrors
  };
  writeFileSync(paths.ocrJson, `${JSON.stringify(debugJson, null, 2)}\n`, "utf8");
  return {
    invoiceNumber: "",
    taxId: "",
    items: [],
    quantity: "",
    unitPrice: "",
    salesAmount: "",
    taxAmount: "",
    totalAmount: "",
    confirmed: false,
    warnings: [reason],
    confidenceLevel: "low",
    ocrProvider: "manual",
    amountSource: "none",
    confidence: {},
    fieldSources: { invoiceNumber: "manual", taxId: "manual", quantity: "manual", unitPrice: "manual", salesAmount: "formula", taxAmount: "formula", totalAmount: "formula" },
    fieldStatuses: { invoiceNumber: "manual_required", taxId: "manual_required", quantity: "manual_required", unitPrice: "manual_required", salesAmount: "manual_required", taxAmount: "manual_required", totalAmount: "manual_required" },
    recognitionResult,
    recognitionMode: "manual",
    requestedProvider: "manual",
    actualProvider: "manual",
    providerStatus: "manual_required",
    validationErrors,
    processingStatus: "need_review",
    status: "unconfirmed",
    debug: { ...debugJson, ocrJsonPath: toDataRelativePath(paths.ocrJson) }
  };
}

export async function processInvoiceRecord(record, options = {}) {
  const mode = effectiveMode(options.provider || options.mode);
  const originalPath = fromDataRelativePath(record.imagePath);
  const paths = outputPaths(record);
  if (mode === "manual") return emptyManualResult(record, paths);
  if (mode === "google-vision" || mode === "openai-vision") {
    return emptyManualResult(record, paths, `${mode} disabled: paid cloud OCR is not allowed in this workflow`);
  }

  const originalBuffer = await sharp(originalPath).rotate().jpeg({ quality: 95 }).toBuffer();
  const blueCrop = await cropBlueInvoice(originalBuffer);
  const sourceBuffer = blueCrop.buffer;
  const processed = await preprocessImages(sourceBuffer, paths);

  if (mode === "hybrid") {
    const hybrid = await recognizeInvoiceWithHybrid(paths.corrected);
    const hasErrors = hybrid.meta.validationErrors.length > 0 || hybrid.record.warnings.length > 0;
    const warnings = [...new Set(hybrid.record.warnings || [])];
    const recognitionResult = {
      invoiceNo: { value: hybrid.flatFields.invoiceNumber || null, source: "paddleocr", confidence: hybrid.meta.confidence.invoiceNumber || 0, status: hybrid.meta.fieldStatuses.invoiceNumber || "manual_required" },
      buyerTaxId: { value: hybrid.flatFields.taxId || null, source: "paddleocr", confidence: hybrid.meta.confidence.taxId || 0, status: hybrid.meta.fieldStatuses.taxId || "manual_required" },
      items: hybrid.flatFields.items.map((item) => ({
        name: item.itemName || "",
        quantity: { value: item.quantity ?? null, source: item.source || "paddleocr", confidence: item.confidence || 0, status: item.quantity != null ? "auto" : "manual_required" },
        unitPrice: { value: item.unitPrice ?? null, source: item.source || "paddleocr", confidence: item.confidence || 0, status: item.unitPrice != null ? "auto" : "manual_required" },
        amount: { value: item.amount ?? null, source: "formula", confidence: item.confidence || 0, status: item.amount != null ? "auto" : "manual_required" }
      })),
      amount: { value: hybrid.flatFields.salesAmount || null, source: "formula", confidence: hybrid.meta.confidence.salesAmount || 0, status: hybrid.meta.fieldStatuses.salesAmount || "manual_required" },
      tax: { value: hybrid.flatFields.taxAmount || null, source: "formula", confidence: hybrid.meta.confidence.taxAmount || 0, status: hybrid.meta.fieldStatuses.taxAmount || "manual_required" },
      total: { value: hybrid.flatFields.totalAmount || null, source: "formula", confidence: hybrid.meta.confidence.totalAmount || 0, status: hybrid.meta.fieldStatuses.totalAmount || "manual_required" },
      overallStatus: hasErrors ? "needs_review" : "auto",
      warnings,
      debug: { mode: "hybrid", providers: hybrid.providerEvents }
    };
    const validationErrors = hybrid.meta.validationErrors;
    const debugJson = {
      originalImagePath: record.imagePath,
      grayImagePath: toDataRelativePath(paths.gray),
      binaryImagePath: toDataRelativePath(paths.binary),
      correctedImagePath: toDataRelativePath(paths.corrected),
      blueCrop: blueCrop.crop,
      documentDetection: processed.detection,
      paddleOcrRaw: hybrid.paddleRaw,
      providerEvents: hybrid.providerEvents,
      requestedProvider: mode,
      actualProvider: "hybrid",
      providerStatus: hasErrors ? "manual_required" : "auto",
      finalMergedResult: recognitionResult,
      validatedJson: hybrid.record,
      validationErrors,
      recognitionMode: mode
    };
    writeFileSync(paths.ocrJson, `${JSON.stringify(debugJson, null, 2)}\n`, "utf8");
    return {
      ...hybrid.flatFields,
      confirmed: false,
      ocrProvider: "hybrid",
      amountSource: hybrid.record.amountSource || "none",
      warnings,
      confidenceLevel: hybrid.record.confidenceLevel || (hasErrors ? "low" : "high"),
      confidence: hybrid.meta.confidence,
      fieldSources: hybrid.meta.fieldSources,
      fieldStatuses: hybrid.meta.fieldStatuses,
      recognitionResult,
      recognitionMode: mode,
      requestedProvider: mode,
      actualProvider: "hybrid",
      providerStatus: hasErrors ? "manual_required" : "auto",
      validationErrors,
      processingStatus: hasErrors ? "need_review" : "done",
      status: "unconfirmed",
      correctedImagePath: toDataRelativePath(paths.corrected),
      debug: { ...debugJson, ocrJsonPath: toDataRelativePath(paths.ocrJson) }
    };
  }

  const ocr = await runTesseractOcr(processed.correctedBuffer);
  const visionFullOcr = await runMacosVisionImage(toDataRelativePath(paths.corrected));
  const templateDetection = resolveTemplate({ text: ocr.text, words: ocr.words });
  const layoutAnchor = await detectLayoutAnchor(processed.correctedBuffer);
  const metadata = await sharp(processed.correctedBuffer).metadata();
  const regions = templateRegions(templateDetection.template, metadata.width || CANONICAL_SIZE.width, metadata.height || CANONICAL_SIZE.height, layoutAnchor);
  const regionCrops = await saveRegionCrops(processed.correctedBuffer, regions, paths);
  const visionOcr = regions.length ? await runMacosVisionRegions(regions) : null;
  const tesseractRegionOcr = regions.length ? await runTesseractRegions(processed.correctedBuffer, regions) : null;
  const regionOcr = mergeVisionAndTesseract(visionOcr, tesseractRegionOcr);
  const extracted = extractAnchoredFields({
    words: [...(ocr.words || []), ...(visionFullOcr?.words || [])],
    text: `${ocr.text || ""}\n${visionFullOcr?.text || ""}`,
    regionOcr,
    templateDetection
  });
  await drawBboxOverlay(processed.correctedBuffer, extracted.selectedWords, paths.bbox, regions);
  const localEngine = String(process.env.LOCAL_OCR_ENGINE || "tesseract").toLowerCase();
  const providerEvents = [{
    provider: "local",
    engine: localEngine,
    ok: true,
    error: ["paddleocr", "easyocr"].includes(localEngine) ? `${localEngine} 未安裝於此 Next.js 專案，已使用 macOS Vision + Tesseract 本機備援` : null
  }];
  const candidates = [
    validateProviderCandidate(extracted.fields, {
      source: "macos_vision",
      defaultConfidence: 0.8,
      warnings: providerEvents[0].error ? [providerEvents[0].error] : []
    })
  ];

  let paddleOcr = null;
  const localMerged = mergeInvoiceRecognitionResults({ candidates, mode: "local", providerEvents });
  const localNeedsReview = localMerged.recognitionResult.overallStatus !== "auto";

  if (mode === "paddleocr" || (mode === "hybrid" && localNeedsReview)) {
    paddleOcr = await recognizeInvoiceWithPaddleOcr(paths.corrected, { force: mode === "paddleocr" || mode === "hybrid" });
    providerEvents.push({ provider: "paddleocr", ok: paddleOcr.ok, skipped: paddleOcr.skipped, error: paddleOcr.error || null });
    if (paddleOcr.ok) {
      candidates.unshift(validateProviderCandidate(paddleOcr.result || {}, {
        source: "paddleocr",
        defaultConfidence: paddleOcr.confidence || 0.75,
        warnings: paddleOcr.result?.warnings || []
      }));
    } else if (mode === "paddleocr") {
      providerEvents.push({ provider: "fallback", ok: true, error: "PaddleOCR service 不可用，fallback local" });
    }
  }

  const merged = mergeInvoiceRecognitionResults({
    candidates,
    mode,
    providerEvents
  });
  const providerUnavailable = (
    (mode === "paddleocr" && paddleOcr && !paddleOcr.ok)
  );
  const actualProvider = mode === "manual"
    ? "manual"
    : mode === "hybrid"
      ? "hybrid"
      : paddleOcr?.ok
        ? "paddleocr"
        : "local";
  const hasErrors = merged.meta.validationErrors.length > 0 || merged.recognitionResult.overallStatus !== "auto";
  const validationErrors = [
    ...(providerUnavailable ? [{
      field: "provider",
      reason: `${mode} 不可用，已 fallback local`,
      status: "provider_unavailable",
      source: actualProvider
    }] : []),
    ...merged.meta.validationErrors
  ];
  const debugJson = {
    originalImagePath: record.imagePath,
    grayImagePath: toDataRelativePath(paths.gray),
    binaryImagePath: toDataRelativePath(paths.binary),
    correctedImagePath: toDataRelativePath(paths.corrected),
    bboxImagePath: toDataRelativePath(paths.bbox),
    blueCrop: blueCrop.crop,
    documentDetection: processed.detection,
    templateDetection: {
      reason: templateDetection.reason,
      template: templateDetection.template,
      currentLayoutAnchor: layoutAnchor,
      appliedRegions: regions
    },
    visionFullOcr,
    ocrRawJson: ocr,
    visionOcr,
    tesseractRegionOcr,
    regionOcr,
    regionCrops,
    anchorExtraction: extracted,
    localOcrRawText: `${ocr.text || ""}\n${visionFullOcr?.text || ""}`,
    paddleOcrRaw: paddleOcr?.raw || null,
    paddleOcrResult: paddleOcr?.result || null,
    paddleOcrError: paddleOcr?.error || null,
    providerEvents,
    requestedProvider: mode,
    actualProvider,
    providerStatus: providerUnavailable ? "provider_unavailable" : hasErrors ? "manual_required" : "auto",
    finalMergedResult: merged.recognitionResult,
    validatedJson: merged.recognitionResult,
    validationErrors,
    recognitionMode: mode
  };
  writeFileSync(paths.ocrJson, `${JSON.stringify(debugJson, null, 2)}\n`, "utf8");

  return {
    ...merged.flatFields,
    confirmed: false,
    warnings: merged.recognitionResult.warnings || [],
    confidenceLevel: hasErrors || (merged.recognitionResult.warnings || []).length ? "low" : "high",
    ocrProvider: actualProvider,
    amountSource: merged.flatFields.salesAmount ? "formula" : "none",
    confidence: merged.meta.confidence,
    fieldSources: merged.meta.fieldSources,
    fieldStatuses: merged.meta.fieldStatuses,
    recognitionResult: merged.recognitionResult,
    recognitionMode: mode,
    requestedProvider: mode,
    actualProvider,
    providerStatus: providerUnavailable ? "provider_unavailable" : hasErrors ? "manual_required" : "auto",
    validationErrors,
    processingStatus: providerUnavailable ? "provider_unavailable" : hasErrors ? "need_review" : "done",
    status: "unconfirmed",
    correctedImagePath: toDataRelativePath(paths.corrected),
    debug: {
      ...debugJson,
      ocrJsonPath: toDataRelativePath(paths.ocrJson)
    }
  };
}
