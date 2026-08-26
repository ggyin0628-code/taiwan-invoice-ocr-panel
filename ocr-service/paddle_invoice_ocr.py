from __future__ import annotations

import os
import re
from functools import lru_cache
from typing import Any

from PIL import Image


STATUS_CONFIRMED = "CONFIRMED"
STATUS_NEEDS_REVIEW = "NEEDS_REVIEW"
STATUS_INVALID = "INVALID"
STATUS_MISSING = "MISSING"


_ENGINE_STATE: dict[str, Any] = {
    "paddleocrVersion": None,
    "paddleVersion": None,
    "modelReady": False,
    "engineReady": False,
    "lastInitializationError": None,
    "apiMode": None,
}


@lru_cache(maxsize=1)
def get_ocr():
    try:
        import paddle
        from paddleocr import PaddleOCR, __version__ as paddleocr_version

        _ENGINE_STATE["paddleVersion"] = getattr(paddle, "__version__", None)
        _ENGINE_STATE["paddleocrVersion"] = paddleocr_version
        modern_config = {
            "use_doc_orientation_classify": False,
            "use_doc_unwarping": False,
            "use_textline_orientation": False,
            "engine": "paddle",
            # PaddlePaddle 3.3.x CPU oneDNN PIR conversion can fail on this path.
            "enable_mkldnn": False,
        }
        try:
            engine = PaddleOCR(**modern_config)
            _ENGINE_STATE["apiMode"] = "predict"
        except TypeError:
            try:
                engine = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False, enable_mkldnn=False)
            except TypeError:
                engine = PaddleOCR(use_angle_cls=False, lang="ch", show_log=False)
            _ENGINE_STATE["apiMode"] = "legacy"
        if not (hasattr(engine, "predict") or hasattr(engine, "ocr")):
            raise RuntimeError("PaddleOCR engine exposes neither predict() nor ocr()")
        _ENGINE_STATE["modelReady"] = True
        _ENGINE_STATE["engineReady"] = True
        _ENGINE_STATE["lastInitializationError"] = None
        return engine
    except Exception as exc:
        _ENGINE_STATE["modelReady"] = False
        _ENGINE_STATE["engineReady"] = False
        _ENGINE_STATE["lastInitializationError"] = f"{type(exc).__name__}: {exc}"
        raise


def get_engine_health() -> dict[str, Any]:
    try:
        engine = get_ocr()
        ready = engine is not None and (hasattr(engine, "predict") or hasattr(engine, "ocr"))
        _ENGINE_STATE["engineReady"] = bool(ready)
        _ENGINE_STATE["modelReady"] = bool(ready)
    except Exception:
        pass
    return {
        "service": "paddleocr",
        "paddleocrVersion": _ENGINE_STATE["paddleocrVersion"],
        "paddleVersion": _ENGINE_STATE["paddleVersion"],
        "modelReady": bool(_ENGINE_STATE["modelReady"]),
        "engineReady": bool(_ENGINE_STATE["engineReady"]),
        "lastInitializationError": _ENGINE_STATE["lastInitializationError"],
        "apiMode": _ENGINE_STATE["apiMode"],
    }


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


def field(value: Any, confidence: float, status: str = STATUS_NEEDS_REVIEW, evidence: list[dict[str, Any]] | None = None, resolver_reason: str = "") -> dict[str, Any]:
    result = {
        "value": value,
        "confidence": confidence,
        "source": "paddleocr",
        "status": status,
        "resolverReason": resolver_reason,
    }
    if evidence is not None:
        result["evidence"] = evidence
    return result


def _bbox_union(*lines: dict[str, Any]) -> dict[str, int]:
    boxes = [line.get("box") or {} for line in lines if line]
    return {
        "x1": int(min((box.get("x1", 0) for box in boxes), default=0)),
        "y1": int(min((box.get("y1", 0) for box in boxes), default=0)),
        "x2": int(max((box.get("x2", 0) for box in boxes), default=0)),
        "y2": int(max((box.get("y2", 0) for box in boxes), default=0)),
    }


def _identity_evidence(kind: str, raw: str, normalized: str, lines: list[dict[str, Any]], anchor_relationship: str, evidence_score: float, reason: str) -> dict[str, Any]:
    confidence = min((float(line.get("confidence", 0)) for line in lines), default=0)
    return {
        "rawCandidate": raw,
        "normalizedCandidate": normalized,
        "bbox": _bbox_union(*lines),
        "confidence": confidence,
        "anchorRelationship": anchor_relationship,
        "evidenceScore": round(max(0.0, min(1.0, evidence_score)), 4),
        "resolverReason": reason,
    }


def _identity_status(confidence: float) -> str:
    return STATUS_CONFIRMED if confidence >= 0.85 else STATUS_NEEDS_REVIEW


def _eight_digit_candidates(text: str) -> list[str]:
    normalized = digits(text)
    return [match.group(0) for match in re.finditer(r"\d{8}", normalized)]


def find_invoice_no(lines: list[dict[str, Any]], image_height: int = 700) -> dict[str, Any]:
    candidates: list[dict[str, Any]] = []
    for line in lines:
        raw = str(line.get("text", ""))
        match = re.search(r"[A-Z]{2}\s*\d{8}", raw.upper())
        if not match:
            continue
        value = re.sub(r"\s+", "", match.group(0)).upper()
        confidence = float(line.get("confidence", 0))
        candidates.append({
            "value": value,
            "confidence": confidence,
            "evidence": _identity_evidence("invoice", match.group(0), value, [line], "invoice-header-complete", 0.84 + min(0.14, confidence * 0.1), "complete 2-letter + 8-digit invoice pattern in one OCR box"),
        })

    prefix_candidates = []
    number_candidates = []
    for line in lines:
        text = str(line.get("text", "")).upper().strip()
        cx, cy = line_center(line)
        if re.fullmatch(r"[A-Z]{2}", text):
            prefix_candidates.append((line, cx, cy))
        if re.fullmatch(r"\d{8}", digits(text)):
            number_candidates.append((line, cx, cy, digits(text)))
    for prefix_line, prefix_x, prefix_y in prefix_candidates:
        prefix = str(prefix_line["text"]).upper().strip()
        for number_line, number_x, number_y, number in number_candidates:
            same_row = abs(number_y - prefix_y) <= max(24, image_height * 0.05)
            in_header = prefix_y < image_height * 0.26
            if number_x > prefix_x and same_row and in_header:
                confidence = min(float(prefix_line["confidence"]), float(number_line["confidence"]))
                candidates.append({
                    "value": f"{prefix}{number}",
                    "confidence": confidence,
                    "evidence": _identity_evidence("invoice", f"{prefix} + {number}", f"{prefix}{number}", [prefix_line, number_line], "invoice-header-split-same-row", 0.70 + min(0.22, confidence * 0.12), "joined split prefix and number using same-row header geometry"),
                })

    unique: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
        value = candidate["value"]
        if value not in unique or candidate["evidence"]["evidenceScore"] > unique[value]["evidence"]["evidenceScore"]:
            unique[value] = candidate
    ordered = sorted(unique.values(), key=lambda item: (-item["evidence"]["evidenceScore"], -item["confidence"]))
    if not ordered:
        return field(None, 0, STATUS_MISSING, [], "no invoice candidate met complete/split header constraints")
    selected = ordered[0]
    return field(selected["value"], selected["confidence"], _identity_status(selected["confidence"]), [item["evidence"] for item in ordered], selected["evidence"]["resolverReason"])


def find_tax_id(lines: list[dict[str, Any]], image_height: int = 700) -> dict[str, Any]:
    buyer_label_re = re.compile(r"([統统]一編號|[統统]編|[買买]受人)(?!註記|注记)")
    seller_label_re = re.compile(r"(營業人|营业人|發票專用章|发票专用章)")
    invoice_suffixes = {
        digits(line.get("text", ""))
        for line in lines
        if re.fullmatch(r"[A-Za-z]{2}\s*\d{8}", str(line.get("text", "")))
    }
    buyer_labels = [
        line for line in lines
        if buyer_label_re.search(str(line.get("text", "")))
        and float((line.get("box") or {}).get("x1", 0)) < 0.68 * 1200
        and float((line.get("box") or {}).get("y1", 0)) < image_height * 0.40
    ]
    all_numbers = [(line, value) for line in lines for value in _eight_digit_candidates(str(line.get("text", ""))) if value not in invoice_suffixes]
    candidates: list[dict[str, Any]] = []
    for label in buyer_labels:
        label_x, label_y = line_center(label)
        inline_values = [value for value in _eight_digit_candidates(str(label.get("text", ""))) if value not in invoice_suffixes]
        for value in inline_values:
            candidates.append({
                "value": value,
                "confidence": float(label.get("confidence", 0)),
                "evidence": _identity_evidence("tax", str(label.get("text", "")), value, [label], "buyer-anchor-inline", 0.86, "buyer tax label and 8-digit value occur in one OCR box"),
            })
        for line, value in all_numbers:
            cx, cy = line_center(line)
            same_row = abs(cy - label_y) <= max(24, image_height * 0.05) and cx > label_x
            close_below = 0 < cy - label_y <= max(42, image_height * 0.065) and abs(cx - label_x) <= max(260, image_height * 0.24)
            if not (same_row or close_below):
                continue
            confidence = min(float(label.get("confidence", 0)), float(line.get("confidence", 0)))
            candidates.append({
                "value": value,
                "confidence": confidence,
                "evidence": _identity_evidence("tax", str(line.get("text", "")), value, [label, line], "buyer-anchor-same-row" if same_row else "buyer-anchor-near-below", 0.82 if same_row else 0.72, "buyer label ranked above nearest same-row/near-below numeric candidate"),
            })

    # Keep seller/stamp numbers only as rejected evidence for diagnostics; never select them as buyer tax IDs.
    for line, value in all_numbers:
        box = line.get("box") or {}
        if float(box.get("x1", 0)) >= 0.68 * 1200 or float(box.get("y1", 0)) >= image_height * 0.40:
            if seller_label_re.search(" ".join(str(item.get("text", "")) for item in lines if (item.get("box") or {}).get("x1", 0) >= 700)):
                candidates.append({
                    "value": value,
                    "confidence": float(line.get("confidence", 0)),
                    "evidence": _identity_evidence("tax", str(line.get("text", "")), value, [line], "seller-region-excluded", 0.0, "seller/stamp region candidate excluded from buyer tax resolver"),
                })

    unique: dict[tuple[str, str], dict[str, Any]] = {}
    for candidate in candidates:
        key = (candidate["value"], candidate["evidence"]["anchorRelationship"])
        if key not in unique or candidate["evidence"]["evidenceScore"] > unique[key]["evidence"]["evidenceScore"]:
            unique[key] = candidate
    ordered = sorted(unique.values(), key=lambda item: (-item["evidence"]["evidenceScore"], -item["confidence"]))
    eligible = [item for item in ordered if item["evidence"]["evidenceScore"] >= 0.70]
    if not eligible:
        reason = "buyer anchor found but no non-colliding candidate met geometry threshold" if buyer_labels else "buyer tax anchor missing; unrelated eight-digit values rejected"
        return field(None, 0, STATUS_MISSING, [item["evidence"] for item in ordered], reason)
    selected = eligible[0]
    return field(selected["value"], selected["confidence"], _identity_status(selected["confidence"]), [item["evidence"] for item in ordered], selected["evidence"]["resolverReason"])


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


def estimate_table_bands(lines: list[dict[str, Any]], header_y: float, image_width: int = 1200) -> dict[str, tuple[float, float]]:
    """Estimate column bands from the recognized table header on the corrected invoice."""
    header_lines = [line for line in lines if abs(line["box"]["y1"] - header_y) <= max(18, image_width * 0.02)]
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

    # Relative fallback for invoices where the table headers were not recognized.
    bands.setdefault("quantity", (image_width * 0.325, image_width * 0.425))
    bands.setdefault("unitPrice", (image_width * 0.425, image_width * 0.535))
    bands.setdefault("amountReference", (image_width * 0.535, image_width * 0.68))
    return bands


def in_band(cx: float, band: tuple[float, float]) -> bool:
    return band[0] <= cx <= band[1]


def _cell_evidence(line: dict[str, Any], value: int | None, column: str, relation: str) -> dict[str, Any]:
    return {
        "rawText": str(line.get("text", "")),
        "normalizedValue": value,
        "bbox": dict(line.get("box") or {}),
        "confidence": float(line.get("confidence", 0)),
        "source": "paddleocr",
        "column": column,
        "relation": relation,
    }


def _name_evidence(tokens: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "sourceTokens": [
            {
                "rawText": str(token.get("text", "")),
                "normalizedToken": str(token.get("text", "")).strip(),
                "bbox": dict(token.get("box") or {}),
                "confidence": float(token.get("confidence", 0)),
            }
            for token in tokens
        ],
        "tokenCount": len(tokens),
        "bboxUnion": _bbox_union(*tokens),
        "multilineMergeUsed": len(tokens) > 1,
        "confidence": min((float(token.get("confidence", 0)) for token in tokens), default=0),
        "reason": "row-local non-numeric tokens within name column" if tokens else "no row-local name token",
    }


def extract_items(lines: list[dict[str, Any]], image_width: int = 1200, image_height: int = 700) -> tuple[list[dict[str, Any]], list[str]]:
    header_y = None
    header_bottom = None
    lower_y = None
    for line in lines:
        text = str(line.get("text", ""))
        box = line.get("box") or {}
        y1 = float(box.get("y1", 0))
        if header_y is None and ("数量" in text or "數量" in text or "單價" in text or "单价" in text):
            header_y = y1
        if header_y is not None and y1 >= header_y:
            if abs(y1 - header_y) <= max(18, image_height * 0.03):
                header_bottom = max(header_bottom or 0, float(box.get("y2", 0)))
            if y1 > header_y and ("營業人蓋用" in text or "营业人盖用" in text or "銷售" in text or "销售" in text or "營業稅" in text or "營業税" in text):
                lower_y = y1
                break
    if header_y is None:
        return [], []
    header_bottom = header_bottom or header_y + max(20, image_height * 0.04)
    lower_y = lower_y or image_height * 0.88

    bands = estimate_table_bands(lines, header_y, image_width)
    row_start = header_y + max(8, image_height * 0.025)
    table_lines = [
        line for line in lines
        if float((line.get("box") or {}).get("y1", 0)) >= row_start
        and float((line.get("box") or {}).get("y1", 0)) <= lower_y - max(4, image_height * 0.008)
        and float((line.get("box") or {}).get("x1", 0)) < image_width * 0.82
    ]
    rows = group_rows(table_lines)
    items: list[dict[str, Any]] = []
    warnings: list[str] = []
    summary_re = re.compile(r"營業|营业|銷售|销售|稅|税|總|总|合計|合计|零税率|免税|應税|应税|統一發票|统一发票")
    for row_id, row in enumerate(rows, 1):
        name_tokens: list[dict[str, Any]] = []
        quantity = None
        unit_price = None
        quantity_evidence = None
        unit_price_evidence = None
        amount_reference = None
        confidences: list[float] = []
        row_box = _bbox_union(*row)
        for line in row:
            text = str(line.get("text", "")).strip()
            box = line.get("box") or {}
            if not text or summary_re.search(text):
                continue
            cx, _ = line_center(line)
            confidence = float(line.get("confidence", 0))
            upper = text.upper()
            value = normalized_text_number(text)
            mostly_numeric = bool(re.fullmatch(r"[\d\s,./|IlLOSOB>]+", upper))
            if not mostly_numeric and float(box.get("x1", 0)) < bands["quantity"][1]:
                trailing = re.search(r"([1-9]\d{0,2})\s*$", text)
                if trailing and float(box.get("x2", 0)) >= bands["quantity"][0]:
                    quantity = int(trailing.group(1))
                    quantity_evidence = _cell_evidence(line, quantity, "quantity", "trailing numeric token overlaps derived quantity band")
                    confidences.append(confidence)
                    prefix = text[:trailing.start()].strip()
                    if prefix:
                        name_tokens.append({"text": prefix, "box": box, "confidence": confidence})
                else:
                    name_tokens.append({"text": text, "box": box, "confidence": confidence})
            elif in_band(cx, bands["quantity"]) and value is not None and 1 <= value <= 999:
                quantity = value
                quantity_evidence = _cell_evidence(line, value, "quantity", "row-local numeric token in derived quantity band")
                confidences.append(confidence)
            elif in_band(cx, bands["unitPrice"]) and value is not None and value > 0:
                unit_price = value
                unit_price_evidence = _cell_evidence(line, value, "unitPrice", "row-local numeric token in derived unit-price band")
                confidences.append(confidence)
            elif in_band(cx, bands["amountReference"]) and value is not None and value > 0:
                amount_reference = _cell_evidence(line, value, "amountReference", "observed amount cross-check; not used as formula input")
        if quantity is None or unit_price is None:
            if quantity is not None or unit_price is not None:
                warnings.append("數量欄與單價欄筆數不一致，需人工確認")
            continue
        amount = quantity * unit_price
        if amount_reference and abs(int(amount_reference["normalizedValue"]) - amount) > max(2, round(amount * 0.02)):
            warnings.append("金額參考欄與公式不一致")
        name = " ".join(token["text"] for token in name_tokens).strip()[:80] or None
        name_evidence = _name_evidence(name_tokens)
        confidence = min(confidences) if confidences else 0.5
        items.append(
            {
                "rowId": f"row-{row_id}",
                "rowBbox": row_box,
                "rowType": "named" if name else "numeric_only",
                "name": name,
                "nameEvidence": name_evidence,
                "quantity": quantity,
                "quantityEvidence": quantity_evidence,
                "unitPrice": unit_price,
                "unitPriceEvidence": unit_price_evidence,
                "amount": amount,
                "amountReference": amount_reference,
                "cells": {
                    "name": name_evidence,
                    "quantity": quantity_evidence,
                    "unitPrice": unit_price_evidence,
                    "amountReference": amount_reference,
                },
                "confidence": confidence,
                "status": STATUS_CONFIRMED if confidence >= 0.85 else STATUS_NEEDS_REVIEW,
                "source": "paddleocr",
            }
        )
    return items[:30], warnings


def _summary_kind(text: str) -> str | None:
    value = str(text or "")
    if re.search(r"稅額|税额|營業稅|营业税|營業税|营业稅|稅金|税金|tax", value, re.I):
        return "taxAmount"
    if re.search(r"總計|总计|總額|总额|應收|应收|合計金額|合计金额|total", value, re.I):
        return "totalAmount"
    if re.search(r"銷售額|销售额|銷售|销售|小計|小计|subtotal", value, re.I):
        return "salesAmount"
    return None


def _money_candidates(text: str) -> list[tuple[str, int]]:
    candidates: list[tuple[str, int]] = []
    # Numeric-only financial scope: allow bounded OCR glyph confusions, never global text replacement.
    normalized = str(text or "").translate(str.maketrans({"O": "0", "o": "0", "I": "1", "l": "1", "|": "1", "S": "5", "s": "5", "B": "8", "Z": "2"}))
    for match in re.finditer(r"\d[\d,.]*", normalized):
        raw = match.group(0)
        value = number_value(raw)
        if value is not None and value > 0:
            candidates.append((raw, value))
    return candidates


def _financial_cell_evidence(line: dict[str, Any], value: int | None, column: str, relation: str) -> dict[str, Any]:
    return {
        "rawText": str(line.get("text", "")),
        "normalizedValue": value,
        "bbox": dict(line.get("box") or {}),
        "confidence": float(line.get("confidence", 0)),
        "source": "paddleocr",
        "column": column,
        "relation": relation,
    }


def extract_line_amounts(lines: list[dict[str, Any]], image_width: int = 1200, image_height: int = 700) -> list[dict[str, Any]]:
    """Extract printed amount-column values without requiring readable item names."""
    header_words = [line for line in lines if re.search(r"品名|數量|数量|單價|单价|金額|金额|小計|小计|amount", str(line.get("text", "")), re.I)]
    header_y = min((line_center(line)[1] for line in header_words), default=image_height * 0.30)
    bands = estimate_table_bands(lines, header_y, image_width)
    amount_band = bands["amountReference"]
    quantity_band = bands["quantity"]
    unit_price_band = bands["unitPrice"]
    summary_lines = [line for line in lines if _summary_kind(str(line.get("text", ""))) or re.search(r"營業人|营业人|專用章|专用章", str(line.get("text", "")))]
    summary_y = min((line_center(line)[1] for line in summary_lines if line_center(line)[1] > header_y), default=image_height * 0.80)
    table_lines = [line for line in lines if header_y + max(18, image_height * 0.025) < line_center(line)[1] < min(image_height * 0.88, summary_y - image_height * 0.01) and line_center(line)[0] < image_width * 0.90]
    rows = group_rows(table_lines, tolerance=max(14, min(42, round(image_height * 0.04))))
    extracted: list[dict[str, Any]] = []
    for row in rows:
        if any(_summary_kind(str(line.get("text", ""))) for line in row):
            continue
        amount_candidates: list[tuple[dict[str, Any], int]] = []
        quantity_candidates: list[tuple[dict[str, Any], int]] = []
        unit_price_candidates: list[tuple[dict[str, Any], int]] = []
        for line in row:
            cx, _ = line_center(line)
            for _, value in _money_candidates(str(line.get("text", ""))):
                if amount_band[0] <= cx <= amount_band[1] and value > 0 and value <= 100000000:
                    amount_candidates.append((line, value))
                elif quantity_band[0] <= cx <= quantity_band[1] and 1 <= value <= 999:
                    quantity_candidates.append((line, value))
                elif unit_price_band[0] <= cx <= unit_price_band[1] and 0 < value <= 10000000:
                    unit_price_candidates.append((line, value))
        if not amount_candidates:
            continue
        amount_line, amount = sorted(amount_candidates, key=lambda pair: abs(line_center(pair[0])[0] - (amount_band[0] + amount_band[1]) / 2))[0]
        quantity = quantity_candidates[0][1] if quantity_candidates else None
        unit_price = unit_price_candidates[0][1] if unit_price_candidates else None
        row_box = _bbox_union(*row)
        name_tokens = [line for line in row if not _money_candidates(str(line.get("text", ""))) and line_center(line)[0] < quantity_band[0]]
        item_name = " ".join(str(line.get("text", "")).strip() for line in name_tokens).strip()[:80]
        amount_evidence = _financial_cell_evidence(amount_line, amount, "lineAmount", "row-local numeric token in printed amount column")
        quantity_evidence = _financial_cell_evidence(quantity_candidates[0][0], quantity, "quantity", "optional row-local quantity evidence") if quantity_candidates else None
        unit_price_evidence = _financial_cell_evidence(unit_price_candidates[0][0], unit_price, "unitPrice", "optional row-local unit-price evidence") if unit_price_candidates else None
        confidence = float(amount_line.get("confidence", 0))
        extracted.append({
            "lineNo": len(extracted) + 1,
            "rowId": f"row-{len(extracted) + 1}",
            "rowBbox": row_box,
            "rowType": "named" if item_name else "numeric_only",
            "name": item_name,
            "itemName": item_name,
            "quantity": quantity,
            "unitPrice": unit_price,
            "lineAmount": amount,
            "amount": amount,
            "lineAmountEvidence": amount_evidence,
            "quantityEvidence": quantity_evidence,
            "unitPriceEvidence": unit_price_evidence,
            "evidence": {"amount": amount_evidence, "quantity": quantity_evidence, "unitPrice": unit_price_evidence, "rowBbox": row_box},
            "cells": {"amount": amount_evidence, "quantity": quantity_evidence, "unitPrice": unit_price_evidence},
            "confidence": {"lineAmount": confidence, "quantity": float(quantity_evidence.get("confidence", 0)) if quantity_evidence else 0, "unitPrice": float(unit_price_evidence.get("confidence", 0)) if unit_price_evidence else 0, "row": confidence},
            "status": STATUS_CONFIRMED if confidence >= 0.85 else STATUS_NEEDS_REVIEW,
            "source": "paddleocr"
        })
    return extracted[:30]


def extract_summary_amounts(lines: list[dict[str, Any]], image_width: int = 1200, image_height: int = 700) -> dict[str, dict[str, Any] | None]:
    """Extract summary monetary values independently from bottom labels."""
    candidates: dict[str, list[dict[str, Any]]] = {"salesAmount": [], "taxAmount": [], "totalAmount": []}
    for label in lines:
        kind = _summary_kind(str(label.get("text", "")))
        if not kind:
            continue
        label_x, label_y = line_center(label)
        for raw, value in _money_candidates(str(label.get("text", ""))):
            candidates[kind].append({"value": value, "raw": raw, "lines": [label], "relation": "summary-label-inline"})
        for line in lines:
            if line is label or _summary_kind(str(line.get("text", ""))):
                continue
            line_x, line_y = line_center(line)
            same_row = abs(line_y - label_y) <= max(24, image_height * 0.045) and line_x >= label_x - 10
            near_below = 0 < line_y - label_y <= max(60, image_height * 0.09) and abs(line_x - label_x) <= max(320, image_width * 0.30)
            if not (same_row or near_below) or line_y < image_height * 0.42:
                continue
            line_text = str(line.get("text", "")).strip()
            mostly_numeric = bool(re.fullmatch(r"[\d\s,.:>|IlLOSOB]+", line_text.upper()))
            if not mostly_numeric:
                continue
            for raw, value in _money_candidates(line_text):
                line_digits = digits(raw)
                if len(line_digits) >= 8:
                    continue
                line_center_x, line_center_y = line_center(line)
                value_column = image_width * 0.42 <= line_center_x <= image_width * 0.84
                vertical_gap = abs(line_center_y - label_y)
                close_summary_band = vertical_gap <= max(46, image_height * 0.07)
                if not (value_column and close_summary_band):
                    continue
                candidates[kind].append({"value": value, "raw": raw, "lines": [label, line], "relation": "summary-label-neighbor"})
    output: dict[str, dict[str, Any] | None] = {"salesAmount": None, "taxAmount": None, "totalAmount": None}
    for kind, values in candidates.items():
        if not values:
            output[kind] = field(None, 0, STATUS_MISSING, [], f"no {kind} label/value candidate")
            continue
        distinct = {int(value["value"]) for value in values}
        evidence = [_financial_cell_evidence(value["lines"][-1], int(value["value"]), kind, value["relation"]) for value in values]
        if len(distinct) > 1:
            output[kind] = field(None, min((float(item.get("confidence", 0)) for item in evidence), default=0), STATUS_NEEDS_REVIEW, evidence, f"conflicting {kind} candidates")
            continue
        best = sorted(values, key=lambda item: (item["relation"] != "summary-label-inline", -max((float(line.get("confidence", 0)) for line in item["lines"]), default=0)))[0]
        confidence = min((float(line.get("confidence", 0)) for line in best["lines"]), default=0)
        output[kind] = field(int(best["value"]), confidence, STATUS_CONFIRMED if confidence >= 0.85 else STATUS_NEEDS_REVIEW, evidence, "summary label and nearby monetary candidate")
    return output


def find_seller_tax_id(lines: list[dict[str, Any]], image_width: int = 1200, image_height: int = 700, buyer_tax_id: dict[str, Any] | None = None, invoice: dict[str, Any] | None = None) -> dict[str, Any]:
    """Resolve seller/vendor tax ID with seller geometry and collision exclusion."""
    buyer_value = str((buyer_tax_id or {}).get("value") or "")
    invoice_digits = digits(str((invoice or {}).get("value") or ""))[-8:]
    configured = {value for value in re.split(r"[\\s,;]+", os.environ.get("EXCLUDED_SELLER_TAX_IDS", "")) if re.fullmatch(r"\d{8}", value)}
    seller_labels = [line for line in lines if re.search(r"營業人|营业人|發票專用章|发票专用章|統一發票專用章|统一发票专用章|seller|vendor", str(line.get("text", "")), re.I)]
    candidates: list[dict[str, Any]] = []
    for line in lines:
        for value in _eight_digit_candidates(str(line.get("text", ""))):
            x, y = line_center(line)
            relation = "unanchored"
            relation_score = 0.0
            for label in seller_labels:
                lx, ly = line_center(label)
                if abs(y - ly) <= max(24, image_height * 0.045) and x >= lx - 10:
                    relation, relation_score = "seller-label-same-row", 0.42
                    break
                if 0 < y - ly <= max(70, image_height * 0.10) and abs(x - lx) <= max(300, image_width * 0.28):
                    relation, relation_score = "seller-label-nearby", 0.32
            if relation == "unanchored" and x / max(1, image_width) >= 0.58 and y / max(1, image_height) >= 0.28:
                relation, relation_score = "seller-stamp-or-footer-region", 0.16
            excluded = value in {buyer_value, invoice_digits} and value != ""
            known_bonus = 0.12 if value in configured else 0.0
            score = 0.0 if excluded else min(1.0, 0.38 + relation_score + min(0.20, float(line.get("confidence", 0)) / 100 * 0.20) + known_bonus)
            candidates.append({"rawCandidate": str(line.get("text", "")), "normalizedCandidate": value, "bbox": dict(line.get("box") or {}), "confidence": float(line.get("confidence", 0)) / 100, "anchorRelationship": "identity-collision-excluded" if excluded else relation, "evidenceScore": round(score, 4), "resolverReason": "candidate excluded because it equals buyer tax ID or invoice digits" if excluded else ("seller/vendor anchor and 8-digit candidate share a row" if relation == "seller-label-same-row" else "seller/vendor geometry candidate")})
    eligible = [candidate for candidate in candidates if candidate["evidenceScore"] >= 0.70]
    ranked = sorted(eligible, key=lambda candidate: (candidate["evidenceScore"], candidate["confidence"]), reverse=True)
    if not ranked:
        return field(None, 0, STATUS_MISSING, candidates, "seller/vendor tax anchor candidate missing or collided")
    if len(ranked) > 1 and ranked[0]["normalizedCandidate"] != ranked[1]["normalizedCandidate"] and ranked[0]["evidenceScore"] - ranked[1]["evidenceScore"] < 0.08:
        return field(None, min(ranked[0]["confidence"], ranked[1]["confidence"]), STATUS_NEEDS_REVIEW, candidates, "multiple seller tax IDs have close evidence scores")
    selected = ranked[0]
    return field(selected["normalizedCandidate"], selected["confidence"], STATUS_CONFIRMED if selected["confidence"] >= 0.80 and selected["evidenceScore"] >= 0.78 else STATUS_NEEDS_REVIEW, candidates, selected["resolverReason"])


def reconcile_financials(line_items: list[dict[str, Any]], sales_field: dict[str, Any], tax_field: dict[str, Any], total_field: dict[str, Any]) -> dict[str, Any]:
    tolerance = max(0, int(os.environ.get("FINANCIAL_MONEY_TOLERANCE", "1") or 1))
    line_values = [int(item["lineAmount"]) for item in line_items if isinstance(item.get("lineAmount"), int)]
    line_sum = sum(line_values) if line_values else None
    sales = number_value(str(sales_field.get("value"))) if sales_field.get("value") is not None else None
    tax = number_value(str(tax_field.get("value"))) if tax_field.get("value") is not None else None
    total = number_value(str(total_field.get("value"))) if total_field.get("value") is not None else None
    line_check = "UNAVAILABLE" if line_sum is None or sales is None else "PASS" if abs(line_sum - sales) <= tolerance else "MISMATCH"
    total_check = "UNAVAILABLE" if sales is None or tax is None or total is None else "PASS" if abs(sales + tax - total) <= tolerance else "MISMATCH"
    formula_checks = []
    for index, item in enumerate(line_items, 1):
        quantity, unit_price, amount = item.get("quantity"), item.get("unitPrice"), item.get("lineAmount")
        if quantity is None or unit_price is None or amount is None:
            formula_checks.append({"lineNo": index, "status": "UNAVAILABLE"})
        else:
            expected = int(quantity) * int(unit_price)
            formula_checks.append({"lineNo": index, "status": "PASS" if abs(expected - int(amount)) <= tolerance else "MISMATCH", "expected": expected, "observed": amount})
    warnings = []
    if line_check == "MISMATCH": warnings.append("line amount sum does not reconcile to sales amount")
    if total_check == "MISMATCH": warnings.append("sales amount plus tax does not reconcile to total amount")
    if any(check["status"] == "MISMATCH" for check in formula_checks): warnings.append("quantity × unit price does not reconcile to line amount")
    tax_rate = tax / sales if sales and tax is not None else None
    return {"lineSumVsSales": line_check, "salesPlusTaxVsTotal": total_check, "lineFormulaChecks": formula_checks, "taxPlausibility": "UNAVAILABLE" if tax_rate is None else "PLAUSIBLE" if 0 <= tax_rate <= 1 else "OUTLIER", "taxRate": tax_rate, "tolerance": tolerance, "warnings": warnings}


def financial_status(seller_field: dict[str, Any], line_items: list[dict[str, Any]], sales_field: dict[str, Any], tax_field: dict[str, Any], total_field: dict[str, Any], reconciliation: dict[str, Any]) -> str:
    if not seller_field.get("value") or seller_field.get("status") in {STATUS_MISSING, STATUS_INVALID}:
        return "REVIEW_REQUIRED"
    if total_field.get("value") is None or not line_items:
        return "REVIEW_REQUIRED"
    if reconciliation["lineSumVsSales"] == "MISMATCH" or reconciliation["salesPlusTaxVsTotal"] == "MISMATCH" or any(check["status"] == "MISMATCH" for check in reconciliation["lineFormulaChecks"]):
        return "REVIEW_REQUIRED"
    if sales_field.get("value") is None or tax_field.get("value") is None or reconciliation["lineSumVsSales"] == "UNAVAILABLE" or reconciliation["salesPlusTaxVsTotal"] == "UNAVAILABLE" or any(check["status"] == "UNAVAILABLE" for check in reconciliation["lineFormulaChecks"]):
        return "REVIEW_RECOMMENDED"
    if min(float(seller_field.get("confidence", 0)), float(sales_field.get("confidence", 0)), float(tax_field.get("confidence", 0)), float(total_field.get("confidence", 0))) < 0.80:
        return "REVIEW_RECOMMENDED"
    if any(item.get("quantity") is None or item.get("unitPrice") is None or not item.get("itemName") for item in line_items):
        return "REVIEW_RECOMMENDED"
    return "AUTO_OK"


def recognize_invoice(image_path: str) -> dict[str, Any]:
    image = Image.open(image_path)
    lines = run_paddleocr(image_path)
    raw_text = "\n".join(line["text"] for line in lines)
    invoice_field = find_invoice_no(lines, image.height)
    buyer_field = find_tax_id(lines, image.height)
    seller_field = find_seller_tax_id(lines, image.width, image.height, buyer_field, invoice_field)
    line_items = extract_line_amounts(lines, image.width, image.height)
    item_warnings: list[str] = []
    if not line_items:
        legacy_items, legacy_warnings = extract_items(lines, image.width, image.height)
        line_items = [{**item, "lineNo": index + 1, "lineAmount": item.get("amount"), "source": item.get("source", "paddleocr"), "status": item.get("status", STATUS_NEEDS_REVIEW)} for index, item in enumerate(legacy_items)]
        item_warnings.extend(legacy_warnings)
    summary = extract_summary_amounts(lines, image.width, image.height)
    line_sum = sum(int(item["lineAmount"]) for item in line_items if isinstance(item.get("lineAmount"), int)) if line_items else None
    sales_field = summary["salesAmount"]
    if sales_field is None or sales_field.get("value") is None:
        sales_field = field(line_sum, min((float(item.get("confidence", {}).get("lineAmount", 0)) if isinstance(item.get("confidence"), dict) else 0 for item in line_items), default=0), STATUS_CONFIRMED if line_sum is not None else STATUS_MISSING, [], "sum of observed line amounts")
    tax_field = summary["taxAmount"]
    total_field = summary["totalAmount"]
    reconciliation = reconcile_financials(line_items, sales_field, tax_field, total_field)
    financial_status_value = financial_status(seller_field, line_items, sales_field, tax_field, total_field, reconciliation)
    warnings = item_warnings + reconciliation["warnings"]
    financial = {
        "lineAmounts": [{"lineNo": item.get("lineNo"), "lineAmount": item.get("lineAmount"), "amount": item.get("amount"), "rowBbox": item.get("rowBbox"), "confidence": (item.get("confidence") or {}).get("lineAmount", 0) if isinstance(item.get("confidence"), dict) else item.get("confidence", 0), "source": item.get("source", "paddleocr"), "evidence": item.get("lineAmountEvidence") or item.get("evidence", {}).get("amount"), "status": item.get("status", STATUS_NEEDS_REVIEW)} for item in line_items],
        "salesAmount": sales_field,
        "taxAmount": tax_field,
        "totalAmount": total_field,
        "reconciliation": reconciliation,
        "status": financial_status_value
    }
    return {
        "ok": True,
        "provider": "paddleocr",
        "rawText": raw_text,
        "lines": lines,
        "fields": {
            "invoiceNo": invoice_field,
            "sellerTaxId": seller_field,
            "buyerTaxId": buyer_field,
            "taxId": buyer_field,
            "items": line_items,
            "salesAmount": sales_field,
            "taxAmount": tax_field,
            "totalAmount": total_field,
            "subtotal": sales_field,
            "tax": tax_field,
            "total": total_field,
            "financial": financial,
        },
        "financial": financial,
        "financialStatus": financial_status_value,
        "reconciliation": reconciliation,
        "warnings": warnings,
        "notices": ["PaddleOCR 僅供初步填入，仍需人工確認"],
        "debug": {"imageWidth": image.width, "imageHeight": image.height},
    }
