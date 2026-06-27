# OCR 流程

正式流程固定使用 hybrid provider。

1. PaddleOCR service 讀取文字與 bbox。
2. Python/JavaScript 規則依台灣三聯式發票固定版面抽欄位。
3. 品項金額不直接相信 OCR，正式金額由公式產生：

```text
每列金額 = 數量 x 單價
銷售額 = 所有明細列金額加總
稅金 = Math.round(銷售額 x 0.05)
總金額 = 銷售額 + 稅金
```

4. Ollama/qwen2.5vl:7b 只輔助低信心欄位，例如賣方名稱或模糊欄位。
5. 所有 OCR 結果都可人工修改。
6. 只有使用者人工確認後，資料才算正式資料。
7. Excel 只匯出正式欄位，不匯出 OCR raw text。

## 設計原則

- 不呼叫 Google Vision。
- 不呼叫 OpenAI Vision。
- 不使用付費雲端 API。
- 圖片不放 localStorage。
- 圖片存到 `data/uploads`。
- 紀錄存到 `data/records.json`。
