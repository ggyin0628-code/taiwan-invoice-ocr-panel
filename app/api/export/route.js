import * as XLSX from "xlsx";
import { readRecords } from "../../../lib/server/records.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function numberValue(value) {
  const number = Number(String(value || "").replace(/[^\d]/g, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function numberList(value) {
  return String(value || "")
    .split(/[,\s/]+/)
    .map((part) => part.replace(/[^\d]/g, ""))
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function recordItems(record) {
  if (Array.isArray(record.items) && record.items.length) {
    return record.items
      .map((item, index) => {
        const quantity = Number(item.quantity);
        const unitPrice = Number(item.unitPrice);
        return {
          lineNo: item.lineNo || index + 1,
          itemName: item.itemName || item.name || "",
          quantity: Number.isFinite(quantity) ? quantity : null,
          unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
          amount: Number.isFinite(Number(item.amount))
            ? Number(item.amount)
            : Number.isFinite(quantity) && Number.isFinite(unitPrice)
              ? quantity * unitPrice
              : null
        };
      })
      .filter((item) => item.quantity != null || item.unitPrice != null || item.amount != null);
  }
  const quantities = numberList(record.quantity);
  const unitPrices = numberList(record.unitPrice);
  const length = Math.max(quantities.length, unitPrices.length, 1);
  return Array.from({ length }, (_, index) => {
    const quantity = quantities[index] ?? null;
    const unitPrice = unitPrices[index] ?? null;
    return {
      lineNo: index + 1,
      itemName: "",
      quantity,
      unitPrice,
      amount: quantity != null && unitPrice != null ? quantity * unitPrice : null
    };
  });
}

export async function GET() {
  const records = readRecords();
  // 明細序號：recordItems(record) keeps multi-item invoices expanded one item per row.
  const rows = records.flatMap((record) => {
    const items = recordItems(record);
    return items.map((item, index) => {
      const isLastLine = index === items.length - 1;
      return {
        發票號碼: record.invoiceNumber,
        統一編號: record.taxId,
        品名: item.itemName || record.itemName || "",
        數量: item.quantity ?? "",
        單價: item.unitPrice ?? "",
        金額: item.amount ?? "",
        稅金: isLastLine ? numberValue(record.taxAmount) ?? "" : "",
        總金額: isLastLine ? numberValue(record.totalAmount) ?? "" : "",
        是否確認: record.confirmed || record.status === "confirmed" ? "已確認" : "未確認",
        信心等級: record.confidenceLevel || "",
        警告: Array.isArray(record.warnings) ? record.warnings.join(", ") : "",
        圖片檔名: record.filename
      };
    });
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const lastDataRow = rows.length + 1;
  worksheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length), c: 11 } }) };
  worksheet["!cols"] = [
    { wch: 14 }, { wch: 12 }, { wch: 24 }, { wch: 10 }, { wch: 14 }, { wch: 14 },
    { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 36 }, { wch: 28 }
  ];
  const totalRow = rows.length + 2;
  XLSX.utils.sheet_add_aoa(worksheet, [["", "", "", "", "合計"]], { origin: `A${totalRow}` });
  const amountTotal = rows.reduce((sum, row) => sum + (Number(row.金額) || 0), 0);
  const taxTotal = rows.reduce((sum, row) => sum + (Number(row.稅金) || 0), 0);
  const grandTotal = rows.reduce((sum, row) => sum + (Number(row.總金額) || 0), 0);
  worksheet[`F${totalRow}`] = { t: "n", v: amountTotal };
  worksheet[`G${totalRow}`] = { t: "n", v: taxTotal };
  worksheet[`H${totalRow}`] = { t: "n", v: grandTotal };
  for (const column of ["D", "E", "F", "G", "H"]) {
    for (let row = 2; row <= totalRow; row += 1) {
      if (worksheet[`${column}${row}`]) worksheet[`${column}${row}`].z = "#,##0";
    }
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "財務收據紀錄");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  return new Response(buffer, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="finance-receipts-${new Date().toISOString().slice(0, 10)}.xlsx"`
    }
  });
}
