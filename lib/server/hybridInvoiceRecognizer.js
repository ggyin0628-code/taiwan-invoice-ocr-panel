import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import { DATA_DIR, fromDataRelativePath, toDataRelativePath } from "./paths.js";
import { deriveReviewStatus, meaningfulWarnings } from "./invoiceStatus.js";

const DEFAULT_PADDLE_URL = "http://127.0.0.1:8765";
const CORRECTION_RULES_FILE = join(DATA_DIR, "correction-rules.json");
const FIELD_CROPS = {
  invoiceNumber: { x: 0.08, y: 0.02, w: 0.34, h: 0.18 },
  buyerTaxId: { x: 0.05, y: 0.14, w: 0.42, h: 0.22 },
  items: { x: 0.04, y: 0.28, w: 0.72, h: 0.36 },
  sellerName: { x: 0.60, y: 0.48, w: 0.36, h: 0.36 }
};

function addWarning(record, warning) {
  if (!record.warnings.includes(warning)) record.warnings.push(warning);
}

function digits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizeInvoiceNumberText(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function numberFrom(value, { allowDecimal = false } = {}) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  if (!text) return null;
  if (allowDecimal) {
    if (!/^\d+(\.\d+)?$/.test(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) && number > 0 ? number : null;
  }
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function confidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return number > 1 ? Math.max(0, Math.min(1, number / 100)) : Math.max(0, Math.min(1, number));
}

function lineCenter(line = {}) {
  const box = line.box || {};
  return {
    x: (Number(box.x1 || 0) + Number(box.x2 || 0)) / 2,
    y: (Number(box.y1 || 0) + Number(box.y2 || 0)) / 2
  };
}

function field(value, { source = "paddleocr", confidence: score = 0.75, status = "auto", reason = "", rawText = value } = {}) {
  return { value: value ?? null, rawText: rawText == null ? "" : String(rawText), source, confidence: confidence(score), status, reason };
}

function readCorrectionRules() {
  try {
    return JSON.parse(readFileSync(CORRECTION_RULES_FILE, "utf8"));
  } catch {
    return { sellerNameCorrections: {}, commonDigitCorrections: {}, fieldRules: {} };
  }
}

function applyDigitCorrections(value, rules) {
  let text = String(value ?? "");
  for (const [from, to] of Object.entries(rules.commonDigitCorrections || {})) {
    text = text.replaceAll(from, to);
  }
  return text;
}

export async function runPaddleOcr(imagePath) {
  const buffer = readFileSync(imagePath);
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "image/jpeg" }), basename(imagePath));
  const baseUrl = String(process.env.PADDLE_OCR_SERVICE_URL || DEFAULT_PADDLE_URL).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/ocr/invoice`, { method: "POST", body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data?.error || `PaddleOCR HTTP ${response.status}`);
  return data;
}

export function extractInvoiceNumberByPosition(ocrResult) {
  const lines = Array.isArray(ocrResult?.lines) ? ocrResult.lines : [];
  const width = Number(ocrResult?.debug?.imageWidth || 1200);
  const height = Number(ocrResult?.debug?.imageHeight || 900);
  const topLeft = lines.filter((line) => {
    const center = lineCenter(line);
    return center.x <= width * 0.45 && center.y <= height * 0.25;
  });
  const joined = topLeft.map((line) => line.text).join(" ").toUpperCase();
  const direct = joined.match(/[A-Z]{2}\s*\d{8}/);
  if (direct) return field(direct[0].replace(/\s+/g, ""), { confidence: Math.max(...topLeft.map((line) => confidence(line.confidence)), 0.75), rawText: joined });
  const prefix = topLeft.find((line) => /^[A-Z]{2}$/.test(String(line.text || "").trim().toUpperCase()));
  const number = topLeft.find((line) => /^\d{8}$/.test(digits(line.text)));
  if (prefix && number) return field(`${String(prefix.text).toUpperCase()}${digits(number.text)}`, { confidence: Math.min(confidence(prefix.confidence), confidence(number.confidence)), rawText: `${prefix.text} ${number.text}` });
  if (number) return field(null, { confidence: confidence(number.confidence), status: "manual_required", reason: "invoice_number_missing_prefix", rawText: number.text });
  return field(null, { confidence: 0, status: "manual_required", reason: "invoice_number_missing_prefix" });
}

export function extractBuyerTaxIdByPosition(ocrResult) {
  const lines = Array.isArray(ocrResult?.lines) ? ocrResult.lines : [];
  const width = Number(ocrResult?.debug?.imageWidth || 1200);
  const height = Number(ocrResult?.debug?.imageHeight || 900);
  const buyerArea = lines.filter((line) => {
    const center = lineCenter(line);
    return center.x <= width * 0.55 && center.y >= height * 0.10 && center.y <= height * 0.43;
  });
  const label = buyerArea.find((line) => /(統一編號|統編)/.test(line.text || ""))
    || buyerArea.find((line) => /買受人/.test(line.text || "") && !/註記欄/.test(line.text || ""));
  const candidates = buyerArea
    .flatMap((line) => {
      const values = [];
      const text = String(line.text || "");
      const sameText = text.match(/統一編號[:：]?\s*(\d{8})/);
      if (sameText) values.push(sameText[1]);
      const digitText = digits(text);
      if (digitText.length >= 8) values.push(digitText.slice(0, 8));
      return [...new Set(values)].map((value) => ({ line, value, center: lineCenter(line) }));
    })
    .filter((candidate) => /^\d{8}$/.test(candidate.value));
  if (!candidates.length) return field(null, { confidence: 0, status: "manual_required", reason: "buyer_tax_id_missing" });
  const picked = label
    ? candidates
      .filter((candidate) => candidate.center.y >= lineCenter(label).y - height * 0.035)
      .sort((a, b) => Math.abs(a.center.y - lineCenter(label).y) - Math.abs(b.center.y - lineCenter(label).y))[0] || candidates[0]
    : candidates[0];
  const score = Math.min(confidence(picked.line.confidence), 0.84);
  return field(picked.value, { confidence: score, status: score >= 0.8 ? "auto" : "low_confidence", reason: score >= 0.8 ? "" : "buyer_tax_id_needs_review", rawText: picked.line.text });
}

function estimateHeaderY(lines) {
  const header = lines.find((line) => /(品名|數量|数量|單價|单价|金額|金额)/.test(line.text || ""));
  return header ? lineCenter(header).y : 0;
}

function rowGroups(lines, tolerance = 30) {
  const rows = [];
  for (const line of [...lines].sort((a, b) => lineCenter(a).y - lineCenter(b).y)) {
    const center = lineCenter(line);
    const row = rows.find((candidate) => Math.abs(candidate.y - center.y) <= tolerance);
    if (row) {
      row.lines.push(line);
      row.y = row.lines.reduce((sum, item) => sum + lineCenter(item).y, 0) / row.lines.length;
    } else {
      rows.push({ y: center.y, lines: [line] });
    }
  }
  return rows.map((row) => row.lines.sort((a, b) => lineCenter(a).x - lineCenter(b).x));
}

function compactText(lines = []) {
  return lines.map((line) => String(line.text || "").trim()).filter(Boolean).join("");
}

function numericCell(line) {
  const text = String(line?.text || "").replace(/,/g, "").replace(/[>＞]/g, "2").trim();
  const match = text.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  return numberFrom(match[0], { allowDecimal: true });
}

function tableItemCutoffY(lines, headerY, height) {
  const lowerBoundary = lines
    .map((line) => ({ line, center: lineCenter(line) }))
    .filter(({ line, center }) => center.y > headerY + height * 0.08 && /(銷售|營業稅|营业税|總計|总计|營業人|统一發票專用章|統一發票專用章)/.test(line.text || ""))
    .sort((a, b) => a.center.y - b.center.y)[0];
  if (lowerBoundary) return lowerBoundary.center.y - height * 0.025;
  return height * 0.52;
}

function extractItemFromRow(row, width) {
  const cells = row.map((line) => ({ line, center: lineCenter(line), value: numericCell(line) }));
  const rowText = compactText(row);
  if (!rowText || /(銷售|營業稅|营业税|總計|总计|合計|營業人|統一編號|统一編號|發票專用章|買受人註記)/.test(rowText)) return null;

  const nameText = compactText(cells.filter(({ center }) => center.x < width * 0.31).map(({ line }) => line)).slice(0, 80);
  const numericCells = cells
    .filter(({ center, value }) => value != null && center.x >= width * 0.29 && center.x <= width * 0.72)
    .sort((a, b) => a.center.x - b.center.x);

  if (!nameText && numericCells.length < 2) return null;
  if (numericCells.length < 2) return { itemName: nameText || null, quantity: null, unitPrice: null, ocrAmount: null, warnings: ["quantity_missing", "unit_price_missing"] };

  let quantity = null;
  let unitPrice = null;
  let ocrAmount = null;
  const warnings = [];

  if (numericCells.length >= 3) {
    quantity = numericCells[0].value;
    unitPrice = Number.isInteger(numericCells[1].value) ? numericCells[1].value : null;
    ocrAmount = Number.isInteger(numericCells[2].value) ? numericCells[2].value : null;
  } else {
    const [left, right] = numericCells;
    unitPrice = Number.isInteger(left.value) ? left.value : null;
    ocrAmount = Number.isInteger(right.value) ? right.value : null;
    if (unitPrice != null && ocrAmount != null && ocrAmount % unitPrice === 0) {
      const inferred = ocrAmount / unitPrice;
      if (inferred > 0 && inferred <= 999) {
        quantity = inferred;
        warnings.push("quantity_inferred_from_amount_reference");
      }
    }
  }

  if (quantity != null && unitPrice != null && ocrAmount != null && quantity * unitPrice !== ocrAmount && ocrAmount % unitPrice === 0) {
    const inferred = ocrAmount / unitPrice;
    if (inferred > 0 && inferred <= 999) {
      quantity = inferred;
      warnings.push("quantity_corrected_from_amount_reference");
    }
  }

  if (quantity == null) warnings.push("quantity_missing");
  if (unitPrice == null) warnings.push("unit_price_missing");
  return { itemName: nameText || null, quantity, unitPrice, ocrAmount, warnings };
}

export function extractItemsByTableHeaders(ocrResult) {
  const warnings = [];
  const lines = Array.isArray(ocrResult?.lines) ? ocrResult.lines : [];
  const width = Number(ocrResult?.debug?.imageWidth || 1200);
  const height = Number(ocrResult?.debug?.imageHeight || 900);
  const headerY = estimateHeaderY(lines);
  const cutoffY = tableItemCutoffY(lines, headerY, height);
  const tableLines = lines.filter((line) => {
    const center = lineCenter(line);
    return center.y > headerY + 8 && center.y < cutoffY && center.x < width * 0.78;
  });
  const items = [];
  for (const row of rowGroups(tableLines)) {
    const extracted = extractItemFromRow(row, width);
    if (!extracted) continue;
    const { itemName, quantity, unitPrice, ocrAmount } = extracted;
    warnings.push(...extracted.warnings);
    const amount = quantity != null && unitPrice != null ? quantity * unitPrice : null;
    if (ocrAmount != null && amount != null && ocrAmount !== amount) warnings.push("ocr_amount_mismatch");
    items.push({ itemName, quantity, unitPrice, amount, ocrAmount, source: "paddleocr", status: amount != null ? "auto" : "manual_required", confidence: 0.75 });
  }
  return { items: items.slice(0, 12), warnings };
}

export function calculateAmountsFromItems(items = []) {
  const complete = items.length > 0 && items.every((item) => item.quantity != null && item.unitPrice != null && Number.isFinite(Number(item.quantity)) && Number.isFinite(Number(item.unitPrice)));
  if (!complete) return { salesAmount: null, taxAmount: null, totalAmount: null, amountSource: "none", complete: false };
  const salesAmount = items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unitPrice), 0);
  const taxAmount = Math.round(salesAmount * 0.05);
  return { salesAmount, taxAmount, totalAmount: salesAmount + taxAmount, amountSource: "formula", complete: true };
}

export function extractInvoiceFieldsFromPaddleOcr(ocrResult) {
  const warnings = Array.isArray(ocrResult?.warnings)
    ? ocrResult.warnings.filter((warning) => !String(warning).includes("金額參考欄與公式不一致"))
    : [];
  let invoiceNumber = extractInvoiceNumberByPosition(ocrResult);
  if (!invoiceNumber.value && /^[A-Z]{2}\d{8}$/.test(normalizeInvoiceNumberText(ocrResult?.fields?.invoiceNo?.value))) {
    invoiceNumber = field(normalizeInvoiceNumberText(ocrResult.fields.invoiceNo.value), {
      source: "paddleocr",
      confidence: ocrResult.fields.invoiceNo.confidence || 0.75,
      status: confidence(ocrResult.fields.invoiceNo.confidence) >= 0.6 ? "auto" : "low_confidence",
      rawText: ocrResult.fields.invoiceNo.value
    });
  }
  let buyerTaxId = extractBuyerTaxIdByPosition(ocrResult);
  if (!buyerTaxId.value && /^\d{8}$/.test(digits(ocrResult?.fields?.buyerTaxId?.value))) {
    buyerTaxId = field(digits(ocrResult.fields.buyerTaxId.value), {
      source: "paddleocr",
      confidence: Math.min(confidence(ocrResult.fields.buyerTaxId.confidence), 0.84),
      status: confidence(ocrResult.fields.buyerTaxId.confidence) >= 0.8 ? "auto" : "low_confidence",
      reason: confidence(ocrResult.fields.buyerTaxId.confidence) >= 0.8 ? "" : "buyer_tax_id_needs_review",
      rawText: ocrResult.fields.buyerTaxId.value
    });
  }
  const itemsResult = extractItemsByTableHeaders(ocrResult);
  warnings.push(...itemsResult.warnings);
  return {
    invoiceNumber: invoiceNumber.value,
    taxId: buyerTaxId.value,
    sellerName: null,
    items: itemsResult.items,
    warnings,
    fieldStatuses: {
      invoiceNumber: invoiceNumber.status,
      taxId: buyerTaxId.status,
      quantity: itemsResult.items.every((item) => item.quantity != null) && itemsResult.items.length ? "auto" : "manual_required",
      unitPrice: itemsResult.items.every((item) => item.unitPrice != null) && itemsResult.items.length ? "auto" : "manual_required"
    },
    fieldSources: { invoiceNumber: "paddleocr", taxId: "paddleocr", quantity: "paddleocr", unitPrice: "paddleocr" },
    confidence: { invoiceNumber: invoiceNumber.confidence, taxId: buyerTaxId.confidence, quantity: 0.75, unitPrice: 0.75 },
    rawText: ocrResult?.rawText || ""
  };
}

export function applyCorrectionRules(record) {
  const rules = readCorrectionRules();
  const corrected = { ...record };
  if (corrected.sellerName && rules.sellerNameCorrections?.[corrected.sellerName]) {
    corrected.sellerName = rules.sellerNameCorrections[corrected.sellerName];
  }
  corrected.taxId = digits(applyDigitCorrections(corrected.taxId, rules));
  corrected.invoiceNumber = normalizeInvoiceNumberText(applyDigitCorrections(corrected.invoiceNumber, rules));
  return corrected;
}

export function normalizeInvoiceRecord(record) {
  const warnings = [...new Set(Array.isArray(record.warnings) ? record.warnings.map(String) : [])];
  const normalized = applyCorrectionRules({ ...record, warnings });
  if (normalized.invoiceNumber && !/^[A-Z]{2}\d{8}$/.test(normalized.invoiceNumber)) {
    if (/^\d{8}$/.test(digits(normalized.invoiceNumber))) warnings.push("invoice_number_missing_prefix");
    normalized.invoiceNumber = "";
  }
  if (normalized.taxId && !/^\d{8}$/.test(normalized.taxId)) normalized.taxId = "";
  if (normalized.invoiceNumber && normalized.taxId && normalized.taxId === normalized.invoiceNumber.slice(2)) {
    normalized.taxId = "";
    warnings.push("buyer_tax_id_same_as_invoice_number");
  }
  normalized.items = (Array.isArray(normalized.items) ? normalized.items : []).map((item, index) => {
    const quantity = numberFrom(item.quantity, { allowDecimal: true });
    const unitPrice = numberFrom(item.unitPrice);
    if (quantity == null) warnings.push("quantity_missing");
    if (unitPrice == null) warnings.push("unit_price_missing");
    const amount = quantity != null && unitPrice != null ? quantity * unitPrice : null;
    if (item.ocrAmount != null && amount != null && Number(item.ocrAmount) !== amount) warnings.push("ocr_amount_mismatch");
    return { lineNo: item.lineNo || index + 1, itemName: item.itemName || item.name || "", quantity, unitPrice, amount, source: item.source || "paddleocr", status: amount != null ? "auto" : "manual_required", confidence: confidence(item.confidence || 0.75) };
  }).filter((item) => item.quantity != null || item.unitPrice != null || item.itemName);
  const amounts = calculateAmountsFromItems(normalized.items);
  normalized.salesAmount = amounts.salesAmount;
  normalized.taxAmount = amounts.taxAmount;
  normalized.totalAmount = amounts.totalAmount;
  normalized.amountSource = amounts.amountSource;
  if (!amounts.complete) warnings.push("amount_needs_manual_check");
  normalized.warnings = [...new Set(warnings.filter(Boolean))];
  return normalized;
}

export function validateInvoiceRecord(record) {
  const warnings = [...new Set(Array.isArray(record.warnings) ? record.warnings : [])];
  if (!record.invoiceNumber) warnings.push("invoice_number_missing_prefix");
  if (!record.taxId) warnings.push("buyer_tax_id_missing");
  if (!record.items?.length || record.items.some((item) => item.quantity == null || item.unitPrice == null || item.amount == null)) warnings.push("amount_needs_manual_check");
  const hasWarnings = meaningfulWarnings(warnings).length > 0;
  const confidenceValue = hasWarnings || !record.items?.length ? "low" : Object.values(record.fieldStatuses || {}).some((status) => status === "low_confidence") ? "medium" : "high";
  return { ...record, warnings, confidenceLevel: confidenceValue };
}

function needsOllama(record) {
  return !record.invoiceNumber || !record.taxId || !record.sellerName || !record.items?.length || record.items.some((item) => !item.itemName || item.quantity == null || item.unitPrice == null);
}

export async function cropRegionForField(imagePath, fieldName) {
  const region = FIELD_CROPS[fieldName];
  if (!region) return null;
  const metadata = await sharp(imagePath).metadata();
  const width = metadata.width || 1;
  const height = metadata.height || 1;
  const crop = {
    left: Math.max(0, Math.round(width * region.x)),
    top: Math.max(0, Math.round(height * region.y)),
    width: Math.max(1, Math.round(width * region.w)),
    height: Math.max(1, Math.round(height * region.h))
  };
  const outputPath = join(dirname(imagePath), `${basename(imagePath, ".jpg")}.${fieldName}.ollama.jpg`);
  await sharp(imagePath).extract(crop).jpeg({ quality: 92 }).toFile(outputPath);
  return { path: outputPath, dataPath: toDataRelativePath(outputPath), crop };
}

function promptForField(fieldName) {
  return `只辨識台灣三聯式發票裁切圖中的 ${fieldName}。只回傳 JSON，不要 Markdown，不要解釋。看不清楚填 null，不要推算金額。`;
}

export async function runOllamaVisionForField(imagePath, fieldName, cropInfo) {
  if (process.env.OLLAMA_ENABLED !== "true") return { ok: false, skipped: true, warning: "ollama_disabled" };
  const baseUrl = String(process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");
  const model = process.env.OLLAMA_MODEL || "qwen2.5vl:7b";
  try {
    const image = readFileSync(cropInfo?.path || imagePath).toString("base64");
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: promptForField(fieldName), images: [image], stream: false, format: "json", options: { temperature: 0, num_predict: 240 } }),
      signal: AbortSignal.timeout(45000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `Ollama HTTP ${response.status}`);
    const text = String(data.response || "{}");
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return { ok: true, fieldName, parsed, crop: cropInfo?.dataPath || null };
  } catch {
    return { ok: false, warning: "ollama_unavailable" };
  }
}

export async function enhanceLowConfidenceFieldsWithOllama(record, imagePath) {
  const next = { ...record, warnings: [...(record.warnings || [])], ollamaResults: [] };
  if (!needsOllama(next)) return next;
  const fields = [];
  if (!next.invoiceNumber) fields.push("invoiceNumber");
  if (!next.taxId) fields.push("buyerTaxId");
  if (!next.items?.length || next.items.some((item) => !item.itemName || item.quantity == null || item.unitPrice == null)) fields.push("items");
  if (!next.sellerName) fields.push("sellerName");
  for (const fieldName of fields) {
    const crop = await cropRegionForField(imagePath, fieldName);
    const result = await runOllamaVisionForField(imagePath, fieldName, crop);
    next.ollamaResults.push(result);
    if (!result.ok) {
      if (result.warning === "ollama_unavailable") next.warnings.push("ollama_unavailable");
      continue;
    }
    const parsed = result.parsed || {};
    if (fieldName === "invoiceNumber" && !next.invoiceNumber && parsed.invoiceNumber) next.invoiceNumber = parsed.invoiceNumber;
    if (fieldName === "buyerTaxId" && !next.taxId && (parsed.buyerTaxId || parsed.taxId)) next.taxId = parsed.buyerTaxId || parsed.taxId;
    if (fieldName === "sellerName" && !next.sellerName && parsed.sellerName) next.sellerName = parsed.sellerName;
    if (fieldName === "items" && (!next.items?.length) && Array.isArray(parsed.items)) next.items = parsed.items.map((item) => ({ itemName: item.itemName || item.name || "", quantity: item.quantity, unitPrice: item.unitPrice, source: "ollama", confidence: 0.55 }));
  }
  return next;
}

export async function recognizeInvoiceWithHybrid(imagePath) {
  const providerEvents = [];
  let paddleRaw = null;
  let record = { warnings: [], items: [], fieldSources: {}, fieldStatuses: {}, confidence: {} };
  try {
    paddleRaw = await runPaddleOcr(imagePath);
    providerEvents.push({ provider: "paddleocr", ok: true });
    record = extractInvoiceFieldsFromPaddleOcr(paddleRaw);
  } catch (error) {
    providerEvents.push({ provider: "paddleocr", ok: false, error: error?.message || "paddleocr_unavailable" });
    record.warnings.push("paddleocr_unavailable");
  }
  record = normalizeInvoiceRecord(record);
  record = await enhanceLowConfidenceFieldsWithOllama(record, imagePath);
  record = validateInvoiceRecord(normalizeInvoiceRecord(record));
  const warnings = [...new Set(record.warnings || [])];
  const itemStatus = (fieldName) => {
    if (!record.items?.length || record.items.some((item) => item[fieldName] == null)) return "manual_required";
    if (record.fieldStatuses?.[fieldName] === "low_confidence" || record.items.some((item) => item.status === "low_confidence")) return "low_confidence";
    return record.fieldStatuses?.[fieldName] || "auto";
  };
  const fieldStatuses = {
    invoiceNumber: record.invoiceNumber ? (record.fieldStatuses?.invoiceNumber || (warnings.includes("invoice_number_missing_prefix") ? "manual_required" : "auto")) : "manual_required",
    taxId: record.taxId ? (record.fieldStatuses?.taxId || (warnings.includes("buyer_tax_id_same_as_invoice_number") ? "manual_required" : "auto")) : "manual_required",
    quantity: itemStatus("quantity"),
    unitPrice: itemStatus("unitPrice"),
    salesAmount: record.salesAmount != null ? (itemStatus("quantity") === "low_confidence" || itemStatus("unitPrice") === "low_confidence" ? "low_confidence" : "auto") : "manual_required",
    taxAmount: record.taxAmount != null ? (itemStatus("quantity") === "low_confidence" || itemStatus("unitPrice") === "low_confidence" ? "low_confidence" : "auto") : "manual_required",
    totalAmount: record.totalAmount != null ? (itemStatus("quantity") === "low_confidence" || itemStatus("unitPrice") === "low_confidence" ? "low_confidence" : "auto") : "manual_required"
  };
  const confidenceObject = {
    invoiceNumber: fieldStatuses.invoiceNumber === "auto" ? 0.85 : 0,
    taxId: fieldStatuses.taxId === "auto" ? 0.85 : fieldStatuses.taxId === "low_confidence" ? 0.65 : 0,
    quantity: fieldStatuses.quantity === "auto" ? 0.75 : 0,
    unitPrice: fieldStatuses.unitPrice === "auto" ? 0.75 : 0,
    salesAmount: fieldStatuses.salesAmount === "auto" ? 0.75 : 0,
    taxAmount: fieldStatuses.taxAmount === "auto" ? 0.75 : 0,
    totalAmount: fieldStatuses.totalAmount === "auto" ? 0.75 : 0
  };
  const validationErrors = Object.entries(fieldStatuses)
    .filter(([, status]) => status === "manual_required")
    .map(([fieldName, status]) => ({ field: fieldName, reason: "需人工確認", status, severity: "required", source: record.fieldSources?.[fieldName] || "paddleocr" }));
  const reviewStatus = deriveReviewStatus({
    validationErrors,
    fieldStatuses,
    warnings
  });
  return {
    flatFields: {
      invoiceNumber: record.invoiceNumber || "",
      taxId: record.taxId || "",
      sellerName: record.sellerName || "",
      items: record.items || [],
      quantity: (record.items || []).map((item) => item.quantity).filter((value) => value != null).join(","),
      unitPrice: (record.items || []).map((item) => item.unitPrice).filter((value) => value != null).join(","),
      salesAmount: record.salesAmount != null ? String(record.salesAmount) : "",
      taxAmount: record.taxAmount != null ? String(record.taxAmount) : "",
      totalAmount: record.totalAmount != null ? String(record.totalAmount) : ""
    },
    meta: {
      confidence: confidenceObject,
      fieldSources: { invoiceNumber: "paddleocr", taxId: "paddleocr", quantity: "paddleocr", unitPrice: "paddleocr", salesAmount: "formula", taxAmount: "formula", totalAmount: "formula" },
      fieldStatuses,
      reviewStatus,
      validationErrors
    },
    record: { ...record, reviewStatus },
    providerEvents,
    paddleRaw
  };
}
