import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { processInvoiceRecord } from "../lib/server/processInvoice.js";
import { toDataRelativePath, UPLOADS_DIR } from "../lib/server/paths.js";

const samplesDir = join(process.cwd(), "samples");
const samples = existsSync(samplesDir)
  ? (await import("node:fs")).readdirSync(samplesDir)
    .filter((name) => /\.(jpe?g|png)$/i.test(name))
    .map((name) => join(samplesDir, name))
  : [];

async function run() {
  const batchId = `TLOCAL-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
  const uploadDir = join(UPLOADS_DIR, batchId);
  await mkdir(uploadDir, { recursive: true });

  let processedCount = 0;
  for (const samplePath of samples) {
    if (!existsSync(samplePath)) {
      console.log(`[SKIP] ${samplePath} 不存在`);
      continue;
    }

    const filename = basename(samplePath);
    const storedPath = join(uploadDir, filename);
    await copyFile(samplePath, storedPath);
    const record = {
      id: `${batchId}-${processedCount + 1}`,
      batchId,
      filename,
      imagePath: toDataRelativePath(storedPath)
    };
    const result = await processInvoiceRecord(record);
    processedCount += 1;

    console.log(`\n=== ${filename} ===`);
    console.log(`processingStatus: ${result.processingStatus}`);
    console.log(`invoiceNumber: ${result.invoiceNumber || "(blank)"}`);
    console.log(`taxId: ${result.taxId || "(blank)"}`);
    console.log(`itemName: ${result.itemName || "(blank)"}`);
    console.log(`quantity: ${result.quantity || "(blank)"}`);
    console.log(`salesAmount: ${result.salesAmount || "(blank)"}`);
    console.log(`taxAmount: ${result.taxAmount || "(blank)"}`);
    console.log(`totalAmount: ${result.totalAmount || "(blank)"}`);
    console.log(`debug: ${result.debug?.ocrJsonPath || "(blank)"}`);
    if (result.validationErrors?.length) {
      console.log(`validationErrors: ${result.validationErrors.map((error) => `${error.field}:${error.reason}`).join(" | ")}`);
    }
  }

  if (!processedCount) {
    console.log("沒有可測試的樣本。");
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
