# 安裝與啟動

此專案是本機端的台灣三聯式發票/財務收據整理面板。圖片與紀錄只存在自己的電腦，不需付費雲端 Vision API。

## 需要先安裝

1. macOS，建議 Apple Silicon。
2. Node.js 20 或更新版本。
3. Python 3.10 到 3.13。
4. Ollama。
5. Ollama 模型：

```bash
ollama pull qwen2.5vl:7b
```

## 第一次啟動

開兩個 Terminal 或雙擊兩個 .command 檔。

### 1. 啟動 PaddleOCR service

```bash
./PaddleOCR服務-啟動.command
```

或手動執行：

```bash
cd ocr-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8765
```

### 2. 啟動面板

```bash
./財務收據整理面板-啟動.command
```

或手動執行：

```bash
npm ci
npm run build
npm run start -- -p 3000
```

瀏覽器開啟：

```text
http://localhost:3000
```

## 資料位置

- 上傳圖片：`data/uploads`
- 處理圖片：`data/processed`
- OCR debug：`data/debug`
- 紀錄：`data/records.json`

這些 runtime 資料不應提交到 GitHub。
