import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { fromDataRelativePath } from "./paths.js";

const execFileAsync = promisify(execFile);
const swiftScript = `${process.cwd()}/scripts/macos-vision-ocr.swift`;
const swiftCacheDir = "/private/tmp/receipt-panel-swift-cache";

function cleanForRegion(name, text) {
  const value = String(text || "").replace(/\s+/g, "");
  if (name === "invoiceNumber") return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return value
    .replace(/[Oo]/g, "0")
    .replace(/[Il|]/g, "1")
    .replace(/[Ss]/g, "5")
    .replace(/[^\d]/g, "");
}

function scoreRegionResult(name, text, confidence) {
  const cleaned = cleanForRegion(name, text);
  let score = Number(confidence || 0);
  if (name === "invoiceNumber") {
    if (/^[A-Z]{2}\d{8}$/.test(cleaned)) score += 4;
    else if (/\d{8}/.test(cleaned)) score += 2;
  } else if (name === "taxId") {
    if (/^\d{8}$/.test(cleaned)) score += 4;
    else if (cleaned.length >= 6) score += 1.5;
  } else if (name === "quantity") {
    const number = Number(cleaned);
    if (number >= 1 && number <= 999) score += 3;
  } else if (name === "unitPrice") {
    const number = Number(cleaned);
    if (number >= 1 && number <= 1000000) score += 3;
    if (cleaned.length >= 4) score += 1;
  }
  return score;
}

function normalizeVisionResult(name, parsed, region) {
  const rawText = parsed?.text || "";
  const text = cleanForRegion(name, rawText);
  const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence || 0)));
  const words = Array.isArray(parsed?.words) ? parsed.words.map((word) => ({
    text: word.text || "",
    confidence: Math.round(Math.max(0, Math.min(1, Number(word.confidence || 0))) * 100),
    left: Math.max(0, Number(word.left || 0) + region.left),
    top: Math.max(0, Number(word.top || 0) + region.top),
    width: Math.max(1, Number(word.width || region.width)),
    height: Math.max(1, Number(word.height || region.height))
  })) : [];
  return {
    text,
    rawText,
    confidence,
    score: scoreRegionResult(name, text || rawText, confidence),
    ocrVariant: { engine: "macos-vision" },
    words,
    region,
    cropImagePath: region.cropImagePath || ""
  };
}

function normalizeFullVisionResult(parsed) {
  const words = Array.isArray(parsed?.words) ? parsed.words.map((word) => ({
    text: word.text || "",
    confidence: Math.round(Math.max(0, Math.min(1, Number(word.confidence || 0))) * 100),
    left: Math.max(0, Number(word.left || 0)),
    top: Math.max(0, Number(word.top || 0)),
    width: Math.max(1, Number(word.width || 1)),
    height: Math.max(1, Number(word.height || 1))
  })) : [];
  return {
    text: parsed?.text || "",
    confidence: Math.max(0, Math.min(1, Number(parsed?.confidence || 0))),
    words,
    ocrVariant: { engine: "macos-vision-full" }
  };
}

async function callVision(cropPath) {
  mkdirSync(swiftCacheDir, { recursive: true });
  const { stdout } = await execFileAsync("/usr/bin/swift", [swiftScript, cropPath], {
    timeout: 60000,
    maxBuffer: 1024 * 1024 * 4,
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: swiftCacheDir
    }
  });
  const parsed = JSON.parse(stdout.trim());
  if (!parsed.ok) throw new Error(parsed.error || "Vision OCR failed");
  return parsed;
}

export async function runMacosVisionImage(dataPath) {
  if (process.platform !== "darwin" || !existsSync(swiftScript)) return null;
  try {
    return normalizeFullVisionResult(await callVision(fromDataRelativePath(dataPath)));
  } catch (error) {
    return {
      text: "",
      confidence: 0,
      words: [],
      ocrVariant: { engine: "macos-vision-full", error: error?.message || "Vision OCR failed" }
    };
  }
}

export async function runMacosVisionRegions(regions) {
  if (process.platform !== "darwin" || !existsSync(swiftScript)) return null;
  const results = {};
  for (const region of regions) {
    if (!region.cropImagePath) continue;
    const cropPath = fromDataRelativePath(region.cropImagePath);
    try {
      const parsed = await callVision(cropPath);
      results[region.name] = normalizeVisionResult(region.name, parsed, region);
    } catch (error) {
      results[region.name] = {
        text: "",
        rawText: "",
        confidence: 0,
        score: 0,
        ocrVariant: { engine: "macos-vision", error: error?.message || "Vision OCR failed" },
        words: [],
        region,
        cropImagePath: region.cropImagePath || ""
      };
    }
  }
  return results;
}

export function mergeVisionAndTesseract(visionResults, tesseractResults) {
  if (!visionResults) return tesseractResults;
  const merged = { ...(tesseractResults || {}) };
  for (const [field, vision] of Object.entries(visionResults)) {
    const tesseract = merged[field];
    merged[field] = !tesseract || Number(vision.score || 0) >= Number(tesseract.score || 0)
      ? { ...vision, fallback: tesseract || null }
      : { ...tesseract, fallback: vision };
  }
  return merged;
}
