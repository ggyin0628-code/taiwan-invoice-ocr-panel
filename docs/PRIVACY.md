# 隱私與資料保存

此專案設計為本機端使用。

## 不會做的事

- 不把發票圖片上傳到 Google Vision。
- 不把發票圖片上傳到 OpenAI Vision。
- 不使用付費雲端 OCR API。
- 不把原始圖片塞進 browser localStorage。

## 本機保存位置

- 原圖：`data/uploads`
- 處理後圖片：`data/processed`
- OCR debug：`data/debug`
- 使用者確認資料：`data/records.json`

開源或回報 issue 時，請不要上傳真實發票、統編、公司章、地址或 debug JSON。
