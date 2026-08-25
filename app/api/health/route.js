import { collectProviderHealth } from "../../../lib/server/providerHealth.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const providers = await collectProviderHealth();
  return Response.json({
    ok: true,
    app: "Taiwan Invoice OCR Panel",
    mode: process.env.OCR_PROVIDER || "hybrid",
    storage: "data/records.json",
    ocr: "local-hybrid-paddleocr-ollama-formula-manual-review",
    providers,
    degradation: {
      allowed: true,
      message: providers.paddle.status === "READY"
        ? "PaddleOCR 可用；若 Ollama 或模型不可用，仍可完成本機 OCR 與人工校正。"
        : "PaddleOCR 不可用；系統會保留本機 OCR、公式計算與人工校正流程，結果需依信心狀態檢查。"
    },
    defaults: {
      OCR_PROVIDER: process.env.OCR_PROVIDER || "hybrid",
      AI_VISION_PROVIDER: process.env.AI_VISION_PROVIDER || "none",
      LOCAL_OCR_ENGINE: process.env.LOCAL_OCR_ENGINE || "tesseract",
      PADDLE_OCR_ENABLED: process.env.PADDLE_OCR_ENABLED || "true",
      PADDLE_OCR_SERVICE_URL: process.env.PADDLE_OCR_SERVICE_URL || "http://127.0.0.1:8765",
      OLLAMA_ENABLED: process.env.OLLAMA_ENABLED || "true",
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || "qwen2.5vl:7b"
    },
    time: new Date().toISOString()
  });
}
