import { readRecords } from "../../../lib/server/records.js";
import { publicFileUrl } from "../../../lib/server/paths.js";

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

export async function GET() {
  return Response.json({ records: readRecords().map(present) });
}
