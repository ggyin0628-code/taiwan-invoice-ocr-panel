import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const paddleUrl = String(process.env.PADDLE_OCR_SERVICE_URL || "http://127.0.0.1:8765").replace(/\/+$/, "");
const ollamaUrl = String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const ollamaEnabled = String(process.env.OLLAMA_ENABLED || "true").toLowerCase() === "true";
const modelName = process.env.OLLAMA_MODEL || "qwen2.5vl:7b";

function command(name, args = []) {
  try {
    return execFileSync(name, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function check(label, ok, detail = "") {
  const mark = ok ? "OK" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? ` - ${detail}` : ""}`);
  return ok;
}

function readiness(label, state, detail = "") {
  console.log(`[${state}] ${label}${detail ? ` - ${detail}` : ""}`);
}

async function probe(url, path) {
  try {
    const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(1800) });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok && data.ok !== false, data, error: response.ok ? "" : `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, data: {}, error: error?.message || "無法連線" };
  }
}

async function main() {
  const nodeVersion = process.versions.node;
  const npmVersion = command("npm", ["--version"]);
  const portUsers = command("ss", ["-ltnp"]).split("\n").some((line) => /:3000\b/.test(line));
  let ok = true;
  ok = check("Node.js", Number(nodeVersion.split(".")[0]) >= 18, nodeVersion) && ok;
  ok = check("npm", Boolean(npmVersion), npmVersion || "找不到 npm") && ok;
  ok = check("node_modules", existsSync(join(root, "node_modules")), "缺少時請先執行 npm install 或 npm ci") && ok;
  ok = check("Next build output", existsSync(join(root, ".next")), "缺少時請先執行 npm run build") && ok;
  ok = check("Tesseract eng traineddata", existsSync(join(root, "eng.traineddata")), "缺少時本地 OCR 無法辨識英數") && ok;
  ok = check("Tesseract chi_tra traineddata", existsSync(join(root, "chi_tra.traineddata")), "缺少時本地 OCR 無法辨識中文錨點") && ok;

  const paddle = await probe(paddleUrl, "/health");
  readiness("PaddleOCR", paddle.ok ? "READY" : "DOWN", paddle.ok ? paddleUrl : `${paddleUrl}；本機 OCR fallback 可用`);
  const ollama = ollamaEnabled ? await probe(ollamaUrl, "/api/tags") : { ok: false, data: { models: [] }, error: "未啟用" };
  readiness("Ollama", ollama.ok ? "READY" : "DOWN", ollama.ok ? ollamaUrl : `${ollamaUrl}；低信心欄位將保留人工校正`);
  const models = Array.isArray(ollama.data?.models) ? ollama.data.models : [];
  const modelReady = ollama.ok && models.some((model) => String(model?.name || model?.model || "") === modelName || String(model?.name || model?.model || "").startsWith(`${modelName}:`));
  readiness("Model", modelReady ? "READY" : "MISSING", modelReady ? modelName : `${modelName}；可用 Ollama pull 安裝，非必要服務不會阻塞 UI`);
  readiness("Next.js", portUsers ? "READY" : existsSync(join(root, ".next")) ? "READY" : "DOWN", portUsers ? "3000 已有服務" : "建置輸出存在但目前未監聽 3000");

  console.log("");
  console.log("正式桌機啟動建議：");
  console.log("1. npm run kill:3000");
  console.log("2. npm run build");
  console.log("3. npm run start -- -p 3000");
  console.log("");
  console.log("Provider DOWN 或 Model MISSING 不會讓介面失去回應；請在 UI 健康列查看目前降級狀態。 ");
  process.exit(ok ? 0 : 1);
}

await main();
