# OCR Evaluation Harness

The OCR benchmark is local-only. Real invoice images and their ground truth must never be committed to GitHub. Put images in `samples-private/` and put a matching JSON object in `ground-truth-private.json`; both paths are gitignored.

The ground-truth file can be keyed by filename:

```json
{
  "sample-001.jpg": {
    "invoiceNumber": "AB12345678",
    "buyerTaxId": "12345678",
    "items": [
      { "itemName": "測試品項", "quantity": 2, "unitPrice": 100 }
    ],
    "salesAmount": 200,
    "taxAmount": 10,
    "totalAmount": 210
  }
}
```

Run `npm run test:ocr`. The command returns exit code `2` with an explicit `BLOCKED` message when there are no images, so an empty fixture directory cannot be mistaken for a successful OCR regression run. With fixtures, it writes a timestamped result and `latest.json` under `.ocr-benchmark/`, which is also local-only.

The result includes exact-match rate, field accuracy, missing rate, false-positive rate, manual-review rate, provider-failure rate, and a per-image record containing predicted fields, expected fields, status, review state, and debug-artifact path. Formula-derived amounts are compared after normalization; raw OCR text is not part of the official ground truth.

A real-sample certification claim remains blocked until a user supplies private fixtures and reviews the resulting before/after benchmark. This repository contains no real invoice image, company tax ID, address, filled record, or OCR debug output.
