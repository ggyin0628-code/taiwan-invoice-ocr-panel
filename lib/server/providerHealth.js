const DEFAULT_PADDLE_URL = "http://127.0.0.1:8765";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "qwen2.5vl:7b";

function baseUrl(value, fallback) {
  return String(value || fallback).replace(/\/+$/, "");
}

async function getJson(url, timeoutMs = 1800) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

export async function probePaddleOcr(options = {}) {
  const url = baseUrl(options.url || process.env.PADDLE_OCR_SERVICE_URL, DEFAULT_PADDLE_URL);
  const healthTimeoutMs = Number(process.env.PADDLE_OCR_HEALTH_TIMEOUT_MS || 30000);
  try {
    const { response, data } = await getJson(`${url}/health`, Number.isFinite(healthTimeoutMs) && healthTimeoutMs > 0 ? healthTimeoutMs : 30000);
    if (!response.ok || data.ok === false) {
      const error = data.lastInitializationError || data.error || `HTTP ${response.status}`;
      return {
        name: "PaddleOCR",
        status: "DOWN",
        ok: false,
        url,
        detail: error,
        service: data.service || "paddleocr",
        paddleocrVersion: data.paddleocrVersion || null,
        paddleVersion: data.paddleVersion || null,
        modelReady: Boolean(data.modelReady),
        engineReady: Boolean(data.engineReady),
        lastInitializationError: data.lastInitializationError || error,
        apiMode: data.apiMode || null
      };
    }
    return {
      name: "PaddleOCR",
      status: "READY",
      ok: true,
      url,
      detail: "服務與 OCR engine 已就緒",
      service: data.service || "paddleocr",
      paddleocrVersion: data.paddleocrVersion || null,
      paddleVersion: data.paddleVersion || null,
      modelReady: Boolean(data.modelReady),
      engineReady: Boolean(data.engineReady),
      lastInitializationError: data.lastInitializationError || null,
      apiMode: data.apiMode || null
    };
  } catch (error) {
    return { name: "PaddleOCR", status: "DOWN", ok: false, url, detail: error?.message || "服務無法連線", lastInitializationError: error?.message || "服務無法連線" };
  }
}

export async function probeOllama(options = {}) {
  const enabled = String(options.enabled ?? process.env.OLLAMA_ENABLED ?? "true").toLowerCase() === "true";
  const url = baseUrl(options.url || process.env.OLLAMA_BASE_URL, DEFAULT_OLLAMA_URL);
  if (!enabled) return { name: "Ollama", status: "DOWN", ok: false, enabled: false, url, detail: "未啟用；系統會使用無 Ollama 的降級流程" };
  try {
    const { response, data } = await getJson(`${url}/api/tags`);
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { name: "Ollama", status: "READY", ok: true, enabled: true, url, detail: "服務可連線", models: Array.isArray(data.models) ? data.models : [] };
  } catch (error) {
    return { name: "Ollama", status: "DOWN", ok: false, enabled: true, url, detail: error?.message || "服務無法連線", models: [] };
  }
}

export function probeModel(ollama, model = process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL) {
  const modelName = String(model);
  const models = Array.isArray(ollama?.models) ? ollama.models : [];
  const ready = ollama?.status === "READY" && models.some((item) => {
    const name = String(item?.name || item?.model || "");
    return name === modelName || name.startsWith(`${modelName}:`);
  });
  return {
    name: "Ollama model",
    model: modelName,
    status: ready ? "READY" : "MISSING",
    ok: ready,
    detail: ready ? "模型已安裝" : ollama?.status === "READY" ? "模型未安裝" : "Ollama 不可用，未完成模型檢查"
  };
}

export async function collectProviderHealth(options = {}) {
  const [paddle, ollama] = await Promise.all([
    probePaddleOcr({ url: options.paddleUrl }),
    probeOllama({ enabled: options.ollamaEnabled, url: options.ollamaUrl })
  ]);
  const model = probeModel(ollama, options.model);
  return { paddle, ollama: { ...ollama, models: undefined }, model };
}
