import { EXCLUDED_SELLER_TAX_IDS } from "./companyInvoiceProfiles.js";

const CORE_FIELDS = ["invoiceNumber", "taxId", "quantity", "unitPrice", "salesAmount"];
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

function addError(errors, field, reason, severity = "required") {
  errors.push({ field, reason, severity });
}

function itemPairs(rawInput) {
  if (Array.isArray(rawInput.items) && rawInput.items.length) {
    return rawInput.items.map((item) => ({
      itemName: String(item?.itemName ?? item?.name ?? "").slice(0, 80),
      quantity: item?.quantity ?? null,
      unitPrice: item?.unitPrice ?? item?.unit_price ?? null
    }));
  }
  const quantities = String(rawInput.quantity ?? "").split(/[,\s/]+/).filter(Boolean);
  const unitPrices = String(rawInput.unitPrice ?? rawInput.unit_price ?? "").split(/[,\s/]+/).filter(Boolean);
  const length = Math.max(quantities.length, unitPrices.length);
  return Array.from({ length }, (_, index) => ({
    itemName: index === 0 ? String(rawInput.itemName ?? "").slice(0, 80) : "",
    quantity: quantities[index] ?? null,
    unitPrice: unitPrices[index] ?? null
  }));
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
    itemName: rawInput.itemName ?? "",
    items: rawInput.items,
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
  else if (!/^[A-Z]{2}\d{8}$/.test(invoiceNumber)) addError(validationErrors, "invoiceNumber", "發票號碼必須為 2 個英文字母 + 8 位數字", "invalid");
  else if (EXCLUDED_SELLER_TAX_IDS.has(invoiceNumber.slice(2))) addError(validationErrors, "invoiceNumber", "發票號碼不可使用賣方統編或印章統編", "invalid");
  else official.invoiceNumber = invoiceNumber;

  const taxId = digits(raw.taxId);
  if (confidence.taxId < FIELD_MIN_CONFIDENCE.taxId) addError(validationErrors, "taxId", "手寫統編信心分數低於 0.8");
  else if (!/^\d{8}$/.test(taxId)) addError(validationErrors, "taxId", "統一編號必須為 8 位數字", "invalid");
  else if (invoiceNumber && taxId === invoiceNumber.slice(2)) addError(validationErrors, "taxId", "買受人統編不可與發票號碼後 8 碼相同", "invalid");
  else official.taxId = taxId;

  const pairs = itemPairs(raw);
  const quantityValues = pairs.map((item) => Number(digits(item.quantity))).filter((value) => Number.isFinite(value));
  const unitPriceValues = pairs.map((item) => Number(digits(item.unitPrice))).filter((value) => Number.isFinite(value));
  const hasAnyItemValue = pairs.some((item) => item.quantity != null && String(item.quantity).trim() || item.unitPrice != null && String(item.unitPrice).trim());
  if (confidence.quantity < FIELD_MIN_CONFIDENCE.quantity) addError(validationErrors, "quantity", "手寫數量信心分數低於 0.8");
  else if (!quantityValues.length || quantityValues.length !== pairs.length || quantityValues.some((value) => value <= 0 || value > 999)) addError(validationErrors, "quantity", "數量必須為 1~999 的正整數，且每一列都要有值", "invalid");
  else official.quantity = formatNumberList(quantityValues);

  if (confidence.unitPrice < FIELD_MIN_CONFIDENCE.unitPrice) addError(validationErrors, "unitPrice", "手寫單價信心分數低於 0.8");
  else if (!unitPriceValues.length || unitPriceValues.length !== pairs.length || unitPriceValues.some((value) => value <= 0)) addError(validationErrors, "unitPrice", "單價必須為正整數，且每一列都要有值", "invalid");
  else if (unitPriceValues.some((value) => value > 1000000)) addError(validationErrors, "unitPrice", "單價超過合理範圍", "invalid");
  else official.unitPrice = formatNumberList(unitPriceValues);

  if (official.quantity && official.unitPrice && quantityValues.length === unitPriceValues.length) {
    const salesAmount = String(quantityValues.reduce((sum, quantity, index) => sum + quantity * unitPriceValues[index], 0));
    official.salesAmount = salesAmount;
    confidence.salesAmount = Math.min(confidence.quantity, confidence.unitPrice);
    Object.assign(official, calculateTaxAndTotal(salesAmount));
  } else if (hasAnyItemValue) {
    addError(validationErrors, "salesAmount", "數量與單價必須逐列成對，才能計算金額");
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
