import { EXCLUDED_SELLER_TAX_IDS } from "./companyInvoiceProfiles.js";

const CORE_FIELDS = ["invoiceNumber", "taxId", "quantity", "unitPrice", "salesAmount"];
const MIN_CONFIDENCE = 0.6;
const FIELD_MIN_CONFIDENCE = {
  invoiceNumber: 0.6,
  taxId: 0.8,
  quantity: 0.8,
  unitPrice: 0.8,
  salesAmount: 0.8
};

function digits(value) {
  return String(value ?? "").replace(/[^\d]/g, "");
}

function numberList(value) {
  return String(value ?? "")
    .split(/[,\s/]+/)
    .map((part) => digits(part))
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function formatNumberList(values) {
  return values.map((value) => String(value)).join(",");
}

function confidenceFor(raw, field) {
  const value = Number(raw?.confidence?.[field] ?? 0);
  if (!Number.isFinite(value)) return 0;
  return value > 1 ? Math.min(1, value / 100) : Math.max(0, Math.min(1, value));
}

function normalizeInvoiceNumber(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function addError(errors, field, reason) {
  errors.push({ field, reason });
}

export function emptyOfficialFields() {
  return {
    invoiceNumber: "",
    taxId: "",
    itemName: "",
    quantity: "",
    unitPrice: "",
    salesAmount: "",
    taxAmount: "",
    totalAmount: ""
  };
}

export function calculateTaxAndTotal(salesAmount) {
  const sales = Number(digits(salesAmount));
  if (!Number.isFinite(sales) || sales <= 0) return { taxAmount: "", totalAmount: "" };
  const taxAmount = Math.round(sales * 0.05);
  return {
    taxAmount: String(taxAmount),
    totalAmount: String(sales + taxAmount)
  };
}

export function validateInvoiceRecord(rawInput = {}) {
  const raw = {
    invoiceNumber: rawInput.invoiceNumber ?? rawInput.invoice_number ?? "",
    taxId: rawInput.taxId ?? rawInput.tax_id ?? "",
    quantity: rawInput.quantity ?? "",
    unitPrice: rawInput.unitPrice ?? rawInput.unit_price ?? "",
    salesAmount: rawInput.salesAmount ?? rawInput.sales_amount ?? "",
    confidence: rawInput.confidence && typeof rawInput.confidence === "object" ? rawInput.confidence : {}
  };
  const validationErrors = [];
  const official = emptyOfficialFields();
  const confidence = Object.fromEntries(CORE_FIELDS.map((field) => [field, confidenceFor(raw, field)]));

  const invoiceNumber = normalizeInvoiceNumber(raw.invoiceNumber);
  if (confidence.invoiceNumber < FIELD_MIN_CONFIDENCE.invoiceNumber) addError(validationErrors, "invoiceNumber", "信心分數低於 0.6");
  else if (!/^[A-Z]{2}\d{8}$/.test(invoiceNumber)) addError(validationErrors, "invoiceNumber", "發票號碼必須為 2 個英文字母 + 8 位數字");
  else if (EXCLUDED_SELLER_TAX_IDS.has(invoiceNumber.slice(2))) addError(validationErrors, "invoiceNumber", "發票號碼不可使用賣方統編或印章統編");
  else official.invoiceNumber = invoiceNumber;

  const taxId = digits(raw.taxId);
  if (confidence.taxId < FIELD_MIN_CONFIDENCE.taxId) addError(validationErrors, "taxId", "手寫統編信心分數低於 0.8");
  else if (!/^\d{8}$/.test(taxId)) addError(validationErrors, "taxId", "統一編號必須為 8 位數字");
  else official.taxId = taxId;

  const quantityValues = numberList(raw.quantity);
  if (confidence.quantity < FIELD_MIN_CONFIDENCE.quantity) addError(validationErrors, "quantity", "手寫數量信心分數低於 0.8");
  else if (!quantityValues.length || quantityValues.some((value) => value <= 0 || value > 999)) addError(validationErrors, "quantity", "數量必須為 1~999 的正整數，可用逗號分隔多筆");
  else official.quantity = formatNumberList(quantityValues);

  const unitPriceValues = numberList(raw.unitPrice);
  if (confidence.unitPrice < FIELD_MIN_CONFIDENCE.unitPrice) addError(validationErrors, "unitPrice", "手寫單價信心分數低於 0.8");
  else if (!unitPriceValues.length || unitPriceValues.some((value) => value <= 0)) addError(validationErrors, "unitPrice", "單價必須為正整數，可用逗號分隔多筆");
  else if (unitPriceValues.some((value) => value > 1000000)) addError(validationErrors, "unitPrice", "單價超過合理範圍");
  else official.unitPrice = formatNumberList(unitPriceValues);

  if (official.quantity && official.unitPrice) {
    if (quantityValues.length !== unitPriceValues.length) {
      addError(validationErrors, "salesAmount", "數量與單價筆數不一致，請用逗號逐筆對齊");
    } else {
      const salesAmount = String(quantityValues.reduce((sum, quantity, index) => sum + quantity * unitPriceValues[index], 0));
      official.salesAmount = salesAmount;
      confidence.salesAmount = Math.min(confidence.quantity, confidence.unitPrice);
      Object.assign(official, calculateTaxAndTotal(salesAmount));
    }
  }

  if (!official.invoiceNumber) {
    official.quantity = "";
    official.unitPrice = "";
    official.salesAmount = "";
    official.taxAmount = "";
    official.totalAmount = "";
  }

  return {
    official,
    confidence,
    validationErrors,
    rawJson: raw,
    validatedJson: {
      ...official,
      confidence,
      validationErrors
    }
  };
}
