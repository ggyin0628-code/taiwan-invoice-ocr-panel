export function numericValue(value, { allowDecimal = true } = {}) {
  if (value == null || String(value).trim() === "") return null;
  const normalized = String(value).replace(/,/g, "").trim();
  if (!allowDecimal && !/^\d+$/.test(normalized)) return null;
  if (allowDecimal && !/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function normalizeLineItem(item = {}, index = 0) {
  const quantity = numericValue(item.quantity);
  const unitPrice = numericValue(item.unitPrice ?? item.unit_price, { allowDecimal: false });
  const complete = quantity != null && unitPrice != null;
  const previousStatus = String(item.status || "");
  return {
    lineNo: index + 1,
    itemName: String(item.itemName ?? item.name ?? "").trim().slice(0, 80),
    quantity,
    unitPrice,
    amount: complete ? quantity * unitPrice : null,
    confidence: Math.max(0, Math.min(1, Number(item.confidence) > 1 ? Number(item.confidence) / 100 : Number(item.confidence ?? (complete ? 1 : 0)))),
    source: String(item.source || (previousStatus === "confirmed" ? "manual" : "manual")),
    status: previousStatus === "confirmed" && complete ? "confirmed" : complete ? previousStatus || "auto" : "manual_required"
  };
}

export function normalizeLineItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => normalizeLineItem(item, index))
    .filter((item) => item.itemName || item.quantity != null || item.unitPrice != null || item.amount != null);
}

export function lineItemsFromLegacy(quantityValue, unitPriceValue, existingItems = []) {
  const quantities = String(quantityValue ?? "").split(/[,\s/]+/).filter(Boolean);
  const unitPrices = String(unitPriceValue ?? "").split(/[,\s/]+/).filter(Boolean);
  const length = Math.max(quantities.length, unitPrices.length, existingItems.length);
  return normalizeLineItems(Array.from({ length }, (_, index) => ({
    ...(existingItems[index] || {}),
    quantity: quantities[index] ?? existingItems[index]?.quantity ?? null,
    unitPrice: unitPrices[index] ?? existingItems[index]?.unitPrice ?? null
  })));
}

export function legacyFieldsFromLineItems(items = []) {
  const normalized = normalizeLineItems(items);
  return {
    quantity: normalized.map((item) => item.quantity ?? "").join(","),
    unitPrice: normalized.map((item) => item.unitPrice ?? "").join(",")
  };
}

export function formulaTotals(items = []) {
  const normalized = normalizeLineItems(items);
  const complete = normalized.length > 0 && normalized.every((item) => item.quantity != null && item.unitPrice != null);
  if (!complete) return { salesAmount: "", taxAmount: "", totalAmount: "", amountSource: "none", complete: false };
  const salesAmount = normalized.reduce((sum, item) => sum + item.amount, 0);
  const taxAmount = Math.round(salesAmount * 0.05);
  return {
    salesAmount: String(salesAmount),
    taxAmount: String(taxAmount),
    totalAmount: String(salesAmount + taxAmount),
    amountSource: "formula",
    complete: true
  };
}
