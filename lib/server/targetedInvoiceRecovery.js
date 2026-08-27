import { writeFileSync } from "node:fs";
import sharp from "sharp";
import { detectDocumentRectangle } from "../imagePreprocess/documentDetector.js";
import { resolveBuyerTaxIdentity } from "./identityResolver.js";
import { recognizeInvoiceWithPaddleOcr } from "./paddleOcrProvider.js";

const INVOICE_PATTERN = /^[A-Z]{2}[0-9]{8}$/;
const DEFAULT_INVOICE_REGION = { x: 0.105, y: 0.08, w: 0.25, h: 0.12 };

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function validInvoice(value) {
  return INVOICE_PATTERN.test(String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, ""));
}

function normalizeInvoice(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeConfidence(value) {
  const number = finite(value);
  return number > 1 ? Math.max(0, Math.min(1, number / 100)) : Math.max(0, Math.min(1, number));
}

function mapBbox(bbox, roi, outputWidth, outputHeight) {
  if (!bbox) return null;
  const scaleX = roi.width / Math.max(1, outputWidth);
  const scaleY = roi.height / Math.max(1, outputHeight);
  return {
    x1: Math.round(roi.left + finite(bbox.x1) * scaleX),
    y1: Math.round(roi.top + finite(bbox.y1) * scaleY),
    x2: Math.round(roi.left + finite(bbox.x2) * scaleX),
    y2: Math.round(roi.top + finite(bbox.y2) * scaleY)
  };
}

function mapEvidence(evidence, roi, outputWidth, outputHeight, variant) {
  return (Array.isArray(evidence) ? evidence : []).map((candidate) => ({
    ...candidate,
    bbox: mapBbox(candidate.bbox, roi, outputWidth, outputHeight),
    coordinateSpace: "original-image",
    recoveryVariant: variant,
    recoveryRoi: { ...roi }
  }));
}

function mapIdentityEvidence(identityEvidence, roi, outputWidth, outputHeight, variant) {
  if (!identityEvidence) return identityEvidence;
  const candidates = mapEvidence(identityEvidence.candidates, roi, outputWidth, outputHeight, variant);
  const selected = typeof identityEvidence.selected === "object" && identityEvidence.selected
    ? {
      ...identityEvidence.selected,
      bbox: mapBbox(identityEvidence.selected.bbox, roi, outputWidth, outputHeight),
      coordinateSpace: "original-image",
      recoveryVariant: variant,
      recoveryRoi: { ...roi }
    }
    : identityEvidence.selected;
  return {
    ...identityEvidence,
    candidates,
    selected
  };
}

function rawCandidateFrom(identityEvidence, normalizedCandidate) {
  const first = identityEvidence?.candidates?.[0];
  return first?.rawCandidate || normalizedCandidate || null;
}

function mapProviderField(field, roi, outputWidth, outputHeight, variant) {
  if (!field) return field;
  const mappedEvidence = mapEvidence(field.evidence, roi, outputWidth, outputHeight, variant);
  return {
    ...field,
    evidence: mappedEvidence
  };
}

export function hasCredibleInvoiceCandidate(...values) {
  return values.some((value) => validInvoice(value));
}

export function deriveTargetedInvoiceRoi({ width, height, detection, template } = {}) {
  const imageWidth = Math.max(1, Math.round(finite(width, 1200)));
  const imageHeight = Math.max(1, Math.round(finite(height, 700)));
  const detected = detection?.boundingBox || {};
  const detectedWidth = finite(detected.width, imageWidth);
  const detectedHeight = finite(detected.height, imageHeight);
  const box = {
    left: Math.max(0, Math.min(imageWidth - 1, Math.round(finite(detected.left, 0)))),
    top: Math.max(0, Math.min(imageHeight - 1, Math.round(finite(detected.top, 0)))),
    width: Math.max(1, Math.min(imageWidth, Math.round(detectedWidth))),
    height: Math.max(1, Math.min(imageHeight, Math.round(detectedHeight)))
  };
  box.width = Math.min(box.width, imageWidth - box.left);
  box.height = Math.min(box.height, imageHeight - box.top);

  const invoiceRegion = template?.fields?.invoiceNumber || DEFAULT_INVOICE_REGION;
  const aspect = box.height / Math.max(1, box.width);
  const stackedDocument = aspect > 1.05 && box.height > imageHeight * 0.45;
  const documentSlotCount = stackedDocument ? 2 : 1;
  const slotHeight = box.height / documentSlotCount;
  const slotTop = box.top;
  const headerTopRatio = Math.max(0.12, Math.min(0.22, finite(invoiceRegion.y, DEFAULT_INVOICE_REGION.y) + (stackedDocument ? 0.10 : 0.04)));
  const headerHeightRatio = stackedDocument
    ? 0.36
    : Math.max(0.30, Math.min(0.42, finite(invoiceRegion.y, DEFAULT_INVOICE_REGION.y) + finite(invoiceRegion.h, DEFAULT_INVOICE_REGION.h) + 0.18));
  const leftRatio = stackedDocument ? 0 : Math.max(0, finite(invoiceRegion.x, DEFAULT_INVOICE_REGION.x) - 0.08);
  const rightRatio = stackedDocument ? 1 : Math.min(1, finite(invoiceRegion.x, DEFAULT_INVOICE_REGION.x) + finite(invoiceRegion.w, DEFAULT_INVOICE_REGION.w) + 0.72);
  const left = Math.max(0, Math.min(imageWidth - 1, Math.round(box.left + box.width * leftRatio)));
  const top = Math.max(0, Math.min(imageHeight - 1, Math.round(slotTop + slotHeight * headerTopRatio)));
  const right = Math.max(left + 1, Math.min(imageWidth, Math.round(box.left + box.width * rightRatio)));
  const bottom = Math.max(top + 1, Math.min(imageHeight, Math.round(slotTop + slotHeight * (headerTopRatio + headerHeightRatio))));

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    coordinateSpace: "original-image",
    selectionReason: stackedDocument
      ? "document bounds plus normalized template header geometry; top slot of stacked invoice copies"
      : "document bounds plus normalized template header geometry; top invoice header",
    documentSlotCount,
    documentSlotIndex: 0,
    documentSlotHeight: Math.round(slotHeight),
    detectionMethod: detection?.method || "full-image-fallback"
  };
}

async function writeVariant(imageBuffer, roi, variant, outputPath) {
  const crop = sharp(imageBuffer).extract({ left: roi.left, top: roi.top, width: roi.width, height: roi.height });
  if (variant === "original-crop") {
    const buffer = await crop.jpeg({ quality: 95 }).toBuffer();
    writeFileSync(outputPath, buffer);
    return { buffer, width: roi.width, height: roi.height };
  }
  const image = await crop
    .grayscale()
    .normalize()
    .linear(1.35, -12)
    .resize({ width: roi.width * 2, withoutEnlargement: false })
    .jpeg({ quality: 95 })
    .toBuffer({ resolveWithObject: true });
  writeFileSync(outputPath, image.data);
  return { buffer: image.data, width: image.info.width, height: image.info.height };
}

function makeTargetedTaxField(taxIdentity, roi, outputWidth, outputHeight, variant) {
  if (!taxIdentity?.value) return null;
  const identityEvidence = mapIdentityEvidence({
    candidates: taxIdentity.candidates,
    selected: taxIdentity.selected,
    resolverReason: taxIdentity.resolverReason
  }, roi, outputWidth, outputHeight, variant);
  return {
    value: taxIdentity.value,
    confidence: normalizeConfidence(taxIdentity.confidence),
    source: "paddleocr",
    status: normalizeConfidence(taxIdentity.confidence) >= 0.85 ? "CONFIRMED" : "NEEDS_REVIEW",
    resolverReason: taxIdentity.resolverReason || "targeted buyer-tax identity recovery",
    evidence: identityEvidence.candidates
  };
}

function makeVariantAudit({ variant, preprocessMs, ocrRuntimeMs, response, outputWidth, outputHeight, roi, accepted, taxRecovery }) {
  const invoiceField = response?.result?.identityEvidence?.invoiceNumber;
  const normalizedCandidate = normalizeInvoice(response?.result?.invoiceNo);
  return {
    variant,
    preprocessMs,
    ocrRuntimeMs,
    rawCandidate: rawCandidateFrom(invoiceField, normalizedCandidate),
    normalizedCandidate: normalizedCandidate || null,
    confidence: normalizeConfidence(response?.result?.confidence?.invoiceNo),
    accepted,
    resolverReason: invoiceField?.resolverReason || response?.result?.identityEvidence?.invoiceNumber?.resolverReason || "",
    evidence: mapEvidence(invoiceField?.candidates, roi, outputWidth, outputHeight, variant),
    buyerTaxRecovery: taxRecovery ? {
      normalizedCandidate: taxRecovery.value,
      confidence: normalizeConfidence(taxRecovery.confidence),
      resolverReason: taxRecovery.resolverReason || "",
      evidence: mapEvidence(taxRecovery.candidates, roi, outputWidth, outputHeight, variant)
    } : null
  };
}

function mapTargetResult(result, roi, outputWidth, outputHeight, variant, buyerTaxField) {
  const invoiceEvidence = mapIdentityEvidence(result?.identityEvidence?.invoiceNumber, roi, outputWidth, outputHeight, variant);
  const taxEvidence = buyerTaxField
    ? {
      candidates: buyerTaxField.evidence,
      selected: buyerTaxField.value,
      resolverReason: buyerTaxField.resolverReason
    }
    : mapIdentityEvidence(result?.identityEvidence?.taxId, roi, outputWidth, outputHeight, variant);
  return {
    ...result,
    invoiceNo: normalizeInvoice(result?.invoiceNo) || null,
    buyerTaxId: buyerTaxField?.value || result?.buyerTaxId || null,
    confidence: {
      ...(result?.confidence || {}),
      invoiceNo: normalizeConfidence(result?.confidence?.invoiceNo),
      buyerTaxId: buyerTaxField?.confidence ?? normalizeConfidence(result?.confidence?.buyerTaxId)
    },
    identityEvidence: {
      invoiceNumber: invoiceEvidence || { candidates: [], selected: null, resolverReason: "" },
      taxId: taxEvidence || { candidates: [], selected: null, resolverReason: "" }
    }
  };
}

export async function runTargetedInvoiceRecovery({ imageBuffer, detection, template, outputPaths } = {}) {
  const imageMeta = await sharp(imageBuffer).metadata();
  const resolvedDetection = detection || await detectDocumentRectangle(sharp(imageBuffer));
  const roi = deriveTargetedInvoiceRoi({
    width: imageMeta.width,
    height: imageMeta.height,
    detection: resolvedDetection,
    template
  });
  const variants = ["original-crop"];
  const audit = [];
  let accepted = null;
  const startedAt = process.hrtime.bigint();

  for (const variant of variants) {
    const outputPath = variant === "original-crop" ? outputPaths.targetedInvoiceRoi : outputPaths.targetedInvoiceRoiContrast;
    const preprocessStartedAt = process.hrtime.bigint();
    const rendered = await writeVariant(imageBuffer, roi, variant, outputPath);
    const preprocessMs = Number(process.hrtime.bigint() - preprocessStartedAt) / 1e6;
    const ocrStartedAt = process.hrtime.bigint();
    const response = await recognizeInvoiceWithPaddleOcr(outputPath, { force: true });
    const ocrRuntimeMs = Number(process.hrtime.bigint() - ocrStartedAt) / 1e6;
    const invoiceCandidate = normalizeInvoice(response?.result?.invoiceNo);
    let taxIdentity = null;
    if (response?.ok && !response?.result?.buyerTaxId) {
      taxIdentity = resolveBuyerTaxIdentity({
        words: response.ocrWords || [],
        text: response.ocrText || "",
        invoiceNumber: invoiceCandidate,
        imageWidth: rendered.width,
        imageHeight: roi.documentSlotHeight || rendered.height
      });
    }
    const taxField = makeTargetedTaxField(taxIdentity, roi, rendered.width, rendered.height, variant);
    const isAccepted = Boolean(response?.ok && validInvoice(invoiceCandidate));
    audit.push(makeVariantAudit({
      variant,
      preprocessMs,
      ocrRuntimeMs,
      response,
      outputWidth: rendered.width,
      outputHeight: rendered.height,
      roi,
      accepted: isAccepted,
      taxRecovery: taxIdentity?.value ? taxIdentity : null
    }));
    if (isAccepted) {
      accepted = {
        variant,
        response,
        result: mapTargetResult(response.result, roi, rendered.width, rendered.height, variant, taxField),
        rawFieldInvoice: mapProviderField(response.raw?.fields?.invoiceNo, roi, rendered.width, rendered.height, variant),
        rawFieldTax: taxField ? {
          value: taxField.value,
          confidence: taxField.confidence,
          source: "paddleocr",
          status: taxField.status,
          resolverReason: taxField.resolverReason,
          evidence: taxField.evidence
        } : mapProviderField(response.raw?.fields?.buyerTaxId, roi, rendered.width, rendered.height, variant),
        roi,
        outputWidth: rendered.width,
        outputHeight: rendered.height
      };
      break;
    }
    if (!isAccepted && variant === "original-crop") variants.push("contrast-enhanced");
  }

  return {
    attempted: true,
    accepted: Boolean(accepted),
    roi,
    variants: audit,
    selectedVariant: accepted?.variant || null,
    selected: accepted?.result?.invoiceNo || null,
    resolverReason: accepted?.result?.identityEvidence?.invoiceNumber?.resolverReason || "targeted ROI variants did not produce a complete invoice candidate",
    performance: {
      targetedRoiPreprocessMs: audit.reduce((sum, item) => sum + item.preprocessMs, 0),
      targetedRoiOcrMs: audit.reduce((sum, item) => sum + item.ocrRuntimeMs, 0),
      targetedRoiTotalMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      targetedRoiInvocationCount: audit.length
    },
    acceptedResult: accepted?.result || null,
    acceptedRawFieldInvoice: accepted?.rawFieldInvoice || null,
    acceptedRawFieldTax: accepted?.rawFieldTax || null,
    acceptedRaw: accepted?.response?.raw || null
  };
}

export function mergeTargetedIdentityRecovery(basePaddle, recovery) {
  if (!basePaddle?.ok || !recovery?.accepted || !recovery.acceptedResult) return basePaddle;
  const target = recovery.acceptedResult;
  const current = basePaddle.result || {};
  const invoiceNo = hasCredibleInvoiceCandidate(current.invoiceNo) ? current.invoiceNo : target.invoiceNo;
  const buyerTaxId = current.buyerTaxId || target.buyerTaxId || null;
  const result = {
    ...current,
    invoiceNo,
    buyerTaxId,
    confidence: {
      ...(current.confidence || {}),
      invoiceNo: hasCredibleInvoiceCandidate(current.invoiceNo) ? current.confidence?.invoiceNo : target.confidence?.invoiceNo,
      buyerTaxId: current.buyerTaxId ? current.confidence?.buyerTaxId : target.confidence?.buyerTaxId
    },
    identityEvidence: {
      ...(current.identityEvidence || {}),
      invoiceNumber: hasCredibleInvoiceCandidate(current.invoiceNo) ? current.identityEvidence?.invoiceNumber : target.identityEvidence?.invoiceNumber,
      taxId: current.buyerTaxId ? current.identityEvidence?.taxId : target.identityEvidence?.taxId
    }
  };
  const fields = {
    ...(basePaddle.raw?.fields || {}),
    invoiceNo: hasCredibleInvoiceCandidate(current.invoiceNo) ? basePaddle.raw?.fields?.invoiceNo : recovery.acceptedRawFieldInvoice,
    buyerTaxId: current.buyerTaxId ? basePaddle.raw?.fields?.buyerTaxId : recovery.acceptedRawFieldTax
  };
  return {
    ...basePaddle,
    raw: basePaddle.raw ? { ...basePaddle.raw, fields, targetedRecovery: recovery } : basePaddle.raw,
    result,
    confidence: Math.max(normalizeConfidence(basePaddle.confidence), normalizeConfidence(result.confidence?.invoiceNo), normalizeConfidence(result.confidence?.buyerTaxId)),
    targetedRecovery: recovery
  };
}

export function recoveryDebugPath(recovery) {
  if (!recovery) return null;
  return {
    attempted: Boolean(recovery.attempted),
    accepted: Boolean(recovery.accepted),
    roi: recovery.roi || null,
    variants: recovery.variants || [],
    selectedVariant: recovery.selectedVariant || null,
    selected: recovery.selected || null,
    resolverReason: recovery.resolverReason || "",
    performance: recovery.performance || {}
  };
}
