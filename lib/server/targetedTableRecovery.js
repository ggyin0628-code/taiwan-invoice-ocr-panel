import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { CANONICAL_SIZE } from "../templates/taiwanTriplicateInvoiceTemplate.js";
import { recognizeInvoiceWithPaddleOcr } from "./paddleOcrProvider.js";

const TABLE_ROI_NORMALIZED = Object.freeze({ x: 0.10, y: 0.35, w: 0.78, h: 0.43 });

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapBox(box, roi, scaleX, scaleY) {
  if (!box) return box;
  const x1 = finite(box.x1) / scaleX;
  const y1 = finite(box.y1) / scaleY;
  const x2 = finite(box.x2) / scaleX;
  const y2 = finite(box.y2) / scaleY;
  return {
    x1: Math.round(roi.left + x1),
    y1: Math.round(roi.top + y1),
    x2: Math.round(roi.left + x2),
    y2: Math.round(roi.top + y2)
  };
}

function mapEvidence(value, roi, scaleX, scaleY) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => mapEvidence(entry, roi, scaleX, scaleY));
  const mapped = { ...value };
  if (mapped.bbox) mapped.bbox = mapBox(mapped.bbox, roi, scaleX, scaleY);
  if (mapped.rowBbox) mapped.rowBbox = mapBox(mapped.rowBbox, roi, scaleX, scaleY);
  if (mapped.sourceTokens) mapped.sourceTokens = mapped.sourceTokens.map((token) => ({ ...token, bbox: mapBox(token.bbox, roi, scaleX, scaleY) }));
  return mapped;
}

function mapItem(item, roi, scaleX, scaleY) {
  return {
    ...item,
    rowBbox: mapBox(item.rowBbox || item.rowBox, roi, scaleX, scaleY),
    nameEvidence: mapEvidence(item.nameEvidence, roi, scaleX, scaleY),
    quantityEvidence: mapEvidence(item.quantityEvidence, roi, scaleX, scaleY),
    unitPriceEvidence: mapEvidence(item.unitPriceEvidence, roi, scaleX, scaleY),
    amountReference: mapEvidence(item.amountReference, roi, scaleX, scaleY),
    cells: mapEvidence(item.cells, roi, scaleX, scaleY),
    recoveryVariant: "targeted-table-roi",
    recoveryRoi: { ...roi }
  };
}

function rowQuality(items = []) {
  return items.reduce((score, item) => {
    const named = String(item?.name ?? item?.itemName ?? "").trim() ? 3 : -1;
    const numeric = item?.quantity != null && item?.unitPrice != null ? 1 : -2;
    const structure = item?.rowBbox || item?.cells ? 1 : 0;
    return score + named + numeric + structure;
  }, 0);
}

export function deriveTargetedTableRoi({ width = CANONICAL_SIZE.width, height = CANONICAL_SIZE.height } = {}) {
  const imageWidth = Math.max(1, Math.round(finite(width, CANONICAL_SIZE.width)));
  const imageHeight = Math.max(1, Math.round(finite(height, CANONICAL_SIZE.height)));
  const left = Math.max(0, Math.min(imageWidth - 1, Math.round(imageWidth * TABLE_ROI_NORMALIZED.x)));
  const top = Math.max(0, Math.min(imageHeight - 1, Math.round(imageHeight * TABLE_ROI_NORMALIZED.y)));
  const right = Math.min(imageWidth, Math.round(imageWidth * (TABLE_ROI_NORMALIZED.x + TABLE_ROI_NORMALIZED.w)));
  const bottom = Math.min(imageHeight, Math.round(imageHeight * (TABLE_ROI_NORMALIZED.y + TABLE_ROI_NORMALIZED.h)));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    coordinateSpace: "corrected-image",
    normalizedGeometry: { ...TABLE_ROI_NORMALIZED },
    selectionReason: "canonical Taiwan triplicate invoice table geometry",
  };
}

export function shouldRunTargetedTableRecovery(result = {}) {
  const items = Array.isArray(result.items) ? result.items : [];
  if (!items.length) return true;
  return items.some((item) => !String(item?.name ?? item?.itemName ?? "").trim() || item?.rowType === "numeric_only" || !item?.rowBbox || !item?.cells);
}

export async function runTargetedTableRecovery({ imagePath, outputPath } = {}) {
  const startedAt = process.hrtime.bigint();
  const sourceBuffer = readFileSync(imagePath);
  const metadata = await sharp(sourceBuffer).metadata();
  const roi = deriveTargetedTableRoi({ width: metadata.width, height: metadata.height });
  const preprocessStartedAt = process.hrtime.bigint();
  const crop = await sharp(sourceBuffer)
    .extract({ left: roi.left, top: roi.top, width: roi.width, height: roi.height })
    .grayscale()
    .normalize()
    .linear(1.25, -8)
    .resize({ width: roi.width * 2, withoutEnlargement: false })
    .jpeg({ quality: 94 })
    .toBuffer({ resolveWithObject: true });
  writeFileSync(outputPath, crop.data);
  const preprocessMs = Number(process.hrtime.bigint() - preprocessStartedAt) / 1e6;
  const ocrStartedAt = process.hrtime.bigint();
  const response = await recognizeInvoiceWithPaddleOcr(outputPath, { force: true });
  const ocrMs = Number(process.hrtime.bigint() - ocrStartedAt) / 1e6;
  const items = Array.isArray(response?.result?.items) ? response.result.items : [];
  const scaleX = crop.info.width / roi.width;
  const scaleY = crop.info.height / roi.height;
  const mappedResult = response?.result
    ? { ...response.result, items: items.map((item) => mapItem(item, roi, scaleX, scaleY)) }
    : null;
  const accepted = Boolean(response?.ok && items.length && rowQuality(mappedResult.items) > 0);
  return {
    attempted: true,
    accepted,
    roi,
    result: mappedResult,
    raw: response?.raw || null,
    error: response?.error || null,
    audit: {
      variant: "targeted-table-roi",
      accepted,
      rowCount: items.length,
      namedRowCount: items.filter((item) => String(item?.name ?? item?.itemName ?? "").trim()).length,
      structuredRowCount: items.filter((item) => item?.rowBbox || item?.cells).length,
      selectionReason: roi.selectionReason
    },
    performance: {
      targetedTablePreprocessMs: preprocessMs,
      targetedTableOcrMs: ocrMs,
      targetedTableTotalMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      targetedTableInvocationCount: 1
    }
  };
}

export function mergeTargetedTableRecovery(basePaddle, recovery) {
  if (!basePaddle?.ok || !recovery?.accepted || !recovery.result) return basePaddle;
  const current = basePaddle.result || {};
  const currentItems = Array.isArray(current.items) ? current.items : [];
  const targetItems = Array.isArray(recovery.result.items) ? recovery.result.items : [];
  const selectedItems = rowQuality(targetItems) >= rowQuality(currentItems) ? targetItems : currentItems;
  const selectedTarget = selectedItems === targetItems;
  return {
    ...basePaddle,
    raw: basePaddle.raw ? { ...basePaddle.raw, targetedTableRecovery: recovery } : basePaddle.raw,
    result: {
      ...current,
      items: selectedItems,
      warnings: [...new Set([...(current.warnings || []), ...(selectedTarget ? recovery.result.warnings || [] : [])])]
    },
    targetedTableRecovery: { ...recovery, selected: selectedTarget ? "targeted-table-roi" : "full-page" }
  };
}

export function targetedTableDebug(recovery) {
  if (!recovery) return null;
  return {
    attempted: Boolean(recovery.attempted),
    accepted: Boolean(recovery.accepted),
    roi: recovery.roi || null,
    audit: recovery.audit || null,
    selected: recovery.selected || null,
    error: recovery.error || null,
    performance: recovery.performance || {}
  };
}
