from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from PIL import Image


STATUS_CONFIRMED = "CONFIRMED"
STATUS_NEEDS_REVIEW = "NEEDS_REVIEW"
STATUS_INVALID = "INVALID"
STATUS_MISSING = "MISSING"


@lru_cache(maxsize=1)
def get_ocr():
    from paddleocr import PaddleOCR

    try:
        return PaddleOCR(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            engine="paddle",
        )
    except TypeError:
        return PaddleOCR(use_angle_cls=False, lang="ch", show_log=False)


def _box_from_points(points: list[Any]) -> dict[str, int]:
    xs: list[float] = []
    ys: list[float] = []
    for point in points or []:
        if isinstance(point, dict):
            x, y = point.get("x"), point.get("y")
        else:
            x, y = point[0], point[1]
        try:
            xs.append(float(x))
            ys.append(float(y))
        except Exception:
            continue
    if not xs or not ys:
        return {"x1": 0, "y1": 0, "x2": 0, "y2": 0}
    return {
        "x1": int(min(xs)),
        "y1": int(min(ys)),
        "x2": int(max(xs)),
        "y2": int(max(ys)),
    }


def _normalize_v3_result(result: Any) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    for page in result or []:
        data = getattr(page, "json", None)
        if callable(data):
            data = data()
        if not isinstance(data, dict):
            data = getattr(page, "res", page)
        if isinstance(data, dict) and "res" in data and isinstance(data["res"], dict):
            data = data["res"]
        texts = data.get("rec_texts") if isinstance(data, dict) else None
        scores = data.get("rec_scores") if isinstance(data, dict) else None
        boxes = data.get("rec_polys") or data.get("dt_polys") if isinstance(data, dict) else None
        if not texts:
            continue
        for index, text in enumerate(texts):
            box = _box_from_points((boxes or [])[index] if index < len(boxes or []) else [])
            lines.append(
                {
                    "text": str(text).strip(),
                    "confidence": float((scores or [0])[index] if index < len(scores or []) else 0),
                    "box": box,
                }
            )
    return [line for line in lines if line["text"]]


def _normalize_legacy_result(result: Any) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    for page in result or []:
        for item in page or []:
            if not item or len(item) < 2:
                continue
            box_points = item[0]
            rec = item[1]
            text = rec[0] if isinstance(rec, (list, tuple)) and rec else ""
            score = rec[1] if isinstance(rec, (list, tuple)) and len(rec) > 1 else 0
            if text:
                lines.append({"text": str(text).strip(), "confidence": float(score), "box": _box_from_points(box_points)})
    return lines


def run_paddleocr(image_path: str) -> list[dict[str, Any]]:
    ocr = get_ocr()
    if hasattr(ocr, "predict"):
        lines = _normalize_v3_result(ocr.predict(image_path))
        if lines:
            return sort_lines(lines)
    if hasattr(ocr, "ocr"):
        return sort_lines(_normalize_legacy_result(ocr.ocr(image_path, cls=False)))
    return []


def sort_lines(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(lines, key=lambda line: (line["box"]["y1"], line["box"]["x1"]))


def digits(value: str) -> str:
    return re.sub(r"\D", "", value or "")


def number_value(value: str) -> int | None:
    cleaned = re.sub(r"[^\d]", "", value or "")
    if not cleaned:
        return None
    try:
        return int(cleaned)
    except ValueError:
        return None


def field(value: Any, confidence: float, status: str = STATUS_NEEDS_REVIEW) -> dict[str, Any]:
    return {"value": value, "confidence": confidence, "source": "paddleocr", "status": status}


def find_invoice_no(lines: list[dict[str, Any]]) -> dict[str, Any]:
    joined = " ".join(line["text"].upper() for line in lines)
    match = re.search(r"[A-Z]{2}\s*\d{8}", joined)
    if match:
        value = re.sub(r"\s+", "", match.group(0))
        confidence = max((line["confidence"] for line in lines if value[:2] in line["text"].upper() or value[2:] in digits(line["text"])), default=0.8)
        return field(value, confidence, STATUS_CONFIRMED if confidence >= 0.85 else STATUS_NEEDS_REVIEW)

    prefix_candidates = []
    number_candidates = []
    for line in lines:
        text = line["text"].upper()
        cx, cy = line_center(line)
        if re.fullmatch(r"[A-Z]{2}", text):
            prefix_candidates.append((line, cx, cy))
        if re.fullmatch(r"\d{8}", digits(text)):
            number_candidates.append((line, cx, cy, digits(text)))
    for prefix_line, prefix_x, prefix_y in prefix_candidates:
        prefix = prefix_line["text"].upper()
        for number_line, number_x, number_y, number in number_candidates:
            if number_x > prefix_x and abs(number_y - prefix_y) <= 35 and prefix_y < 180:
                confidence = min(float(prefix_line["confidence"]), float(number_line["confidence"]))
                return field(f"{prefix}{number}", confidence, STATUS_CONFIRMED if confidence >= 0.85 else STATUS_NEEDS_REVIEW)
    return field(None, 0, STATUS_MISSING)


def find_tax_id(lines: list[dict[str, Any]]) -> dict[str, Any]:
    keyword_re = re.compile(r"(統一編號|統編|買受人|營業人)")
    candidates: list[tuple[int, float, str]] = []
    label_lines = [line for line in lines if re.search(r"(統一編號|統編)", line["text"])]
    for label in label_lines:
        label_x, label_y = line_center(label)
        same_row_numbers: list[tuple[float, float, str]] = []
        for line in lines:
            text_digits = digits(line["text"])
            if not re.fullmatch(r"\d{8}", text_digits):
                continue
            cx, cy = line_center(line)
            if cx <= label_x or abs(cy - label_y) > 35:
                continue
            same_row_numbers.append((cx - label_x, float(line["confidence"]), text_digits))
        if same_row_numbers:
            _, confidence, value = sorted(same_row_numbers, key=lambda item: item[0])[0]
            return field(value, min(confidence, 0.84), STATUS_NEEDS_REVIEW)

    for index, line in enumerate(lines):
        text = line["text"]
        if not keyword_re.search(text):
            continue
        window = " ".join(next_line["text"] for next_line in lines[index : index + 4])
        for match in re.finditer(r"\d{8}", digits(window)):
            candidates.append((index, line["confidence"], match.group(0)))
    if not candidates:
        for line in lines:
            for match in re.finditer(r"\d{8}", digits(line["text"])):
                candidates.append((999, line["confidence"], match.group(0)))
    if not candidates:
        return field(None, 0, STATUS_MISSING)
    _, confidence, value = sorted(candidates, key=lambda item: item[0])[0]
    # Handwritten boxed tax IDs are easy to misread even when OCR reports high confidence.
    return field(value, min(confidence, 0.84), STATUS_NEEDS_REVIEW)


def line_center(line: dict[str, Any]) -> tuple[float, float]:
    box = line.get("box") or {}
    return ((box.get("x1", 0) + box.get("x2", 0)) / 2, (box.get("y1", 0) + box.get("y2", 0)) / 2)


def normalized_text_number(text: str) -> int | None:
    normalized = (text or "").strip().upper().replace("I", "1").replace("L", "1").replace("|", "1")
    return number_value(normalized)


def group_rows(lines: list[dict[str, Any]], tolerance: int = 34) -> list[list[dict[str, Any]]]:
    rows: list[list[dict[str, Any]]] = []
    for line in sorted(lines, key=lambda item: line_center(item)[1]):
        _, cy = line_center(line)
        target = None
        for row in rows:
            row_y = sum(line_center(item)[1] for item in row) / len(row)
            if abs(row_y - cy) <= tolerance:
                target = row
                break
        if target is None:
            rows.append([line])
        else:
            target.append(line)
    return [sorted(row, key=lambda item: line_center(item)[0]) for row in rows]


def _band(center: float, half_width: float) -> tuple[float, float]:
    return (center - half_width, center + half_width)


def estimate_table_bands(lines: list[dict[str, Any]], header_y: float) -> dict[str, tuple[float, float]]:
    """Estimate column bands from the recognized table header on the corrected invoice."""
    header_lines = [line for line in lines if abs(line["box"]["y1"] - header_y) <= 24]
    bands: dict[str, tuple[float, float]] = {}

    for line in header_lines:
        text = line["text"]
        cx, _ = line_center(line)
        if "數量" in text or "数量" in text:
            # PaddleOCR often merges "數量單價金" into one text box.
            if "單價" in text or "单价" in text or "金" in text:
                bands["quantity"] = _band(cx - 80, 48)
                bands["unitPrice"] = _band(cx + 35, 58)
                bands["amountReference"] = _band(cx + 175, 75)
            else:
                bands["quantity"] = _band(cx, 48)
        if "單價" in text or "单价" in text:
            if "quantity" not in bands and ("數量" in text or "数量" in text):
                bands["quantity"] = _band(cx - 80, 48)
            bands["unitPrice"] = _band(cx, 58)
        if "金額" in text or "金额" in text or text in {"金", "額", "额"}:
            bands["amountReference"] = _band(cx, 75)

    # Conservative fallback for the normalized 1200px-wide corrected invoice.
    bands.setdefault("quantity", (390, 505))
    bands.setdefault("unitPrice", (505, 625))
    bands.setdefault("amountReference", (625, 780))
    return bands


def in_band(cx: float, band: tuple[float, float]) -> bool:
    return band[0] <= cx <= band[1]


def extract_items(lines: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    header_y = None
    lower_y = None
    for line in lines:
        text = line["text"]
        if header_y is None and ("数量" in text or "數量" in text or "單價" in text or "单价" in text):
            header_y = line["box"]["y1"]
        if header_y is not None and line["box"]["y1"] > header_y and ("營業人蓋用" in text or "营业人盖用" in text or "銷售" in text or "销售" in text):
            lower_y = line["box"]["y1"]
            break
    if header_y is None:
        header_y = 0
    if lower_y is None:
        lower_y = 999999

    bands = estimate_table_bands(lines, header_y)
    table_lines = [
        line for line in lines
        if header_y + 10 <= line["box"]["y1"] <= lower_y - 5 and line["box"]["x1"] < 760
    ]
    rows = group_rows(table_lines)
    items: list[dict[str, Any]] = []
    warnings: list[str] = []
    for row in rows:
        name_parts: list[str] = []
        quantity = None
        unit_price = None
        confidences: list[float] = []
        row_amount_reference = None
        for line in row:
            text = line["text"]
            cx, _ = line_center(line)
            value = normalized_text_number(text)
            if cx < 350 and not re.fullmatch(r"[\d,\sIl|L]+", text):
                name_parts.append(text)
            elif in_band(cx, bands["quantity"]) and value is not None and 1 <= value <= 999:
                quantity = value
                confidences.append(float(line["confidence"]))
            elif in_band(cx, bands["unitPrice"]) and value is not None and value > 0:
                unit_price = value
                confidences.append(float(line["confidence"]))
            elif in_band(cx, bands["amountReference"]) and value is not None and value > 0:
                row_amount_reference = value
        if quantity is None or unit_price is None:
            if quantity is not None or unit_price is not None:
                warnings.append("數量欄與單價欄筆數不一致，需人工確認")
            continue
        amount = quantity * unit_price
        if row_amount_reference is not None and abs(row_amount_reference - amount) > max(2, round(amount * 0.02)):
            warnings.append(f"金額參考欄與公式不一致：{quantity} x {unit_price} = {amount}，參考欄 {row_amount_reference}")
        name = " ".join(name_parts).strip()[:80] or None
        confidence = min(confidences) if confidences else 0.5
        items.append(
            {
                "name": name,
                "quantity": quantity,
                "amount": amount,
                "unitPrice": unit_price,
                "confidence": confidence,
                "status": STATUS_CONFIRMED if confidence >= 0.85 else STATUS_NEEDS_REVIEW,
            }
        )
    return items[:8], warnings


def recognize_invoice(image_path: str) -> dict[str, Any]:
    image = Image.open(image_path)
    lines = run_paddleocr(image_path)
    raw_text = "\n".join(line["text"] for line in lines)
    items, item_warnings = extract_items(lines)
    subtotal = sum(item["amount"] for item in items if isinstance(item.get("amount"), int)) if items else None
    tax = round(subtotal * 0.05) if subtotal else None
    total = subtotal + tax if subtotal and tax is not None else None
    return {
        "ok": True,
        "provider": "paddleocr",
        "rawText": raw_text,
        "lines": lines,
        "fields": {
            "invoiceNo": find_invoice_no(lines),
            "buyerTaxId": find_tax_id(lines),
            "items": items,
            "subtotal": subtotal,
            "tax": tax,
            "total": total,
        },
        "warnings": ["PaddleOCR 僅供初步填入，仍需人工確認", *item_warnings],
        "debug": {"imageWidth": image.width, "imageHeight": image.height},
    }
