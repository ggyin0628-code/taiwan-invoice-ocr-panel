# OCR Repair Baseline

This repair branch starts from `dba145ceac32e33c338d652e765a84ab434757cc` on `main`. The baseline was captured before source changes and is intentionally separate from runtime data.

| Check | Baseline result | Interpretation |
| --- | --- | --- |
| `npm test` | PASS; 11 checks | Existing checks pass, but several are source-string assertions and the suite does not execute the complete upload-to-confirm path. |
| `npm run test:ocr` | Exit 0 with `沒有可測試的樣本。` | **Not an OCR PASS.** No `samples/` images were processed, so no accuracy or reliability claim can be made. |
| `npm run doctor` before build | FAIL because `.next` was absent | The existing doctor checks local files and build output only; it does not probe PaddleOCR, Ollama, or model readiness. |
| `npm run doctor` after build | PASS | This only means the existing local file checks pass. It is not a provider readiness result. |
| `npm run build` | PASS | Next.js compilation succeeds; this does not prove runtime OCR, upload, confirmation, or export behavior. |

## Reproduction

Run the following commands from the repository root:

```bash
npm ci
npm test
npm run test:ocr
npm run doctor
npm run build
npm run doctor
```

The OCR benchmark remains **BLOCKED — no private fixtures supplied**. Real invoice images, ground truth, debug JSON, tax IDs, company names, addresses, and records must remain local and gitignored. A later phase adds a local-only evaluation harness that fails when no fixtures are available instead of reporting a false success.
