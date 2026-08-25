import json
import sys

from paddle_invoice_ocr import find_invoice_no, find_tax_id, get_engine_health, run_paddleocr


def main() -> None:
    health = get_engine_health()
    assert health["modelReady"] is True, health
    assert health["engineReady"] is True, health
    assert health["paddleocrVersion"] == "3.7.0", health
    assert health["paddleVersion"] == "3.3.1", health
    assert health["apiMode"] in {"predict", "legacy"}, health
    invoice_lines = [
        {"text": "TT", "confidence": 0.95, "box": {"x1": 120, "y1": 110, "x2": 170, "y2": 140}},
        {"text": "00000001", "confidence": 0.98, "box": {"x1": 200, "y1": 115, "x2": 360, "y2": 145}},
    ]
    assert find_invoice_no(invoice_lines, 700)["value"] == "TT00000001"
    tax_lines = [
        {"text": "統一編號：12345678中華民國115年4月2日", "confidence": 0.95, "box": {"x1": 120, "y1": 200, "x2": 850, "y2": 240}},
    ]
    assert find_tax_id(tax_lines, 700)["value"] == "12345678"
    simplified_tax_lines = [
        {"text": "统一編號：87654321中華民國115年6月2日", "confidence": 0.95, "box": {"x1": 120, "y1": 200, "x2": 850, "y2": 240}},
    ]
    assert find_tax_id(simplified_tax_lines, 700)["value"] == "87654321"
    if len(sys.argv) > 1:
        lines = run_paddleocr(sys.argv[1])
        assert lines, "PaddleOCR returned no lines"
        assert all(isinstance(line.get("text"), str) and line["text"] for line in lines)
        assert all(isinstance(line.get("confidence"), (int, float)) for line in lines)
        assert all(isinstance(line.get("box"), dict) for line in lines)
    print(json.dumps({"ok": True, "health": health}, ensure_ascii=False))


if __name__ == "__main__":
    main()
