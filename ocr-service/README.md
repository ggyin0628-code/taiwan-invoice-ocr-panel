# PaddleOCR 本機 OCR Service

這個 service 是「發票辨識填入 Excel」專案的本機開源 OCR provider。Next.js 不直接載入 PaddleOCR，而是透過 HTTP 呼叫本機 Python service，避免把大型 OCR 相依綁死在 Next.js API 內。

PaddleOCR 官方專案採 Apache-2.0 授權，支援圖片/PDF 轉結構化資料與多語言 OCR。這裡只使用本機 OCR 結果作為初步填入，財務資料仍必須人工確認。

## 建立 Python venv

```bash
cd ocr-service
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
```

## 安裝套件

```bash
pip install -r requirements.txt
```

若 Mac M3 / Apple Silicon 安裝 `paddlepaddle` 失敗，請依 PaddlePaddle 官方安裝頁選擇對應版本。PaddleOCR 3.x 需要 PaddlePaddle 3.0 以上；官方文件也提供 CPU 安裝指令範例：

```bash
python -m pip install paddlepaddle==3.2.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
python -m pip install "paddleocr[all]"
```

## 啟動 service

```bash
uvicorn app:app --host 127.0.0.1 --port 8765
```

健康檢查：

```bash
curl http://127.0.0.1:8765/health
```

預期：

```json
{"ok":true,"provider":"paddleocr"}
```

## 測試單張發票

```bash
curl -X POST http://127.0.0.1:8765/ocr/invoice \
  -F "file=@/path/to/test-invoice.jpg"
```

## Next.js 切換 PaddleOCR

在專案根目錄 `.env.local` 加上：

```env
OCR_PROVIDER=paddleocr
PADDLE_OCR_SERVICE_URL=http://127.0.0.1:8765
PADDLE_OCR_ENABLED=true
```

或在前端辨識模式選 `paddleocr`。

## 常見錯誤

- `paddlepaddle` 安裝失敗：Apple Silicon / Python 版本可能不相容，請依官方 PaddlePaddle 安裝文件選 CPU wheel。
- 首次辨識很慢：PaddleOCR 需要下載模型。
- service 沒啟動：Next.js provider 會回傳錯誤並 fallback 到 local，不會讓系統崩潰。
- 繁中效果不穩：目前先使用中文模型；繁中欄位仍需人工確認。

## 財務使用限制

PaddleOCR 不保證 100% 正確。正式欄位仍要經過系統驗證與人工確認；低信心、格式錯誤、缺漏資料不得直接進 Excel。
