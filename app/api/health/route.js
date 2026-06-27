export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    ok: true,
    app: "Taiwan Invoice OCR Panel",
    mode: process.env.OCR_PROVIDER || "hybrid",
    storage: "data/records.json",
    ocr: "local-hybrid-paddleocr-ollama-formula-manual-review",
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
