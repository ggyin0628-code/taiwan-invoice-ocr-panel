# 台灣三聯式發票 OCR Reliability Repair Final Report

**Repository:** [`ggyin0628-code/taiwan-invoice-ocr-panel`][1]
**Working branch:** `repair/ocr-reliability`
**Base:** `dba145ceac32e33c338d652e765a84ab434757cc` (`origin/main`)
**HEAD:** 以 `git rev-parse HEAD` 取得目前 repair branch 最新 commit；本報告不硬編碼會因文件更新而變動的 tip。
**Author:** Manus AI
**Scope:** 依附件要求完成只讀稽核、分階段修復、功能回歸、啟動與降級驗證。所有變更留在本地 repair branch；`main` 未被修改，也未將真實發票或 OCR debug data 加入 repository。

## Executive conclusion

這次修復已把專案從「能啟動但 OCR、狀態、確認與 fallback 邊界不一致」推進到一個可執行的 local-first 工作流：上傳後進入單一路徑的本機 OCR／可選 PaddleOCR provider、相對幾何版面解析、公式金額計算、可編輯多列明細、人工確認、Excel 匯出，以及可見的服務健康狀態。`npm test`、`npm run build`、`npm run doctor` 與實際 production server route smoke test 均通過。

然而，**目前不能宣稱真實台灣發票 OCR 已達指定準確率，也不能把本次結果當成真實照片 benchmark**。原 repository 沒有真實 invoice fixture；新的 `npm run test:ocr` 會在沒有私有樣本時以 exit code `2` 明確標記 `BLOCKED`，避免空資料夾產生虛假的 PASS。要完成真實照片前後比較，仍須由使用者在本機提供私有圖片及逐欄 ground truth，執行 `docs/OCR_EVALUATION.md` 所述 harness。

## 修復範圍與需求對照

| 要求 | 實作結果 | 主要位置 |
|---|---|---|
| 先做只讀 audit，再修復 | 已完成。audit、執行路徑與基線另存文件，未在 audit 階段改 source | `docs/REPAIR_BASELINE.md`、`/home/ubuntu/ocr_audit_phase0.md` |
| 保持 main 不動 | 已完成。所有變更位於 `repair/ocr-reliability`，工作樹乾淨 | Git branch / commit history |
| 分離 warning、低信心與必須修正 | 已完成。新增 `AUTO_OK`、`REVIEW_RECOMMENDED`、`REVIEW_REQUIRED`、`INVALID`、`PROVIDER_UNAVAILABLE`、`FAILED` | `lib/server/invoiceStatus.js`、`validateInvoiceRecognition.js`、`mergeInvoiceRecognitionResults.js` |
| 避免 Paddle notice 讓所有紀錄變成 need review | 已完成。Paddle notice 改為 informational `notices`；只有欄位缺失、格式錯誤、公式不一致或 provider failure 進入對應狀態 | `ocr-service/paddle_invoice_ocr.py`、`lib/server/processInvoice.js` |
| 單一路徑 orchestrator | 已完成。local OCR、可選 Paddle candidate、merge、validation 與 status 僅由 `processInvoice.js` 統一處理；舊未引用 `hybridInvoiceRecognizer.js` 已移除 | `lib/server/processInvoice.js` |
| 不把付費 cloud OCR 當預設 | 已完成。預設為 hybrid/local-first，`AI_VISION_PROVIDER=none`，cloud provider 會回傳人工模式，不會暗中上傳 | `processInvoice.js`、health defaults |
| 真實照片可變尺寸／旋轉／傾斜 | 已改善。輸入統一 rotate，table column 與 invoice/tax-id thresholds 改為依影像尺寸及偵測 header 相對計算 | `lib/server/processInvoice.js`、`lib/server/anchorExtractor.js`、`ocr-service/paddle_invoice_ocr.py` |
| 明細表可編輯 | 已完成。品名、數量、單價可逐列修改；金額由公式重算；可新增、刪除、確認列，並顯示 confidence、source、status | `app/page.jsx`、`lib/server/lineItems.js`、`app/api/records/[id]/route.js` |
| 確認不得清除 validation error | 已完成。`status=confirmed` 先重跑官方欄位驗證，失敗回傳 HTTP 422 且保留 `validationErrors` | `app/api/records/[id]/route.js` |
| 啟動與 provider 健康可觀測 | 已完成。`/api/health` 與 UI health strip 顯示 Next.js、PaddleOCR、Ollama、Model 的 `READY/DOWN/MISSING` | `lib/server/providerHealth.js`、`app/api/health/route.js`、`scripts/doctor.mjs`、`app/page.jsx` |
| 私有 fixture OCR regression | 已完成 harness。無樣本時明確 BLOCKED，不再 false PASS；fixture 與 ground truth 被 gitignore | `scripts/test-ocr-samples.mjs`、`docs/OCR_EVALUATION.md`、`.gitignore` |

## 重要程式變更

### 狀態與 validation contract

`lib/server/invoiceStatus.js` 建立了 canonical status model。資訊性 warning 不再等同於錯誤；低信心但格式正確的值會保留並標為 `REVIEW_RECOMMENDED`，只有缺失、格式錯誤、公式不一致、provider 無法使用或 runtime failure 才會阻擋流程。這個區分同時保留舊 UI 所需的 `processingStatus`，以降低對既有資料的破壞性。

官方確認路徑現在會以所有持久化欄位重新驗證。多列 `items` 會逐列檢查數量及單價，並由公式重算銷售額、5% 稅額與總額；確認失敗時回應 `422`，不會先把資料標成 confirmed，也不會抹掉錯誤。

### OCR orchestrator 與 provider 邊界

`processInvoice.js` 現在只執行一次本機 OCR／版面解析，將可用的 PaddleOCR 結果加入 candidate，再由 merge layer 選擇或標記衝突。PaddleOCR 不可用時會回傳 `provider_unavailable` 並保留 local fallback；Ollama 只作為低信心增強選項，不會讓 UI 在服務缺失時失去回應。付費 cloud provider 沒有被設成預設，且在程式內明確返回人工模式。

### 相對幾何與明細解析

JavaScript 與 Python provider 的表格 resolver 都不再依賴單一 1200×700 圖片的固定 pixel crop。它們優先使用偵測到的「數量／單價／金額」header 計算 column bands，未偵測到 header 時才使用相對於影像寬高的 fallback。JavaScript resolver 會產生含 `lineNo`、`itemName`、`quantity`、`unitPrice`、`amount`、`confidence`、`source`、`status` 的明細列。

### 使用者流程

主流程現在把「上傳、辨識、人工修正、確認、匯出」置於前景；debug JSON、OCR crop、bbox 與模板校正移到 `進階 / Debug / 模板校正` disclosure。明細表提供新增、刪除、逐格編輯與確認列，且會同步後端資料。health strip 以簡短狀態呈現 provider 是否可用，不讓 provider 技術細節取代主要任務。

## 驗證結果

| Command / smoke test | 結果 | 備註 |
|---|---:|---|
| `npm test` | PASS，18 個測試 | 含 warning 分類、低信心保留、確認阻擋、相對幾何、line-item editor、health/doctor 與 benchmark guard |
| `npm run build` | PASS | Next.js production build、lint/type validity、page generation 通過 |
| `node --check` | PASS | doctor、benchmark、health、核心 server modules 通過 |
| `npm run doctor` | PASS，exit 0 | Next.js `READY`；PaddleOCR `DOWN`；Ollama `DOWN`；Model `MISSING`；optional provider 不阻塞 UI |
| `npm run test:ocr` | BLOCKED，exit 2 | `samples-private/` 沒有圖片；這是刻意的安全失敗，不是 OCR PASS |
| `GET /api/health` | PASS，HTTP 200 | `ok=true`、`mode=hybrid`、degradation message 可讀 |
| `GET /api/records` | PASS，HTTP 200 | 初始 records 為空 |
| `HEAD /api/export` | PASS，HTTP 200 | 回傳 XLSX content type 與 download disposition |
| 合成圖片 `POST /api/import` | PASS | 僅使用 `SMOKE TEST ONLY` 合成圖，不含真實發票 |
| 合成 record `POST /process` provider=manual | PASS | 正確進入 `need_review`，未呼叫 OCR |
| 合成 record `DELETE` | PASS | smoke test 發現並修正 records route 遺漏 import 後重建驗證成功 |
| `git diff --check` | PASS | 無 whitespace error |
| tracked private fixture check | PASS | `samples-private`、ground truth、OCR benchmark、uploads/debug 實例皆未被追蹤 |

### 本次 runtime smoke test 的注意事項

第一次使用舊 production build 呼叫 DELETE 時發現 `deleteRecord is not defined`。原因是重寫 route 時遺漏 `records.js` import；已在 `cb861c8` 修正，重建後以相同路徑重新驗證成功。這個問題已納入最終 commit history，不是尚未處理的已知缺陷。

目前 sandbox 中 PaddleOCR service 與 Ollama 都未啟動，因此實際 health 顯示如下：

| Service | 最終觀測狀態 | 系統行為 |
|---|---|---|
| Next.js | `READY` | 可提供 UI/API |
| PaddleOCR | `DOWN` | 保留 local OCR fallback，紀錄標記 provider unavailable 或需人工檢查 |
| Ollama | `DOWN` | 不阻塞 UI；低信心欄位保留人工校正 |
| `qwen2.5vl:7b` | `MISSING` | 不阻塞 UI；doctor 清楚提示可選安裝 |

## Commit checkpoints

| Commit | 目的 |
|---|---|
| `2967572` | `docs: record OCR repair baseline` |
| `54440be` | `fix: separate OCR warnings from validation failures` |
| `ce5c7bb` | `fix: align validation and merge statuses` |
| `93d9908` | `refactor: unify invoice OCR orchestration` |
| `86bbdcf` | `fix: make invoice extraction geometry relative` |
| `d57eaff` | `feat: add editable invoice line items` |
| `eeb89ed` | `test: add private OCR regression harness` |
| `8915c22` | `feat: add provider health and graceful degradation` |
| `cb861c8` | `fix: restore record route data imports` |
| `2335893` | `refactor: remove unused duplicate hybrid recognizer` |
| `33d44e6` | `fix: make desktop restart checks portable` |
| `1176ddc` | `docs: publish OCR repair final report` |
| `84dc5ab` | `docs: clean final report formatting` |

最後的報告同步與格式修正仍保留於 branch history；請以 `git log --oneline --max-count=15` 查看完整歷史。

最終檢查確認 repair branch 工作樹乾淨，`git diff --check origin/main...HEAD` 通過，且 main 上的 `data/records.json` 未被修改；要取得精確變更統計，請執行 `git diff --stat origin/main...HEAD`。

## Real-photo benchmark handoff

要完成真實照片前後比較，請在本機執行以下流程；這些資料不會進 Git：

```bash
cd taiwan-invoice-ocr-panel
mkdir -p samples-private
# 將真實照片放入 samples-private/，只留在本機
# 建立 ground-truth-private.json，格式參見 docs/OCR_EVALUATION.md
npm run test:ocr
```

harness 會輸出 exact match、field accuracy、missing rate、false-positive rate、manual-review rate 與 provider-failure rate，並保留每張圖片的 predicted／expected／status／debug path。只有完成這一步後，才可以用實際樣本談照片旋轉、傾斜、光線、手寫統編與多列明細的改善幅度。若要做 before/after，應先在修復前 commit checkout 同一批私有 fixture 產生基線，再回到 `repair/ocr-reliability` 使用相同資料重跑；不要比較不同樣本或空 fixture。

## Remaining limitations and merge recommendation

這個 branch **可以進行 code review 與合併候選評估**，因為主要 runtime、狀態、編輯、確認、health、測試與安全邊界已完成且 automated checks 通過；但應附帶一個明確條件：**尚未完成真實 invoice fixture certification**。目前沒有真實照片資料，因此無法誠實回答欄位級 accuracy、旋轉／傾斜改善百分比或 90% 以上的準確率。

合併前最後應由產品擁有者提供一批不進 repository 的代表性照片與逐欄 truth，至少覆蓋正常正拍、旋轉、輕微傾斜、反光、陰影、低光、手寫買受人統編、單列、多列與極端金額。執行 benchmark 後，再由人工抽查每一筆 `REVIEW_RECOMMENDED` 與 `REVIEW_REQUIRED`，確認「低信心可修正」與「真正不應自動確認」的邊界符合會計作業規則。

## References

[1]: https://github.com/ggyin0628-code/taiwan-invoice-ocr-panel "taiwan-invoice-ocr-panel GitHub repository"
