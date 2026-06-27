import { createWorker } from "tesseract.js";
import { join } from "node:path";
import sharp from "sharp";

const workerPath = join(process.cwd(), "node_modules", "tesseract.js", "src", "worker-script", "node", "index.js");
const corePath = join(process.cwd(), "node_modules", "tesseract.js-core", "tesseract-core-simd-lstm.js");

export function parseTsv(tsv) {
  return String(tsv || "")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 12 && parts[0] === "5")
    .map((parts) => ({
      left: Number(parts[6]) || 0,
      top: Number(parts[7]) || 0,
      width: Number(parts[8]) || 0,
      height: Number(parts[9]) || 0,
      confidence: Number(parts[10]) || 0,
      text: parts.slice(11).join("\t").trim()
    }))
    .filter((word) => word.text && word.confidence >= 0);
}

export async function runTesseractOcr(imageBuffer) {
  const worker = await createWorker("eng+chi_tra", undefined, {
    workerPath,
    corePath,
    langPath: process.cwd()
  });
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: "11",
      preserve_interword_spaces: "1"
    });
    const result = await worker.recognize(imageBuffer, {}, { text: true, hocr: true, tsv: true });
    return {
      text: result.data.text || "",
      confidence: Math.max(0, Math.min(1, Number(result.data.confidence || 0) / 100)),
      words: parseTsv(result.data.tsv),
      tsv: result.data.tsv || "",
      hocr: result.data.hocr || ""
    };
  } finally {
    await worker.terminate();
  }
}

function offsetWords(words, region) {
  return words.map((word) => ({
    ...word,
    left: word.left + region.left,
    top: word.top + region.top
  }));
}

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
    if (/^[A-Z]{2}\d{8}$/.test(cleaned)) score += 3;
    else if (/\d{8}/.test(cleaned)) score += 1.5;
  } else if (name === "taxId") {
    if (/^\d{8}$/.test(cleaned)) score += 3;
    else if (cleaned.length >= 6) score += 1;
  } else if (name === "quantity") {
    const number = Number(cleaned);
    if (number >= 1 && number <= 999) score += 2.5;
  } else if (name === "unitPrice") {
    const number = Number(cleaned);
    if (number >= 1 && number <= 1000000) score += 2.5;
    if (cleaned.length >= 4) score += 0.5;
  }
  return score;
}

async function regionVariants(imageBuffer, region) {
  const base = sharp(imageBuffer)
    .extract({ left: region.left, top: region.top, width: region.width, height: region.height })
    .grayscale()
    .normalize()
    .resize({ width: Math.max(region.width * (region.scale || 4), region.width), withoutEnlargement: false });
  const line = base.clone().linear(region.linearA || 1.65, region.linearB ?? -18);
  const contrast = await line.clone().png().toBuffer();
  const lineRemoved = await removeTableLines(contrast);
  return [
    { name: "contrast", buffer: contrast },
    { name: "line-removed", buffer: lineRemoved },
    { name: "line-removed-threshold", buffer: await sharp(lineRemoved).threshold(170).png().toBuffer() },
    { name: "threshold-light", buffer: await line.clone().threshold(178).png().toBuffer() },
    { name: "threshold-dark", buffer: await line.clone().median(1).threshold(148).png().toBuffer() },
    { name: "invert", buffer: await line.clone().threshold(178).negate().png().toBuffer() }
  ];
}

async function removeTableLines(buffer) {
  const image = sharp(buffer).grayscale();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const output = Buffer.from(data);
  const rowThreshold = Math.max(12, Math.round(info.width * 0.42));
  const colThreshold = Math.max(12, Math.round(info.height * 0.42));
  const darkRows = [];
  const darkCols = [];

  for (let y = 0; y < info.height; y += 1) {
    let count = 0;
    for (let x = 0; x < info.width; x += 1) {
      if (data[y * info.width + x] < 105) count += 1;
    }
    if (count >= rowThreshold) darkRows.push(y);
  }

  for (let x = 0; x < info.width; x += 1) {
    let count = 0;
    for (let y = 0; y < info.height; y += 1) {
      if (data[y * info.width + x] < 105) count += 1;
    }
    if (count >= colThreshold) darkCols.push(x);
  }

  for (const y of darkRows) {
    for (let yy = Math.max(0, y - 1); yy <= Math.min(info.height - 1, y + 1); yy += 1) {
      for (let x = 0; x < info.width; x += 1) output[yy * info.width + x] = 255;
    }
  }

  for (const x of darkCols) {
    for (let xx = Math.max(0, x - 1); xx <= Math.min(info.width - 1, x + 1); xx += 1) {
      for (let y = 0; y < info.height; y += 1) output[y * info.width + xx] = 255;
    }
  }

  return sharp(output, { raw: { width: info.width, height: info.height, channels: 1 } })
    .median(1)
    .png()
    .toBuffer();
}

function psmCandidates(region) {
  if (region.name === "invoiceNumber" || region.name === "taxId") return ["7", "8", "13"];
  if (region.name === "quantity") return ["7", "8", "10", "13"];
  if (region.name === "unitPrice") return ["6", "7", "8", "13"];
  return [region.psm || "6"];
}

export async function runTesseractRegions(imageBuffer, regions) {
  const worker = await createWorker("eng+chi_tra", undefined, {
    workerPath,
    corePath,
    langPath: process.cwd()
  });
  const results = {};
  try {
    for (const region of regions) {
      const variants = await regionVariants(imageBuffer, region);
      const psmList = psmCandidates(region);
      let best = null;
      for (const variant of variants) {
        for (const psm of psmList) {
          await worker.setParameters({
            tessedit_pageseg_mode: psm,
            preserve_interword_spaces: "1",
            tessedit_char_whitelist: region.whitelist || ""
          });
          const result = await worker.recognize(variant.buffer, {}, { text: true, tsv: true });
          const confidence = Math.max(0, Math.min(1, Number(result.data.confidence || 0) / 100));
          const score = scoreRegionResult(region.name, result.data.text || "", confidence);
          if (!best || score > best.score) {
            best = { result, confidence, score, variant: variant.name, psm };
          }
        }
      }
      const scale = Math.max(1, Math.max(region.width * (region.scale || 4), region.width) / region.width);
      const cropWords = parseTsv(best?.result?.data?.tsv).map((word) => ({
        ...word,
        left: Math.round(word.left / scale),
        top: Math.round(word.top / scale),
        width: Math.round(word.width / scale),
        height: Math.round(word.height / scale)
      }));
      const rawText = best?.result?.data?.text || "";
      const cleaned = cleanForRegion(region.name, rawText);
      const text = cleaned;
      const syntheticWords = text && !cropWords.length ? [{
        left: 0,
        top: 0,
        width: region.width,
        height: region.height,
        confidence: Math.round((best?.confidence || 0) * 100),
        text
      }] : cropWords;
      results[region.name] = {
        text,
        rawText,
        confidence: best?.confidence || 0,
        score: best?.score || 0,
        ocrVariant: best ? { variant: best.variant, psm: best.psm } : null,
        words: offsetWords(syntheticWords, region),
        region,
        cropImagePath: region.cropImagePath || ""
      };
    }
  } finally {
    await worker.terminate();
  }
  return results;
}
