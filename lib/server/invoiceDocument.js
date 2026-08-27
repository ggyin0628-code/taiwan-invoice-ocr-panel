import { buildFinancialCore, calculateDeterministicFinancials } from "./financialCore.js";

function text(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, "").trim();
}

function number(value) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function confidence(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed > 1 ? Math.max(0, Math.min(1, parsed / 100)) : Math.max(0, Math.min(1, parsed));
}

function bbox(item) {
  return item?.rowBbox || item?.rowBox || item?.bbox || null;
}

function center(box) {
  if (!box) return null;
  const x1 = Number(box.x1 ?? box.left ?? 0);
  const x2 = Number(box.x2 ?? (x1 + Number(box.width || 0)));
  const y1 = Number(box.y1 ?? box.top ?? 0);
  const y2 = Number(box.y2 ?? (y1 + Number(box.height || 0)));
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2, height: Math.max(1, y2 - y1) };
}

function compatible(a, b, field) {
  if (!a || !b) return false;
  if (field === "itemName") return text(a) !== "" && text(a) === text(b);
  return number(a) != null && number(a) === number(b);
}

function rowIdentityScore(a, b) {
  const name = compatible(a.itemName, b.itemName, "itemName");
  const quantity = compatible(a.quantity, b.quantity, "quantity");
  const unitPrice = compatible(a.unitPrice, b.unitPrice, "unitPrice");
  const amount = compatible(a.amount ?? a.lineAmount, b.amount ?? b.lineAmount, "amount");
  const aCenter = center(bbox(a));
  const bCenter = center(bbox(b));
  const sameBand = aCenter && bCenter
    ? Math.abs(aCenter.y - bCenter.y) <= Math.max(20, Math.max(aCenter.height, bCenter.height) * 1.75)
    : false;
  if (name && (quantity || unitPrice || amount)) return 0.98;
  if (amount && (sameBand || !aCenter || !bCenter)) return 0.94;
  if (quantity && unitPrice && (sameBand || !aCenter || !bCenter)) return 0.92;
  if (name && sameBand) return 0.90;
  return 0;
}

function normalizeField(field, fallback = {}) {
  if (field && typeof field === "object" && Object.prototype.hasOwnProperty.call(field, "value")) {
    return { ...field, confidence: confidence(field.confidence), value: field.value ?? null };
  }
  return { value: field ?? null, confidence: confidence(fallback.confidence), source: fallback.source || "unknown", status: fallback.status || "needs_review", reason: fallback.reason || "" };
}

function normalizeRow(row = {}, index = 0) {
  const lineAmount = number(row.lineAmount?.value ?? row.lineAmount ?? row.amount?.value ?? row.amount ?? row.salesAmount);
  return {
    lineNo: Number(row.lineNo || index + 1),
    itemName: text(row.itemName ?? row.name),
    quantity: number(row.quantity?.value ?? row.quantity),
    unitPrice: number(row.unitPrice?.value ?? row.unitPrice ?? row.unit_price),
    lineAmount,
    amount: lineAmount,
    confidence: confidence(row.confidence?.row ?? row.confidence),
    source: row.source || row.quantity?.source || row.unitPrice?.source || "unknown",
    status: row.status || "needs_review",
    rowBbox: bbox(row),
    rowId: row.rowId || null,
    cells: row.cells || null,
    evidence: row.evidence || null,
    quantityEvidence: row.quantityEvidence || row.evidence?.quantity || null,
    unitPriceEvidence: row.unitPriceEvidence || row.evidence?.unitPrice || null,
    lineAmountEvidence: row.lineAmountEvidence || row.amountEvidence || row.evidence?.amount || null,
    amountReference: row.amountReference || null
  };
}

export class InvoicePageEvidence {
  constructor({ imageId, filename, observationType = "SINGLE_COMPLETE", predicted = {}, debug = null, performance = {} } = {}) {
    this.imageId = imageId || filename || null;
    this.filename = filename || imageId || null;
    this.observationType = observationType;
    this.predicted = {
      invoiceNumber: text(predicted.invoiceNumber ?? predicted.invoiceNo),
      sellerTaxId: text(predicted.sellerTaxId),
      buyerTaxId: text(predicted.buyerTaxId ?? predicted.taxId),
      items: (Array.isArray(predicted.items) ? predicted.items : Array.isArray(predicted.financial?.lineAmounts) ? predicted.financial.lineAmounts : []).map(normalizeRow),
      salesAmount: number(predicted.salesAmount ?? predicted.amount ?? predicted.financial?.salesAmount?.value ?? predicted.financial?.salesAmount),
      taxAmount: number(predicted.taxAmount ?? predicted.tax ?? predicted.financial?.taxAmount?.value ?? predicted.financial?.taxAmount),
      totalAmount: number(predicted.totalAmount ?? predicted.total ?? predicted.financial?.totalAmount?.value ?? predicted.financial?.totalAmount)
    };
    this.debug = debug;
    this.performance = performance || {};
  }
}

export class InvoiceDocument {
  constructor({ documentId, pages = [] } = {}) {
    this.documentId = documentId || null;
    this.pages = [];
    for (const page of pages) this.addPage(page);
  }

  addPage(page) {
    const evidence = page instanceof InvoicePageEvidence ? page : new InvoicePageEvidence(page);
    this.pages.push(evidence);
    return this;
  }

  mergeField(fieldName) {
    const candidates = this.pages
      .map((page) => page.predicted[fieldName])
      .filter((value) => value != null && value !== "");
    if (!candidates.length) return { value: fieldName === "invoiceNumber" || fieldName === "sellerTaxId" || fieldName === "buyerTaxId" ? "" : null, confidence: 0, sourcePages: [], conflicts: [] };
    const grouped = new Map();
    for (const value of candidates) {
      const key = String(value);
      const existing = grouped.get(key) || { value, count: 0, pages: [], confidence: 0 };
      existing.count += 1;
      existing.confidence = Math.max(existing.confidence, 0.5);
      grouped.set(key, existing);
    }
    const ranked = [...grouped.values()].sort((a, b) => b.count - a.count || b.confidence - a.confidence);
    const selected = ranked[0];
    return {
      value: selected.value,
      confidence: Math.min(1, selected.confidence + (selected.count > 1 ? 0.15 : 0)),
      sourcePages: this.pages.filter((page) => String(page.predicted[fieldName] ?? "") === String(selected.value)).map((page) => page.filename),
      conflicts: ranked.slice(1).map((candidate) => ({ value: candidate.value, sourcePages: this.pages.filter((page) => String(page.predicted[fieldName] ?? "") === String(candidate.value)).map((page) => page.filename) }))
    };
  }

  mergeItems() {
    const merged = [];
    for (const page of this.pages) {
      page.predicted.items.forEach((row, index) => {
        let bestIndex = -1;
        let bestScore = 0;
        merged.forEach((candidate, candidateIndex) => {
          const score = rowIdentityScore(candidate, row);
          if (score > bestScore) { bestScore = score; bestIndex = candidateIndex; }
        });
        if (bestIndex < 0 || bestScore < 0.90) {
          merged.push({ ...row, sourcePages: [page.filename], sourceRows: [index + 1], agreement: 1, conflicts: [], identityScore: bestScore });
          return;
        }
        const candidate = merged[bestIndex];
        candidate.sourcePages.push(page.filename);
        candidate.sourceRows.push(index + 1);
        candidate.agreement += 1;
        for (const field of ["itemName", "quantity", "unitPrice", "lineAmount", "amount"]) {
          const current = candidate[field];
          const incoming = row[field];
          if (current == null || current === "") candidate[field] = incoming;
          else if (incoming != null && incoming !== "" && !compatible(current, incoming, field === "lineAmount" ? "amount" : field)) candidate.conflicts.push({ field, retained: current, alternate: incoming, sourcePage: page.filename });
        }
        if (candidate.lineAmount == null && candidate.amount != null) candidate.lineAmount = candidate.amount;
        if (candidate.amount == null && candidate.lineAmount != null) candidate.amount = candidate.lineAmount;
        candidate.confidence = Math.min(1, Math.max(candidate.confidence, row.confidence) + 0.05);
      });
    }
    return merged.map((row, index) => ({ ...row, lineNo: index + 1, sourcePages: [...new Set(row.sourcePages)], sourceRows: row.sourceRows, agreement: row.agreement, conflicts: row.conflicts, identityStrength: row.identityScore >= 0.98 ? "strong" : "moderate" }));
  }

  toCanonical() {
    const invoice = this.mergeField("invoiceNumber");
    const seller = this.mergeField("sellerTaxId");
    const buyer = this.mergeField("buyerTaxId");
    const sales = this.mergeField("salesAmount");
    const tax = this.mergeField("taxAmount");
    const total = this.mergeField("totalAmount");
    const items = this.mergeItems();
    const deterministicInput = items.map((item) => ({
      ...item,
      quantity: { value: item.quantity, status: item.quantity != null && item.status === "auto" ? "auto" : item.quantity != null ? "low_confidence" : "manual_required", confidence: item.confidence },
      unitPrice: { value: item.unitPrice, status: item.unitPrice != null && item.status === "auto" ? "auto" : item.unitPrice != null ? "low_confidence" : "manual_required", confidence: item.confidence },
      lineAmount: item.lineAmount == null ? null : { value: item.lineAmount, source: "paddleocr", status: "low_confidence", confidence: item.confidence }
    }));
    const deterministic = items.length ? calculateDeterministicFinancials({
      items: deterministicInput,
      printedSummary: {
        salesAmount: sales.value == null ? null : { value: sales.value },
        taxAmount: tax.value == null ? null : { value: tax.value },
        totalAmount: total.value == null ? null : { value: total.value }
      }
    }) : null;
    const canonicalItems = deterministic
      ? deterministic.items.map((item, index) => ({
        ...items[index],
        quantity: item.quantity?.value ?? null,
        unitPrice: item.unitPrice?.value ?? null,
        lineAmount: item.calculatedLineAmount?.value ?? null,
        amount: item.calculatedLineAmount?.value ?? null,
        financialVerification: item.financialVerification
      }))
      : items;
    const lineAmounts = canonicalItems.map((item) => item.lineAmount ?? item.amount).filter((value) => value != null);
    const salesAmount = deterministic ? deterministic.salesAmount.value : sales.value != null ? sales.value : lineAmounts.length ? lineAmounts.reduce((sum, value) => sum + value, 0) : null;
    const financial = buildFinancialCore({
      sellerTaxId: { value: seller.value, status: seller.value ? "auto" : "manual_required", confidence: seller.confidence },
      buyerTaxId: { value: buyer.value, status: buyer.value ? "auto" : "manual_required", confidence: buyer.confidence },
      items: deterministic ? deterministic.items : items,
      salesAmount: deterministic ? deterministic.salesAmount : { value: salesAmount, status: salesAmount != null ? "auto" : "manual_required", confidence: sales.confidence },
      taxAmount: deterministic ? deterministic.taxAmount : { value: tax.value, status: tax.value != null ? "auto" : "manual_required", confidence: tax.confidence },
      totalAmount: deterministic ? deterministic.totalAmount : { value: total.value, status: total.value != null ? "auto" : "manual_required", confidence: total.confidence },
      optionalEvidenceAvailable: canonicalItems.every((item) => item.quantity != null && item.unitPrice != null && item.itemName),
      confidence: Math.min(seller.confidence, sales.confidence, total.confidence),
      calculation: deterministic
    });
    return {
      documentId: this.documentId,
      sourceImageIds: this.pages.map((page) => page.imageId),
      observationCount: this.pages.length,
      observationType: this.pages.length > 1 ? "MULTIPLE_SINGLE_COMPLETE" : "SINGLE_COMPLETE",
      invoiceNumber: invoice.value,
      sellerTaxId: seller.value,
      buyerTaxId: buyer.value,
      items: canonicalItems,
      lineAmounts,
      salesAmount,
      taxAmount: deterministic ? deterministic.taxAmount.value : tax.value,
      totalAmount: deterministic ? deterministic.totalAmount.value : total.value,
      financial,
      financialStatus: financial.status,
      mergeEvidence: {
        invoice,
        seller,
        buyer,
        sales,
        tax,
        total,
        rows: items.map((item) => ({ sourcePageCount: item.sourcePages.length, agreement: item.agreement, conflictCount: item.conflicts.length, identityStrength: item.identityStrength }))
      }
    };
  }
}

export function validateDocumentBoundary({ documents = [] } = {}) {
  const imageToDocument = new Map();
  for (const document of documents) {
    const documentId = String(document?.documentId || "");
    const images = document?.sourceImageIds || document?.sourcePageIds || document?.images || [];
    if (!documentId || !Array.isArray(images) || images.length === 0) throw new Error("invalid document boundary entry");
    for (const image of images) {
      const imageId = String(image);
      if (imageToDocument.has(imageId)) throw new Error(`image mapped to multiple documents: ${imageId}`);
      imageToDocument.set(imageId, documentId);
    }
    const observationType = document?.observationType || "SINGLE_COMPLETE";
    if (observationType !== "SINGLE_COMPLETE" && observationType !== "MULTIPLE_SINGLE_COMPLETE") throw new Error("document observations must be complete views");
  }
  return { documentCount: documents.length, imageCount: imageToDocument.size, imageToDocument: Object.fromEntries(imageToDocument) };
}

export function buildInvoiceDocument(input) {
  if (input instanceof InvoiceDocument) return input;
  return new InvoiceDocument(input);
}
