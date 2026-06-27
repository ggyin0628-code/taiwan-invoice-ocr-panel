import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { fromDataRelativePath, TEMPLATES_DIR } from "./paths.js";

export const TEMPLATE_FIELDS = ["invoiceNumber", "taxId", "quantity", "unitPrice"];

export const DEFAULT_TEMPLATE = {
  templateId: "taiwan-triplicate-default",
  templateName: "台灣三聯式手寫發票",
  vendorName: "",
  vendorTaxId: "",
  documentType: "台灣三聯式手寫發票",
  canonicalSize: { width: 1200, height: 700 },
  fields: {
    invoiceNumber: { x: 0.105, y: 0.08, w: 0.25, h: 0.12 },
    taxId: { x: 0.20, y: 0.22, w: 0.28, h: 0.12 },
    quantity: { x: 0.34, y: 0.37, w: 0.08, h: 0.13 },
    unitPrice: { x: 0.41, y: 0.37, w: 0.13, h: 0.13 }
  }
};

export async function detectLayoutAnchor(imageBuffer) {
  const { data, info } = await sharp(imageBuffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  const rowCounts = new Array(info.height).fill(0);
  const colCounts = new Array(info.width).fill(0);
  const step = Math.max(1, Math.floor(Math.min(info.width, info.height) / 900));

  for (let y = 0; y < info.height; y += step) {
    for (let x = 0; x < info.width; x += step) {
      const value = data[y * info.width + x];
      if (value < 205) {
        rowCounts[y] += 1;
        colCounts[x] += 1;
      }
    }
  }

  function bounds(counts, threshold) {
    let first = -1;
    let last = -1;
    for (let index = 0; index < counts.length; index += 1) {
      if (counts[index] >= threshold) {
        if (first < 0) first = index;
        last = index;
      }
    }
    return { first, last };
  }

  const row = bounds(rowCounts, Math.max(3, Math.round((info.width / step) * 0.012)));
  const col = bounds(colCounts, Math.max(3, Math.round((info.height / step) * 0.012)));
  if (row.first < 0 || col.first < 0) {
    return { x: 0, y: 0, w: 1, h: 1, method: "full-image", confidence: 0 };
  }

  const padX = Math.round(info.width * 0.01);
  const padY = Math.round(info.height * 0.01);
  const left = Math.max(0, col.first - padX);
  const top = Math.max(0, row.first - padY);
  const right = Math.min(info.width - 1, col.last + padX);
  const bottom = Math.min(info.height - 1, row.last + padY);
  const width = Math.max(1, right - left + 1);
  const height = Math.max(1, bottom - top + 1);

  return {
    x: left / info.width,
    y: top / info.height,
    w: width / info.width,
    h: height / info.height,
    method: "dark-layout-bounds",
    confidence: Math.min(1, (width * height) / (info.width * info.height))
  };
}

function safeTemplateId(value) {
  return String(value || "template").replace(/[^\w.-]+/g, "-").slice(0, 80);
}

function ensureTemplatesDir() {
  mkdirSync(TEMPLATES_DIR, { recursive: true });
  const defaultPath = join(TEMPLATES_DIR, `${DEFAULT_TEMPLATE.templateId}.json`);
  if (!existsSync(defaultPath)) {
    writeFileSync(defaultPath, `${JSON.stringify(DEFAULT_TEMPLATE, null, 2)}\n`, "utf8");
  }
}

function clampRatio(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function normalizeRegion(region, fallback) {
  return {
    x: clampRatio(region?.x, fallback.x),
    y: clampRatio(region?.y, fallback.y),
    w: Math.max(0.01, Math.min(1, Number.isFinite(Number(region?.w)) ? Number(region.w) : fallback.w)),
    h: Math.max(0.01, Math.min(1, Number.isFinite(Number(region?.h)) ? Number(region.h) : fallback.h))
  };
}

export function normalizeTemplate(input = {}) {
  const templateId = safeTemplateId(input.templateId || DEFAULT_TEMPLATE.templateId);
  const fields = {};
  for (const field of TEMPLATE_FIELDS) {
    fields[field] = normalizeRegion(input.fields?.[field], DEFAULT_TEMPLATE.fields[field]);
  }
  return {
    templateId,
    templateName: String(input.templateName || DEFAULT_TEMPLATE.templateName).slice(0, 80),
    vendorName: String(input.vendorName || DEFAULT_TEMPLATE.vendorName).slice(0, 80),
    vendorTaxId: String(input.vendorTaxId || DEFAULT_TEMPLATE.vendorTaxId).replace(/[^\d]/g, "").slice(0, 8),
    documentType: String(input.documentType || DEFAULT_TEMPLATE.documentType).slice(0, 80),
    canonicalSize: {
      width: Number(input.canonicalSize?.width) || DEFAULT_TEMPLATE.canonicalSize.width,
      height: Number(input.canonicalSize?.height) || DEFAULT_TEMPLATE.canonicalSize.height
    },
    fields,
    referenceAnchor: input.referenceAnchor && typeof input.referenceAnchor === "object"
      ? {
        x: clampRatio(input.referenceAnchor.x, 0),
        y: clampRatio(input.referenceAnchor.y, 0),
        w: Math.max(0.01, Math.min(1, Number(input.referenceAnchor.w) || 1)),
        h: Math.max(0.01, Math.min(1, Number(input.referenceAnchor.h) || 1)),
        method: String(input.referenceAnchor.method || "manual").slice(0, 40),
        confidence: clampRatio(input.referenceAnchor.confidence, 0)
      }
      : null,
    updatedAt: new Date().toISOString()
  };
}

export function readTemplates() {
  ensureTemplatesDir();
  const templates = [];
  for (const filename of readdirSync(TEMPLATES_DIR)) {
    if (!filename.endsWith(".json")) continue;
    try {
      templates.push(normalizeTemplate(JSON.parse(readFileSync(join(TEMPLATES_DIR, filename), "utf8"))));
    } catch {
      // Ignore broken template files instead of breaking OCR startup.
    }
  }
  return templates.length ? templates : [DEFAULT_TEMPLATE];
}

export async function saveTemplate(input) {
  ensureTemplatesDir();
  let sourceAnchor = input.referenceAnchor;
  if (!sourceAnchor && input.sourceCorrectedImagePath) {
    const imagePath = fromDataRelativePath(input.sourceCorrectedImagePath);
    if (existsSync(imagePath)) sourceAnchor = await detectLayoutAnchor(readFileSync(imagePath));
  }
  const template = normalizeTemplate({ ...input, referenceAnchor: sourceAnchor });
  writeFileSync(join(TEMPLATES_DIR, `${template.templateId}.json`), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  return template;
}

export function resolveTemplate({ text = "", words = [] } = {}) {
  const templates = readTemplates();
  const allText = `${text}\n${words.map((word) => word.text).join(" ")}`;
  const matched = templates.find((template) => template.vendorTaxId && allText.includes(template.vendorTaxId));
  return {
    template: matched || templates[0] || DEFAULT_TEMPLATE,
    reason: matched ? "seller-tax-id" : "default-template"
  };
}
