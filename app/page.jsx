"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  FileSpreadsheet,
  ImagePlus,
  Loader2,
  Trash2,
  Upload
} from "lucide-react";

const CORE_FIELDS = [
  ["invoiceNumber", "發票號碼"],
  ["taxId", "統一編號"],
  ["quantity", "數量"],
  ["unitPrice", "單價"]
];

const TEMPLATE_FIELD_LABELS = Object.fromEntries(CORE_FIELDS);

const PROCESS_LABELS = {
  pending: "等待處理",
  processing: "辨識中",
  done: "完成",
  failed: "失敗",
  need_review: "需人工確認",
  provider_unavailable: "Provider 不可用"
};

const FIELD_SOURCE_LABELS = {
  paddleocr: "PaddleOCR",
  easyocr: "本機 OCR",
  tesseract: "本機 OCR",
  macos_vision: "本機 OCR",
  google_vision: "Google Vision",
  openai_vision: "OpenAI Vision",
  formula: "公式",
  manual: "人工",
  hybrid: "Hybrid",
  ollama: "Ollama"
};

const PROVIDER_LABELS = {
  local: "本機 OCR",
  tesseract: "Tesseract",
  paddleocr: "PaddleOCR",
  "google-vision": "Google Vision",
  "openai-vision": "OpenAI Vision",
  hybrid: "Hybrid",
  manual: "人工",
  google_vision: "Google Vision",
  openai_vision: "OpenAI Vision"
};

const FIELD_STATUS_LABELS = {
  auto: "自動",
  low_confidence: "低信心",
  manual_required: "需人工"
};

function nowDate() {
  return new Date().toISOString().slice(0, 10);
}

function money(value) {
  const number = Number(String(value || "").replace(/[^\d]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function numberList(value) {
  return String(value || "")
    .split(/[,\s/]+/)
    .map((part) => part.replace(/[^\d]/g, ""))
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function calculatedSalesAmount(quantityValue, unitPriceValue) {
  const quantities = numberList(quantityValue);
  const unitPrices = numberList(unitPriceValue);
  if (!quantities.length || quantities.length !== unitPrices.length) return 0;
  return quantities.reduce((sum, quantity, index) => sum + quantity * unitPrices[index], 0);
}

function buildLineItems(quantityValue, unitPriceValue, existingItems = []) {
  const quantities = numberList(quantityValue);
  const unitPrices = numberList(unitPriceValue);
  const length = Math.max(quantities.length, unitPrices.length);
  return Array.from({ length }, (_, index) => {
    const quantity = quantities[index] ?? null;
    const unitPrice = unitPrices[index] ?? null;
    return {
      lineNo: index + 1,
      itemName: existingItems[index]?.itemName || existingItems[index]?.name || "",
      quantity,
      unitPrice,
      amount: quantity != null && unitPrice != null ? quantity * unitPrice : null,
      source: "manual",
      status: quantity != null && unitPrice != null ? "auto" : "manual_required",
      confidence: quantity != null && unitPrice != null ? 1 : 0
    };
  });
}

function recordItems(record) {
  if (Array.isArray(record?.items) && record.items.length) return record.items;
  return buildLineItems(record?.quantity || "", record?.unitPrice || "");
}

function normalizeClientLineItem(item, index) {
  const quantityText = String(item?.quantity ?? "").replace(/[^\d.]/g, "");
  const unitPriceText = String(item?.unitPrice ?? "").replace(/[^\d]/g, "");
  const quantity = quantityText ? Number(quantityText) : null;
  const unitPrice = unitPriceText ? Number(unitPriceText) : null;
  const complete = Number.isFinite(quantity) && quantity > 0 && Number.isFinite(unitPrice) && unitPrice > 0;
  return {
    lineNo: index + 1,
    itemName: textInput(item?.itemName ?? item?.name ?? ""),
    quantity: complete || quantity != null ? quantity : null,
    unitPrice: complete || unitPrice != null ? unitPrice : null,
    amount: complete ? quantity * unitPrice : null,
    confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : complete ? 1 : 0,
    source: item?.source || "manual",
    status: item?.status === "confirmed" ? "confirmed" : complete ? item?.status || "auto" : "manual_required"
  };
}

function normalizeClientLineItems(items) {
  return (Array.isArray(items) ? items : []).map((item, index) => normalizeClientLineItem(item, index));
}

function lineItemTotals(items) {
  const normalized = normalizeClientLineItems(items);
  const complete = normalized.length > 0 && normalized.every((item) => item.quantity != null && item.unitPrice != null);
  if (!complete) return { quantity: normalized.map((item) => item.quantity ?? "").join(","), unitPrice: normalized.map((item) => item.unitPrice ?? "").join(","), salesAmount: "", taxAmount: "", totalAmount: "", amountSource: "none" };
  const salesAmount = normalized.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const taxAmount = Math.round(salesAmount * 0.05);
  return { quantity: normalized.map((item) => item.quantity).join(","), unitPrice: normalized.map((item) => item.unitPrice).join(","), salesAmount: String(salesAmount), taxAmount: String(taxAmount), totalAmount: String(salesAmount + taxAmount), amountSource: "formula" };
}

function numericInput(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function numericListInput(value) {
  return String(value || "").replace(/[^\d/\s,]/g, "").replace(/\s+/g, " ").trimStart();
}

function textInput(value) {
  return String(value || "").replace(/[^\u4e00-\u9fffA-Za-z0-9\s._+()/-]/g, "").replace(/\s+/g, " ").trimStart().slice(0, 80);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function templateFromRecord(record, templates) {
  const debugTemplate = record?.debug?.templateDetection?.template;
  const savedTemplates = Array.isArray(templates) ? templates : [];
  const matched = savedTemplates.find((template) => (
    template.templateId && template.templateId === debugTemplate?.templateId
  )) || savedTemplates.find((template) => (
    template.vendorTaxId && template.vendorTaxId === debugTemplate?.vendorTaxId
  ));
  return matched || savedTemplates[0] || debugTemplate || null;
}

function fieldError(record, field) {
  return (record?.validationErrors || []).find((error) => error.field === field);
}

function fieldConfidence(record, field) {
  const value = Number(record?.confidence?.[field] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function fieldStatus(record, field) {
  return record?.fieldStatuses?.[field] || (fieldError(record, field) ? "manual_required" : "auto");
}

function fieldSource(record, field) {
  return record?.fieldSources?.[field] || "tesseract";
}

function warningList(record) {
  const warnings = Array.isArray(record?.warnings) ? record.warnings : [];
  const validationWarnings = Array.isArray(record?.validationErrors)
    ? record.validationErrors.map((error) => error.reason).filter(Boolean)
    : [];
  return [...new Set([...warnings, ...validationWarnings].filter(Boolean))];
}

export default function HomePage() {
  const [records, setRecords] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [queueState, setQueueState] = useState({ active: false, total: 0, completed: 0, status: "等待批量匯入" });
  const [templates, setTemplates] = useState([]);
  const [health, setHealth] = useState(null);
  const ocrProvider = "hybrid";
  const fileInputRef = useRef(null);

  async function loadRecords(selectLast = false) {
    const response = await fetch("/api/records", { cache: "no-store" });
    const result = await response.json();
    const nextRecords = Array.isArray(result.records) ? result.records : [];
    setRecords(nextRecords);
    setSelectedId((current) => current || (selectLast ? nextRecords.at(-1)?.id : nextRecords[0]?.id) || "");
    setLoading(false);
    return nextRecords;
  }

  useEffect(() => {
    loadRecords();
    loadTemplates();
    loadHealth();
    const timer = window.setInterval(loadHealth, 30000);
    return () => window.clearInterval(timer);
  }, []);

  async function loadTemplates() {
    const response = await fetch("/api/templates", { cache: "no-store" });
    const result = await response.json();
    setTemplates(Array.isArray(result.templates) ? result.templates : []);
  }

  async function loadHealth() {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const result = await response.json();
      setHealth(result);
    } catch (error) {
      setHealth({ ok: false, error: error?.message || "健康狀態無法取得" });
    }
  }

  const selected = records.find((record) => record.id === selectedId) || records[0] || null;

  const metrics = useMemo(() => {
    return records.reduce(
      (acc, record) => {
        if (String(record.createdAt || "").startsWith(nowDate())) acc.today += 1;
        acc.monthTotal += money(record.totalAmount);
        if (record.status === "confirmed") acc.confirmed += 1;
        else acc.unconfirmed += 1;
        if (record.processingStatus === "pending") acc.pending += 1;
        if (record.processingStatus === "failed") acc.failed += 1;
        return acc;
      },
      { today: 0, monthTotal: 0, confirmed: 0, unconfirmed: 0, pending: 0, failed: 0 }
    );
  }, [records]);

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file?.type?.startsWith("image/"));
    if (!files.length) return;

    const form = new FormData();
    files.forEach((file) => form.append("files", file));
    setQueueState({ active: true, total: files.length, completed: 0, status: "正在儲存圖片到 data/uploads" });
    const response = await fetch("/api/import", { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok) {
      setQueueState({ active: false, total: files.length, completed: 0, status: result.error || "匯入失敗" });
      return;
    }
    const nextRecords = await loadRecords(true);
    const imported = nextRecords.filter((record) => record.batchId === result.batchId && record.processingStatus === "pending");
    setSelectedId(imported[0]?.id || nextRecords.at(-1)?.id || "");
    await processQueue(imported);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function processQueue(items) {
    const pending = [...items];
    let cursor = 0;
    let completed = 0;
    const total = pending.length;
    setQueueState({ active: true, total, completed: 0, status: "佇列辨識中，一次處理最多 2 張" });

    async function worker() {
      while (cursor < pending.length) {
        const record = pending[cursor];
        cursor += 1;
        setRecords((current) => current.map((item) => item.id === record.id ? { ...item, processingStatus: "processing" } : item));
        try {
          const response = await fetch(`/api/records/${record.id}/process?provider=${encodeURIComponent(ocrProvider)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: ocrProvider })
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "OCR failed");
          setRecords((current) => current.map((item) => item.id === record.id ? result.record : item));
        } catch (error) {
          setRecords((current) => current.map((item) => item.id === record.id ? {
            ...item,
            processingStatus: "failed",
            validationErrors: [{ field: "ocr", reason: error?.message || "OCR failed" }]
          } : item));
        } finally {
          completed += 1;
          setQueueState({ active: completed < total, total, completed, status: completed < total ? "佇列辨識中" : "批量處理完成" });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(2, pending.length) }, () => worker()));
    await loadRecords();
  }

  async function updateRecordField(id, field, value) {
    setRecords((current) => current.map((record) => {
      if (record.id !== id) return record;
      const patch = { [field]: value, status: "unconfirmed" };
      if (field === "quantity" || field === "unitPrice") {
        const nextQuantity = field === "quantity" ? value : record.quantity;
        const nextUnitPrice = field === "unitPrice" ? value : record.unitPrice;
        const salesAmount = calculatedSalesAmount(nextQuantity, nextUnitPrice);
        const taxAmount = salesAmount > 0 ? Math.round(salesAmount * 0.05) : "";
        patch.items = buildLineItems(nextQuantity, nextUnitPrice, record.items || []);
        patch.salesAmount = salesAmount ? String(salesAmount) : "";
        patch.taxAmount = taxAmount ? String(taxAmount) : "";
        patch.totalAmount = taxAmount ? String(salesAmount + taxAmount) : "";
      }
      return { ...record, ...patch };
    }));
    const response = await fetch(`/api/records/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value, status: "unconfirmed" })
    });
    if (response.ok) {
      const result = await response.json();
      setRecords((current) => current.map((record) => record.id === id ? result.record : record));
    }
  }

  async function updateRecordItems(id, nextItems) {
    const items = normalizeClientLineItems(nextItems);
    const totals = lineItemTotals(items);
    const patch = { items, ...totals, status: "unconfirmed" };
    setRecords((current) => current.map((record) => record.id === id ? { ...record, ...patch } : record));
    const response = await fetch(`/api/records/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
    if (response.ok) {
      const result = await response.json();
      setRecords((current) => current.map((record) => record.id === id ? result.record : record));
    }
  }

  async function confirmRecord(id) {
    const response = await fetch(`/api/records/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "confirmed" })
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok) {
      setRecords((current) => current.map((record) => record.id === id ? result.record : record));
    } else {
      setRecords((current) => current.map((record) => record.id === id ? {
        ...record,
        status: "unconfirmed",
        confirmed: false,
        processingStatus: "need_review",
        reviewStatus: "REVIEW_REQUIRED",
        validationErrors: result.validationErrors || [{ field: "record", reason: result.error || "仍有欄位需要修正" }]
      } : record));
    }
  }

  async function saveTemplate(template, recordId = selected?.id) {
    const response = await fetch("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(template)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "模板儲存失敗");
    setTemplates(Array.isArray(result.templates) ? result.templates : []);
    setRecords((current) => current.map((record) => {
      if (record.id !== recordId) return record;
      return {
        ...record,
        debug: {
          ...(record.debug || {}),
          templateDetection: {
            reason: "manual-calibration",
            template: result.template
          }
        }
      };
    }));
    return result.template;
  }

  async function deleteRecord(id) {
    if (!window.confirm("確定刪除這筆紀錄？原圖檔案會保留在 data/uploads 供追溯。")) return;
    const response = await fetch(`/api/records/${id}`, { method: "DELETE" });
    if (response.ok) {
      const result = await response.json();
      setRecords(result.records || []);
      setSelectedId(result.records?.[0]?.id || "");
    }
  }

  function exportExcel() {
    const needsReview = records.some((record) => (
      record.status !== "confirmed"
      || Object.values(record.fieldStatuses || {}).some((status) => status === "manual_required")
      || record.processingStatus === "need_review"
      || record.processingStatus === "provider_unavailable"
    ));
    if (needsReview && !window.confirm("仍有需人工確認的資料，是否仍要匯出？")) return;
    window.location.href = "/api/export";
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">正式桌機版 · data/uploads + data/records.json</p>
          <h1>財務收據整理面板</h1>
        </div>
          <div className="statusPill">local-first：自動辨識 → 人工校正 → Excel</div>
      </header>

      <HealthSummary health={health} />

      <section className="metrics" aria-label="財務摘要">
        <Metric label="今日新增筆數" value={`${metrics.today} 筆`} />
        <Metric label="本月總金額" value={metrics.monthTotal.toLocaleString("zh-TW")} prefix="NT$" />
        <Metric label="未確認筆數" value={`${metrics.unconfirmed} 筆`} tone="warn" />
        <Metric label="已確認筆數" value={`${metrics.confirmed} 筆`} tone="ok" />
      </section>

      <section className="workspace stableWorkspace">
        <aside className="leftPane stableLeft">
          <div
            className={`uploadZone ${dragging ? "dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              handleFiles(event.dataTransfer.files);
            }}
          >
            <ImagePlus size={34} />
            <h2>批量匯入照片</h2>
            <p>圖片會存到 data/uploads；前端只保留路徑與縮圖，不再把原圖塞進 localStorage。</p>
            <div className="uploadActions">
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={queueState.active}>
                <Upload size={16} /> 選擇多張圖片
              </button>
            </div>
            <div className="modeSelect">
              <span>辨識模式</span>
              <strong>hybrid：PaddleOCR → Ollama 輔助 → 公式金額</strong>
            </div>
            <input ref={fileInputRef} hidden multiple type="file" accept="image/*" onChange={(event) => handleFiles(event.target.files)} />
          </div>

          <div className="progressPanel">
            <div className="panelHead">
              <h2>處理佇列</h2>
              <span>{queueState.active ? "執行中" : "待命"}</span>
            </div>
            <div className="progressBody">
              <div className="progressNumbers">
                <strong>{queueState.completed}</strong>
                <span>/ {queueState.total || 0} 張</span>
              </div>
              <div className="progressBar" aria-label="處理進度">
                <div style={{ width: `${queueState.total ? Math.round((queueState.completed / queueState.total) * 100) : 0}%` }} />
              </div>
              <p>{queueState.status}</p>
            </div>
          </div>

          <div className="imageListPanel">
            <div className="panelHead">
              <h2>圖片清單</h2>
              <span>{records.length} 筆</span>
            </div>
            <div className="imageList">
              {loading ? <div className="emptyRow">載入中</div> : records.length ? records.map((record) => (
                <button key={record.id} type="button" className={`imageListItem ${selected?.id === record.id ? "active" : ""}`} onClick={() => setSelectedId(record.id)}>
                  {record.thumbnailUrl ? <img src={record.thumbnailUrl} alt={record.filename} /> : null}
                  <span>
                    <strong>#{record.sequenceNo} {record.filename}</strong>
                    <small>{record.batchId}</small>
                  </span>
                  <StatusBadge status={record.processingStatus} />
                </button>
              )) : <div className="emptyRow">尚無資料</div>}
            </div>
          </div>
        </aside>

        <section className="rightPane stableRight">
          <div className="tableToolbar">
            <div>
              <h2>辨識欄位</h2>
              <p>低信心或驗證失敗欄位會留空，不會直接進 Excel。</p>
            </div>
            <div className="toolbarActions">
              <button type="button" className="secondary" onClick={() => selected && processQueue([selected])} disabled={!selected || queueState.active}>
                <Loader2 size={16} /> 重新辨識
              </button>
              <button type="button" className="primary" onClick={exportExcel} disabled={!records.length}>
                <FileSpreadsheet size={16} /> 匯出 Excel
              </button>
            </div>
          </div>

          {selected ? (
            <div className="stableDetail">
              <div className="imageFrame stablePreview">
                {selected.imageUrl ? <img src={selected.imageUrl} alt={selected.filename} /> : <div className="empty">無圖片</div>}
              </div>
              <div className="fieldEditor">
                <div className="panelHead">
                  <h2>#{selected.sequenceNo} {selected.filename}</h2>
                  <StatusBadge status={selected.processingStatus} />
                </div>
                <ProviderSummary record={selected} selectedProvider={ocrProvider} />
                <RecordWarnings record={selected} />
                <div className="coreFieldGrid">
                  {CORE_FIELDS.filter(([field]) => !["quantity", "unitPrice"].includes(field)).map(([field, label]) => (
                    <label key={field} className={fieldStatus(selected, field) !== "auto" || fieldConfidence(selected, field) < 0.6 ? "fieldInvalid" : ""}>
                      <span className="fieldTitle">
                        {label}
                        <FieldMeta source={fieldSource(selected, field)} status={fieldStatus(selected, field)} />
                      </span>
                      <input
                        value={selected[field] || ""}
                        onChange={(event) => updateRecordField(
                          selected.id,
                          field,
                          field === "invoiceNumber" ? event.target.value.toUpperCase()
                            : field === "quantity" || field === "unitPrice" ? numericListInput(event.target.value)
                              : numericInput(event.target.value)
                        )}
                      />
                      <small>
                        信心 {Math.round(fieldConfidence(selected, field) * 100)}%
                        {fieldError(selected, field) ? ` · ${fieldError(selected, field).reason}` : ""}
                      </small>
                    </label>
                  ))}
                  <label>
                    <span className="fieldTitle">金額 <FieldMeta source={fieldSource(selected, "salesAmount")} status={fieldStatus(selected, "salesAmount")} /></span>
                    <input value={selected.salesAmount || ""} readOnly />
                    <small>來源：{selected.amountSource || "none"} · 數量 × 單價自動計算</small>
                  </label>
                  <label>
                    <span className="fieldTitle">稅金 <FieldMeta source={fieldSource(selected, "taxAmount")} status={fieldStatus(selected, "taxAmount")} /></span>
                    <input value={selected.taxAmount || ""} readOnly />
                    <small>依金額 × 5% 自動計算</small>
                  </label>
                  <label>
                    <span className="fieldTitle">總金額 <FieldMeta source={fieldSource(selected, "totalAmount")} status={fieldStatus(selected, "totalAmount")} /></span>
                    <input value={selected.totalAmount || ""} readOnly />
                    <small>金額 + 稅金</small>
                  </label>
                </div>
                <LineItemsTable record={selected} onChange={updateRecordItems} />
                <div className="detailActions">
                  <button type="button" className="primary" onClick={() => confirmRecord(selected.id)} disabled={selected.status === "confirmed"}>
                    <CheckCircle2 size={16} /> 確認本筆資料
                  </button>
                  <button type="button" className="secondary dangerAction" onClick={() => deleteRecord(selected.id)}>
                    <Trash2 size={16} /> 刪除紀錄
                  </button>
                </div>
                <DebugBlock record={selected} templates={templates} onSaveTemplate={saveTemplate} onReprocessRecord={() => processQueue([selected])} />
              </div>
            </div>
          ) : (
            <div className="emptyRow">請先匯入圖片。</div>
          )}

          <RecordsTable records={records} selectedId={selectedId} setSelectedId={setSelectedId} />
        </section>
      </section>
    </main>
  );
}

function Metric({ label, value, prefix = "", tone = "" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{prefix ? <small>{prefix}</small> : null}{value}</strong>
    </div>
  );
}

function StatusBadge({ status }) {
  return <em className={`statusBadge ${status || "pending"}`}>{PROCESS_LABELS[status] || status || "等待處理"}</em>;
}

function HealthSummary({ health }) {
  const providers = health?.providers || {};
  const entries = [
    ["Next.js", health?.ok === false ? "DOWN" : "READY"],
    ["PaddleOCR", providers.paddle?.status || "DOWN"],
    ["Ollama", providers.ollama?.status || "DOWN"],
    ["Model", providers.model?.status || "MISSING"]
  ];
  return (
    <section className="healthStrip" aria-label="服務健康狀態">
      <div className="healthItems">
        {entries.map(([label, status]) => <span key={label} className={`healthItem ${String(status).toLowerCase()}`}><strong>{label}</strong><em>{status}</em></span>)}
      </div>
      <p>{health?.degradation?.message || health?.error || "正在檢查本機 OCR 服務狀態..."}</p>
    </section>
  );
}

function ProviderSummary({ record, selectedProvider }) {
  const requested = record.requestedProvider || record.recognitionMode || selectedProvider || "local";
  const actual = record.actualProvider || (record.processingStatus === "pending" ? "" : requested);
  const status = record.providerStatus || record.processingStatus || "pending";
  return (
    <div className={`providerSummary ${status}`}>
      <span>目前選擇：{PROVIDER_LABELS[selectedProvider] || selectedProvider}</span>
      <span>本筆要求：{PROVIDER_LABELS[requested] || requested}</span>
      <span>實際使用：{actual ? PROVIDER_LABELS[actual] || actual : "尚未辨識"}</span>
      <span>金額來源：{record.amountSource || "none"}</span>
      <span>信心等級：{record.confidenceLevel || "low"}</span>
      {status === "provider_unavailable" ? <strong>外部 Provider 不可用，已 fallback 本機 OCR，請人工確認。</strong> : null}
      {record.reviewStatus === "REVIEW_RECOMMENDED" ? <strong>建議人工複核</strong> : null}
      {record.reviewStatus === "REVIEW_REQUIRED" || record.reviewStatus === "INVALID" ? <strong>必須人工修正後才能確認</strong> : null}
    </div>
  );
}

function RecordWarnings({ record }) {
  const warnings = warningList(record);
  if (!warnings.length) return null;
  return (
    <div className="warningTags">
      {warnings.map((warning) => <span key={warning}>{warning}</span>)}
    </div>
  );
}

function FieldMeta({ source, status }) {
  return (
    <em className={`fieldMeta ${status || "manual_required"}`}>
      {FIELD_SOURCE_LABELS[source] || source || "OCR"} · {FIELD_STATUS_LABELS[status] || status || "需人工"}
    </em>
  );
}

function LineItemsTable({ record, onChange }) {
  const items = recordItems(record).filter((item) => item.itemName || item.quantity != null || item.unitPrice != null || item.amount != null);

  function updateItem(index, patch) {
    const next = items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch, status: "manual", source: "manual", confidence: 1 } : item);
    onChange?.(record.id, next);
  }

  function addItem() {
    onChange?.(record.id, [...items, { lineNo: items.length + 1, itemName: "", quantity: null, unitPrice: null, amount: null, confidence: 0, source: "manual", status: "manual_required" }]);
  }

  function removeItem(index) {
    onChange?.(record.id, items.filter((_, itemIndex) => itemIndex !== index));
  }

  function confirmItem(index) {
    const next = items.map((item, itemIndex) => itemIndex === index ? { ...item, status: "confirmed", source: "manual", confidence: 1 } : item);
    onChange?.(record.id, next);
  }

  return (
    <div className="lineItemsPanel">
      <div className="panelHead compactHead">
        <div>
          <h3>可編輯明細列</h3>
          <span>每列金額由數量 × 單價重算，確認前仍可修改。</span>
        </div>
        <button type="button" className="secondary compactButton" onClick={addItem}>新增列</button>
      </div>
      {items.length ? (
        <div className="lineItemsScroll">
          <table className="lineItemsTable editableLineItemsTable">
            <thead>
              <tr>
                <th>列號</th>
                <th>品名</th>
                <th>數量</th>
                <th>單價</th>
                <th>公式金額</th>
                <th>OCR 信心</th>
                <th>來源</th>
                <th>狀態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => {
                const complete = item.quantity != null && item.unitPrice != null;
                return (
                  <tr key={`${record.id}-item-${index}`} className={item.status === "manual_required" ? "itemNeedsReview" : ""}>
                    <td>{index + 1}</td>
                    <td><input value={item.itemName || item.name || ""} aria-label={`第 ${index + 1} 列品名`} onChange={(event) => updateItem(index, { itemName: textInput(event.target.value) })} /></td>
                    <td><input inputMode="decimal" value={item.quantity ?? ""} aria-label={`第 ${index + 1} 列數量`} onChange={(event) => updateItem(index, { quantity: event.target.value.replace(/[^\d.]/g, "") })} /></td>
                    <td><input inputMode="numeric" value={item.unitPrice ?? ""} aria-label={`第 ${index + 1} 列單價`} onChange={(event) => updateItem(index, { unitPrice: numericInput(event.target.value) })} /></td>
                    <td>{complete ? Number(item.quantity) * Number(item.unitPrice) : ""}</td>
                    <td>{Math.round(Number(item.confidence || 0) * 100)}%</td>
                    <td>{FIELD_SOURCE_LABELS[item.source] || item.source || "人工"}</td>
                    <td>{item.status === "confirmed" ? "已確認" : complete ? (FIELD_STATUS_LABELS[item.status] || "待確認") : "需人工"}</td>
                    <td className="lineItemActions">
                      <button type="button" className="linkButton" onClick={() => confirmItem(index)} disabled={!complete || item.status === "confirmed"}>確認列</button>
                      <button type="button" className="linkButton dangerText" onClick={() => removeItem(index)}>刪除</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="emptyInline">尚無明細列；請按「新增列」或重新辨識。</p>
      )}
    </div>
  );
}

function DebugBlock({ record, templates, onSaveTemplate, onReprocessRecord }) {
  return (
    <details className="debugSummary">
      <summary>進階 / Debug / 模板校正</summary>
      <div className="debugSummaryBody">
      <h3>Debug / OCR 參考區</h3>
      <dl>
        <div><dt>原圖路徑</dt><dd>{record.imagePath || "-"}</dd></div>
        <div><dt>灰階圖路徑</dt><dd>{record.debug?.grayImagePath || "-"}</dd></div>
        <div><dt>二值化圖路徑</dt><dd>{record.debug?.binaryImagePath || "-"}</dd></div>
        <div><dt>校正圖路徑</dt><dd>{record.correctedImagePath || "-"}</dd></div>
        <div><dt>OCR bbox 圖</dt><dd>{record.debug?.bboxImagePath || "-"}</dd></div>
        <div><dt>要求 Provider</dt><dd>{PROVIDER_LABELS[record.requestedProvider || record.debug?.requestedProvider] || record.requestedProvider || record.debug?.requestedProvider || "-"}</dd></div>
        <div><dt>實際來源</dt><dd>{PROVIDER_LABELS[record.actualProvider || record.debug?.actualProvider] || record.actualProvider || record.debug?.actualProvider || "-"}</dd></div>
        <div><dt>確認狀態</dt><dd>{record.status === "confirmed" ? "已確認" : "未確認"}</dd></div>
      </dl>
      {record.correctedImageUrl ? <img className="correctedPreview" src={record.correctedImageUrl} alt="校正圖" /> : null}
      {record.debug?.bboxImagePath ? <img className="correctedPreview" src={`/api/files/${record.debug.bboxImagePath.replace(/^data\//, "")}`} alt="OCR bbox 標註圖" /> : null}
      <RegionCropGrid record={record} />
      <TemplateCalibration record={record} templates={templates} onSaveTemplate={onSaveTemplate} onReprocessRecord={onReprocessRecord} />
      {record.validationErrors?.length ? (
        <div className="validationBox">
          <strong>驗證錯誤</strong>
          {record.validationErrors.map((error, index) => <p key={`${error.field}-${index}`}>{error.field}: {error.reason}</p>)}
        </div>
      ) : null}
      <details>
        <summary>OCR 原始 JSON / 驗證後 JSON</summary>
        <pre>{JSON.stringify({
          ocrRawJson: record.debug?.ocrRawJson || null,
          templateDetection: record.debug?.templateDetection || null,
          anchorExtraction: record.debug?.anchorExtraction || null,
          validatedJson: record.debug?.validatedJson || null,
          aiVisionRaw: record.debug?.aiVisionRaw || null,
          aiVisionResult: record.debug?.aiVisionResult || null,
          providerEvents: record.debug?.providerEvents || null,
          requestedProvider: record.requestedProvider || record.debug?.requestedProvider || null,
          actualProvider: record.actualProvider || record.debug?.actualProvider || null,
          providerStatus: record.providerStatus || record.debug?.providerStatus || null,
          finalMergedResult: record.debug?.finalMergedResult || record.recognitionResult || null,
          recognitionMode: record.recognitionMode || record.debug?.recognitionMode || null,
          validationErrors: record.validationErrors || []
        }, null, 2)}</pre>
      </details>
      </div>
    </details>
  );
}

function RegionCropGrid({ record }) {
  const crops = record.debug?.regionCrops || {};
  const entries = CORE_FIELDS.map(([field, label]) => [field, label, crops[field]]).filter(([, , path]) => path);
  if (!entries.length) return null;
  return (
    <div className="regionCropGrid">
      <h3>欄位裁切小圖</h3>
      <div>
        {entries.map(([field, label, path]) => {
          const region = record.debug?.regionOcr?.[field];
          return (
            <figure key={field}>
              <img src={`/api/files/${path.replace(/^data\//, "")}`} alt={`${label} 裁切小圖`} />
              <figcaption>{label} · OCR: {region?.text || "空"} · {Math.round((region?.confidence || 0) * 100)}%</figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}

function TemplateCalibration({ record, templates, onSaveTemplate, onReprocessRecord }) {
  const imageRef = useRef(null);
  const [activeField, setActiveField] = useState("invoiceNumber");
  const [draft, setDraft] = useState(null);
  const [message, setMessage] = useState("");
  const [dragState, setDragState] = useState(null);

  useEffect(() => {
    const source = templateFromRecord(record, templates);
    setDraft(source ? JSON.parse(JSON.stringify(source)) : null);
    setActiveField("invoiceNumber");
    setMessage("");
  }, [record?.id]);

  useEffect(() => {
    if (draft) return;
    const source = templateFromRecord(record, templates);
    if (source) setDraft(JSON.parse(JSON.stringify(source)));
  }, [draft, record, templates]);

  if (!record.correctedImageUrl || !draft?.fields) return null;

  const fields = CORE_FIELDS.map(([field]) => field);
  const activeRegion = draft.fields[activeField] || { x: 0, y: 0, w: 0.1, h: 0.1 };

  function updateDraft(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function updateRegion(field, regionPatch) {
    setDraft((current) => ({
      ...current,
      fields: {
        ...current.fields,
        [field]: {
          ...(current.fields[field] || { x: 0, y: 0, w: 0.1, h: 0.1 }),
          ...regionPatch
        }
      }
    }));
  }

  function percentValue(key) {
    return Math.round((activeRegion[key] || 0) * 1000) / 10;
  }

  function setPercentValue(key, value) {
    const number = clamp(Number(value) / 100, key === "w" || key === "h" ? 0.01 : 0, 1);
    updateRegion(activeField, { [key]: number });
  }

  function onPointerDown(event, field) {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setActiveField(field);
    setDragState({
      field,
      startX: event.clientX,
      startY: event.clientY,
      rect,
      region: { ...draft.fields[field] }
    });
  }

  function onPointerMove(event) {
    if (!dragState) return;
    const dx = (event.clientX - dragState.startX) / dragState.rect.width;
    const dy = (event.clientY - dragState.startY) / dragState.rect.height;
    const nextX = clamp(dragState.region.x + dx, 0, 1 - dragState.region.w);
    const nextY = clamp(dragState.region.y + dy, 0, 1 - dragState.region.h);
    updateRegion(dragState.field, { x: nextX, y: nextY });
  }

  async function handleSave() {
    setMessage("儲存中...");
    try {
      const saved = await onSaveTemplate({
        ...draft,
        sourceCorrectedImagePath: record.correctedImagePath,
        canonicalSize: draft.canonicalSize || { width: 1200, height: 700 },
        fields: Object.fromEntries(CORE_FIELDS.map(([field]) => [
          field,
          draft.fields[field] || { x: 0, y: 0, w: 0.1, h: 0.1 }
        ]))
      }, record.id);
      setDraft(saved);
      setMessage("模板已儲存。請按「重新辨識」套用新的框選位置。");
      return true;
    } catch (error) {
      setMessage(error?.message || "模板儲存失敗");
      return false;
    }
  }

  async function handleSaveAndReprocess() {
    const ok = await handleSave();
    if (ok) await onReprocessRecord?.();
  }

  return (
    <section className="templatePanel" onPointerMove={onPointerMove} onPointerUp={() => setDragState(null)} onPointerLeave={() => setDragState(null)}>
      <div className="panelHead templateHead">
        <div>
          <h3>模板校正模式</h3>
          <span>拖曳框線位置，儲存後重新辨識</span>
        </div>
        <div className="templateHeadActions">
          <button type="button" className="primary" onClick={handleSave}>儲存模板</button>
          <button type="button" className="secondary" onClick={handleSaveAndReprocess}>儲存後重新辨識</button>
        </div>
      </div>
      <div className="templateGrid">
        <div className="templateImageBox" ref={imageRef}>
          <img src={record.correctedImageUrl} alt="校正後單據模板底圖" draggable={false} />
          {fields.map((field) => {
            const region = draft.fields[field];
            if (!region) return null;
            return (
              <button
                key={field}
                type="button"
                className={`templateRegion ${field === activeField ? "active" : ""}`}
                style={{
                  left: `${region.x * 100}%`,
                  top: `${region.y * 100}%`,
                  width: `${region.w * 100}%`,
                  height: `${region.h * 100}%`
                }}
                onPointerDown={(event) => onPointerDown(event, field)}
                title={TEMPLATE_FIELD_LABELS[field]}
              >
                {TEMPLATE_FIELD_LABELS[field]}
              </button>
            );
          })}
        </div>
        <div className="templateControls">
          <h3>欄位框設定</h3>
          <label>
            模板名稱
            <input value={draft.templateName || ""} onChange={(event) => updateDraft({ templateName: event.target.value })} />
          </label>
          <label>
            賣方統編
            <input value={draft.vendorTaxId || ""} onChange={(event) => updateDraft({ vendorTaxId: numericInput(event.target.value).slice(0, 8) })} />
          </label>
          <label>
            目前欄位
            <select value={activeField} onChange={(event) => setActiveField(event.target.value)}>
              {CORE_FIELDS.map(([field, label]) => <option key={field} value={field}>{label}</option>)}
            </select>
          </label>
          <div className="templateNumbers">
            {["x", "y", "w", "h"].map((key) => (
              <label key={key}>
                {key.toUpperCase()} %
                <input type="number" min="0" max="100" step="0.1" value={percentValue(key)} onChange={(event) => setPercentValue(key, event.target.value)} />
              </label>
            ))}
          </div>
          {message ? <p className="templateMessage">{message}</p> : <p>位置以校正後單據為基準；不同照片大小會先轉成同一張標準圖再套用這些比例。</p>}
        </div>
      </div>
    </section>
  );
}

function RecordsTable({ records, selectedId, setSelectedId }) {
  return (
    <div className="tableWrap">
      <table className="recordsTable">
        <thead>
          <tr>
            <th>序號</th>
            <th>狀態</th>
            <th>發票號碼</th>
            <th>統一編號</th>
            <th>數量</th>
            <th>單價</th>
            <th>金額</th>
            <th>稅金</th>
            <th>總金額</th>
            <th>是否確認</th>
            <th>圖片檔名</th>
          </tr>
        </thead>
        <tbody>
          {records.length ? records.map((record) => (
            <tr key={record.id} className={record.id === selectedId ? "activeRow" : ""} onClick={() => setSelectedId(record.id)}>
              <td className="seq">{record.sequenceNo}</td>
              <td><StatusBadge status={record.processingStatus} /></td>
              <td>{record.invoiceNumber}</td>
              <td>{record.taxId}</td>
              <td>{record.quantity}{recordItems(record).length > 1 ? ` (${recordItems(record).length}筆)` : ""}</td>
              <td>{record.unitPrice}</td>
              <td>{record.salesAmount}</td>
              <td>{record.taxAmount}</td>
              <td>{record.totalAmount}</td>
              <td>{record.status === "confirmed" ? "已確認" : "未確認"}</td>
              <td className="fileCell">{record.filename}</td>
            </tr>
          )) : <tr><td colSpan={11} className="emptyRow">尚無資料。</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
