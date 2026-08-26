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
  const amount = compatible(a.amount, b.amount, "amount");
  const aCenter = center(bbox(a));
  const bCenter = center(bbox(b));
  const sameBand = aCenter && bCenter
    ? Math.abs(aCenter.y - bCenter.y) <= Math.max(20, Math.max(aCenter.height, bCenter.height) * 1.75)
    : false;
  if (name && (quantity || unitPrice || amount)) return 0.98;
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
  return {
    lineNo: Number(row.lineNo || index + 1),
    itemName: text(row.itemName ?? row.name),
    quantity: number(row.quantity?.value ?? row.quantity),
    unitPrice: number(row.unitPrice?.value ?? row.unitPrice ?? row.unit_price),
    amount: number(row.amount?.value ?? row.amount),
    confidence: confidence(row.confidence),
    source: row.source || row.quantity?.source || row.unitPrice?.source || "unknown",
    status: row.status || "needs_review",
    rowBbox: bbox(row),
    rowId: row.rowId || null,
    cells: row.cells || null,
    evidence: row.evidence || null,
    quantityEvidence: row.quantityEvidence || null,
    unitPriceEvidence: row.unitPriceEvidence || null,
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
      buyerTaxId: text(predicted.buyerTaxId ?? predicted.taxId),
      items: (Array.isArray(predicted.items) ? predicted.items : []).map(normalizeRow),
      salesAmount: number(predicted.salesAmount ?? predicted.amount),
      taxAmount: number(predicted.taxAmount ?? predicted.tax),
      totalAmount: number(predicted.totalAmount ?? predicted.total)
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
    if (!candidates.length) return { value: fieldName === "invoiceNumber" || fieldName === "buyerTaxId" ? "" : null, confidence: 0, sourcePages: [], conflicts: [] };
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
        for (const field of ["itemName", "quantity", "unitPrice", "amount"]) {
          const current = candidate[field];
          const incoming = row[field];
          if (current == null || current === "") candidate[field] = incoming;
          else if (incoming != null && incoming !== "" && !compatible(current, incoming, field)) candidate.conflicts.push({ field, retained: current, alternate: incoming, sourcePage: page.filename });
        }
        candidate.confidence = Math.min(1, Math.max(candidate.confidence, row.confidence) + 0.05);
      });
    }
    return merged.map((row, index) => ({ ...row, lineNo: index + 1, sourcePages: [...new Set(row.sourcePages)], sourceRows: row.sourceRows, agreement: row.agreement, conflicts: row.conflicts, identityStrength: row.identityScore >= 0.98 ? "strong" : "moderate" }));
  }

  toCanonical() {
    const invoice = this.mergeField("invoiceNumber");
    const buyer = this.mergeField("buyerTaxId");
    const items = this.mergeItems();
    const salesAmount = items.every((item) => item.quantity != null && item.unitPrice != null)
      ? items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
      : null;
    const taxAmount = salesAmount == null ? null : Math.round(salesAmount * 0.05);
    return {
      documentId: this.documentId,
      sourceImageIds: this.pages.map((page) => page.imageId),
      observationCount: this.pages.length,
      observationType: this.pages.length > 1 ? "MULTIPLE_SINGLE_COMPLETE" : "SINGLE_COMPLETE",
      invoiceNumber: invoice.value,
      buyerTaxId: buyer.value,
      items,
      salesAmount,
      taxAmount,
      totalAmount: salesAmount == null ? null : salesAmount + taxAmount,
      mergeEvidence: { invoice, buyer, rows: items.map((item) => ({ sourcePageCount: item.sourcePages.length, agreement: item.agreement, conflictCount: item.conflicts.length, identityStrength: item.identityStrength })) }
    };
  }
}

export function buildInvoiceDocument(input) {
  if (input instanceof InvoiceDocument) return input;
  return new InvoiceDocument(input);
}
