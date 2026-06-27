import { readRecords, updateRecord } from "../../../../../lib/server/records.js";
import { publicFileUrl } from "../../../../../lib/server/paths.js";
import { processInvoiceRecord } from "../../../../../lib/server/processInvoice.js";

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

export async function POST(request, context) {
  const { id } = await context.params;
  const url = new URL(request.url);
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const provider = body.provider
    || url.searchParams.get("provider")
    || body.mode
    || url.searchParams.get("mode")
    || process.env.OCR_PROVIDER
    || "local";
  const current = readRecords().find((record) => record.id === id);
  if (!current) return Response.json({ error: "record not found" }, { status: 404 });

  updateRecord(id, { processingStatus: "processing" });
  try {
    const result = await processInvoiceRecord(current, { provider });
    const updated = updateRecord(id, result);
    return Response.json({ record: present(updated) });
  } catch (error) {
    const updated = updateRecord(id, {
      processingStatus: "failed",
      validationErrors: [{ field: "ocr", reason: error?.message || "OCR failed" }],
      debug: {
        ...(current.debug || {}),
        validationErrors: [{ field: "ocr", reason: error?.message || "OCR failed" }]
      }
    });
    return Response.json({ record: present(updated), error: error?.message || "OCR failed" }, { status: 500 });
  }
}
