import { publicFileUrl } from "../../../../lib/server/paths.js";
import { deleteRecord, readRecords, updateRecord } from "../../../../lib/server/records.js";
import { calculateTaxAndTotal, validateInvoiceRecord } from "../../../../lib/server/validation.js";
import { REVIEW_STATUS } from "../../../../lib/server/invoiceStatus.js";
import { formulaTotals, legacyFieldsFromLineItems, normalizeLineItem, normalizeLineItems } from "../../../../lib/server/lineItems.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function present(record) {
  return {
    ...record,
    imageUrl: record.imagePath ? publicFileUrl(record.imagePath) : "",
    thumbnailUrl: record.thumbnailPath ? publicFileUrl(record.thumbnailPath) : "",
    correctedImageUrl: record.correctedImagePath ? publicFileUrl(record.correctedImagePath) : ""
  };
}

function numberList(value) {
  return String(value || "")
    .split(/[,\s/]+/)
    .map((part) => part.replace(/[^\d]/g, ""))
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function calculatedSalesAmount(quantityValue, unitPriceValue) {
  const quantities = numberList(quantityValue);
  const unitPrices = numberList(unitPriceValue);
  if (!quantities.length || quantities.length !== unitPrices.length) return 0;
  return quantities.reduce((sum, quantity, index) => sum + quantity * unitPrices[index], 0);
}

function buildItems(quantityValue, unitPriceValue, existingItems = []) {
  const quantities = numberList(quantityValue);
  const unitPrices = numberList(unitPriceValue);
  const length = Math.max(quantities.length, unitPrices.length);
  return Array.from({ length }, (_, index) => {
    const quantity = quantities[index] ?? null;
    const unitPrice = unitPrices[index] ?? null;
    return {
      lineNo: index + 1,
      itemName: existingItems[index]?.itemName || existingItems[index]?.name || "",
      quantity,
      unitPrice,
      amount: quantity != null && unitPrice != null ? quantity * unitPrice : null,
      source: "manual",
      status: quantity != null && unitPrice != null ? "auto" : "manual_required",
      confidence: quantity != null && unitPrice != null ? 1 : 0
    };
  });
}

function validationInput(current, patch) {
  return {
    ...current,
    ...patch,
    items: patch.items ?? current.items,
    confidence: Object.fromEntries(["invoiceNumber", "taxId", "quantity", "unitPrice", "salesAmount"].map((field) => [field, 1]))
  };
}

function applyValidationPatch(patch, validation, reviewStatus) {
  patch.validationErrors = validation.validationErrors;
  patch.debug = {
    ...(patch.debug || {}),
    validatedJson: validation.validatedJson,
    validationErrors: validation.validationErrors
  };
  patch.processingStatus = validation.validationErrors.length ? "need_review" : "done";
  patch.reviewStatus = reviewStatus;
  patch.warnings = validation.validationErrors.map((error) => error.reason);
  patch.confidenceLevel = validation.validationErrors.length ? "low" : "high";
  if (!validation.validationErrors.length) {
    Object.assign(patch, validation.official);
    patch.amountSource = "formula";
  }
}

export async function PATCH(request, context) {
  const { id } = await context.params;
  const body = await request.json();
  const current = readRecords().find((record) => record.id === id);
  if (!current) return Response.json({ error: "record not found" }, { status: 404 });

  const patch = {};
  for (const field of ["invoiceNumber", "taxId", "quantity", "unitPrice", "salesAmount", "taxAmount", "totalAmount"]) {
    if (Object.prototype.hasOwnProperty.call(body, field)) patch[field] = String(body[field] || "");
  }
  let lineItemsEdited = false;
  if (Array.isArray(body.items)) {
    const items = body.items.map((item, index) => normalizeLineItem(item, index));
    patch.items = items;
    Object.assign(patch, legacyFieldsFromLineItems(items));
    const totals = formulaTotals(items);
    patch.salesAmount = totals.salesAmount;
    patch.taxAmount = totals.taxAmount;
    patch.totalAmount = totals.totalAmount;
    patch.amountSource = totals.amountSource;
    lineItemsEdited = true;
  }
  if (!lineItemsEdited && (Object.prototype.hasOwnProperty.call(body, "quantity") || Object.prototype.hasOwnProperty.call(body, "unitPrice"))) {
    const nextQuantity = patch.quantity ?? current.quantity ?? "";
    const nextUnitPrice = patch.unitPrice ?? current.unitPrice ?? "";
    patch.items = buildItems(nextQuantity, nextUnitPrice, current.items || []);
    const sales = calculatedSalesAmount(nextQuantity, nextUnitPrice);
    if (sales > 0) {
      const salesAmount = String(sales);
      patch.salesAmount = salesAmount;
      Object.assign(patch, calculateTaxAndTotal(salesAmount));
    } else {
      patch.salesAmount = "";
      patch.taxAmount = "";
      patch.totalAmount = "";
    }
    patch.amountSource = sales > 0 ? "formula" : "none";
  }
  if (
    Object.prototype.hasOwnProperty.call(body, "salesAmount")
    || Object.prototype.hasOwnProperty.call(body, "taxAmount")
    || Object.prototype.hasOwnProperty.call(body, "totalAmount")
  ) {
    patch.amountSource = "manual";
  }
  const editableFields = new Set(["invoiceNumber", "taxId", "quantity", "unitPrice", "salesAmount", "taxAmount", "totalAmount"]);
  const manuallyEditedFields = [...new Set([
    ...Object.keys(body).filter((field) => editableFields.has(field)),
    ...(lineItemsEdited ? ["items", "quantity", "unitPrice"] : [])
  ])];
  if (body.status === "confirmed" || body.status === "unconfirmed") {
    patch.status = body.status;
    patch.confirmed = body.status === "confirmed";
  }

  if (body.status === "confirmed") {
    const validation = validateInvoiceRecord(validationInput(current, patch));
    if (validation.validationErrors.length) {
      return Response.json({
        error: "資料仍有必須修正的欄位，無法確認",
        validationErrors: validation.validationErrors,
        record: present(current)
      }, { status: 422 });
    }
    Object.assign(patch, validation.official);
    patch.items = (current.items || patch.items || []).map((item, index) => ({
      ...item,
      lineNo: item.lineNo || index + 1,
      amount: Number(item.quantity) * Number(item.unitPrice),
      status: "auto",
      source: item.source || "manual"
    }));
    patch.processingStatus = "done";
    patch.reviewStatus = REVIEW_STATUS.AUTO_OK;
    patch.validationErrors = [];
    patch.warnings = [];
    patch.confidenceLevel = "high";
    patch.amountSource = "formula";
  } else if (Object.keys(patch).some((field) => field !== "status")) {
    const validation = validateInvoiceRecord(validationInput(current, patch));
    applyValidationPatch(
      patch,
      validation,
      validation.validationErrors.length ? REVIEW_STATUS.REVIEW_REQUIRED : REVIEW_STATUS.AUTO_OK
    );
  }

  if (manuallyEditedFields.length) {
    patch.fieldSources = {
      ...(current.fieldSources || {}),
      ...Object.fromEntries(manuallyEditedFields.map((field) => [field, "manual"]))
    };
    patch.fieldStatuses = {
      ...(current.fieldStatuses || {}),
      ...Object.fromEntries(manuallyEditedFields.map((field) => [field, "auto"]))
    };
    if (lineItemsEdited || manuallyEditedFields.includes("quantity") || manuallyEditedFields.includes("unitPrice")) {
      patch.fieldSources.salesAmount = "formula";
      patch.fieldSources.taxAmount = "formula";
      patch.fieldSources.totalAmount = "formula";
      patch.fieldStatuses.salesAmount = patch.salesAmount ? "auto" : "manual_required";
      patch.fieldStatuses.taxAmount = patch.taxAmount ? "auto" : "manual_required";
      patch.fieldStatuses.totalAmount = patch.totalAmount ? "auto" : "manual_required";
    }
  }

  const updated = updateRecord(id, patch);
  return Response.json({ record: present(updated) });
}

export async function DELETE(_request, context) {
  const { id } = await context.params;
  const records = deleteRecord(id);
  return Response.json({ records: records.map(present) });
}
