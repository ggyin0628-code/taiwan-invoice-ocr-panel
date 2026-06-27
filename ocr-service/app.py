from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

from paddle_invoice_ocr import recognize_invoice

app = FastAPI(title="Finance Receipt PaddleOCR Service")


@app.get("/health")
def health():
    return {"ok": True, "provider": "paddleocr"}


@app.post("/ocr/invoice")
async def ocr_invoice(file: UploadFile = File(...)):
    suffix = Path(file.filename or "invoice.jpg").suffix or ".jpg"
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name
        result = recognize_invoice(tmp_path)
        return JSONResponse(result)
    except Exception as exc:  # pragma: no cover - service safety net
        return JSONResponse(
            {"ok": False, "provider": "paddleocr", "error": str(exc), "warnings": []},
            status_code=500,
        )
    finally:
        try:
            Path(locals().get("tmp_path", "")).unlink(missing_ok=True)
        except Exception:
            pass
