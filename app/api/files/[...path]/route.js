import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { fromDataRelativePath } from "../../../../lib/server/paths.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

export async function GET(_request, context) {
  const params = await context.params;
  const relative = `data/${(params.path || []).join("/")}`;
  const filePath = fromDataRelativePath(relative);
  if (!existsSync(filePath)) return new Response("not found", { status: 404 });
  const type = TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
  return new Response(readFileSync(filePath), {
    headers: {
      "content-type": type,
      "cache-control": "no-store"
    }
  });
}
