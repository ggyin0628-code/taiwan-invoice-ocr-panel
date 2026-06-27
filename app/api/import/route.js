import { mkdirSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { appendRecords, readRecords } from "../../../lib/server/records.js";
import { publicFileUrl, toDataRelativePath, UPLOADS_DIR } from "../../../lib/server/paths.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function safeName(name) {
  const parsed = parse(String(name || "invoice.jpg"));
  const base = parsed.name.replace(/[^\w\u4e00-\u9fff.-]+/g, "_").slice(0, 80) || "invoice";
  const ext = (parsed.ext || ".jpg").toLowerCase().replace(/[^.\w]/g, "") || ".jpg";
  return `${base}${ext}`;
}

function batchId() {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `B${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function present(record) {
  return {
    ...record,
    imageUrl: publicFileUrl(record.imagePath),
    thumbnailUrl: publicFileUrl(record.thumbnailPath)
  };
}

export async function POST(request) {
  const form = await request.formData();
  const files = form.getAll("files").filter((file) => file && typeof file.arrayBuffer === "function");
  if (!files.length) return Response.json({ error: "沒有收到圖片" }, { status: 400 });

  const currentCount = readRecords().length;
  const nextBatchId = batchId();
  const batchDir = join(UPLOADS_DIR, nextBatchId);
  mkdirSync(batchDir, { recursive: true });

  const now = new Date().toISOString();
  const newRecords = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const id = crypto.randomUUID();
    const filename = `${String(index + 1).padStart(3, "0")}-${safeName(file.name)}`;
    const originalPath = join(batchDir, filename);
    const thumbnailPath = join(batchDir, `${parse(filename).name}.thumb.jpg`);
    const buffer = Buffer.from(await file.arrayBuffer());
    writeFileSync(originalPath, buffer);
    await sharp(buffer).rotate().resize({ width: 360, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(thumbnailPath);

    newRecords.push({
      id,
      batchId: nextBatchId,
      sequenceNo: currentCount + index + 1,
      imagePath: toDataRelativePath(originalPath),
      thumbnailPath: toDataRelativePath(thumbnailPath),
      correctedImagePath: "",
      filename: file.name || filename,
      invoiceNumber: "",
      taxId: "",
      itemName: "",
      items: [],
      quantity: "",
      unitPrice: "",
      salesAmount: "",
      taxAmount: "",
      totalAmount: "",
      confirmed: false,
      warnings: [],
      confidenceLevel: "low",
      ocrProvider: "",
      amountSource: "none",
      confidence: {},
      fieldSources: {},
      fieldStatuses: {},
      recognitionResult: null,
      recognitionMode: "local",
      requestedProvider: "local",
      actualProvider: "",
      providerStatus: "pending",
      validationErrors: [],
      status: "unconfirmed",
      processingStatus: "pending",
      debug: {
        originalImagePath: toDataRelativePath(originalPath),
        grayImagePath: "",
        binaryImagePath: "",
        correctedImagePath: "",
        bboxImagePath: "",
        ocrRawJson: null,
        validatedJson: null,
        validationErrors: []
      },
      createdAt: now,
      updatedAt: now
    });
  }

  const all = appendRecords(newRecords);
  return Response.json({
    batchId: nextBatchId,
    records: all.slice(-newRecords.length).map(present)
  });
}
