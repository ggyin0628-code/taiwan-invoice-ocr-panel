import { readTemplates, saveTemplate } from "../../../lib/server/templates.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ templates: readTemplates() });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const template = await saveTemplate(body);
    return Response.json({ template, templates: readTemplates() });
  } catch (error) {
    return Response.json({ error: error?.message || "template save failed" }, { status: 400 });
  }
}
