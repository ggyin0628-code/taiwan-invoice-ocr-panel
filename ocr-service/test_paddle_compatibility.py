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
    invoice_result = find_invoice_no(invoice_lines, 700)
    assert invoice_result["value"] == "TT00000001"
    assert invoice_result["evidence"]
    assert invoice_result["evidence"][0]["rawCandidate"]
    assert invoice_result["evidence"][0]["normalizedCandidate"] == "TT00000001"
    assert invoice_result["evidence"][0]["bbox"]["x2"] > invoice_result["evidence"][0]["bbox"]["x1"]
    assert invoice_result["evidence"][0]["evidenceScore"] >= 0.7
    tax_lines = [
        {"text": "統一編號：12345678中華民國115年4月2日", "confidence": 0.95, "box": {"x1": 120, "y1": 200, "x2": 850, "y2": 240}},
    ]
    tax_result = find_tax_id(tax_lines, 700)
    assert tax_result["value"] == "12345678"
    assert tax_result["evidence"]
    assert tax_result["evidence"][0]["anchorRelationship"] == "buyer-anchor-inline"
    assert tax_result["evidence"][0]["evidenceScore"] >= 0.7
    simplified_tax_lines = [
        {"text": "统一編號：87654321中華民國115年6月2日", "confidence": 0.95, "box": {"x1": 120, "y1": 200, "x2": 850, "y2": 240}},
    ]
    assert find_tax_id(simplified_tax_lines, 700)["value"] == "87654321"
    seller_only_lines = [
        {"text": "營業人蓋用統一發票專用章", "confidence": 0.98, "box": {"x1": 800, "y1": 300, "x2": 1100, "y2": 340}},
        {"text": "87654321", "confidence": 0.99, "box": {"x1": 850, "y1": 350, "x2": 1000, "y2": 380}},
    ]
    seller_only_result = find_tax_id(seller_only_lines, 700)
    assert seller_only_result["value"] is None
    assert seller_only_result["evidence"]
    assert seller_only_result["evidence"][0]["anchorRelationship"] == "seller-region-excluded"
    assert seller_only_result["evidence"][0]["evidenceScore"] == 0
    if len(sys.argv) > 1:
        lines = run_paddleocr(sys.argv[1])
        assert lines, "PaddleOCR returned no lines"
        assert all(isinstance(line.get("text"), str) and line["text"] for line in lines)
        assert all(isinstance(line.get("confidence"), (int, float)) for line in lines)
        assert all(isinstance(line.get("box"), dict) for line in lines)
    print(json.dumps({"ok": True, "health": health}, ensure_ascii=False))


if __name__ == "__main__":
    main()
