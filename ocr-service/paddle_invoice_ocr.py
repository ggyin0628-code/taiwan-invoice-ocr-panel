from __future__ import annotations

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


def recognize_invoice(image_path: str) -> dict[str, Any]:
    image = Image.open(image_path)
    lines = run_paddleocr(image_path)
    raw_text = "\n".join(line["text"] for line in lines)
    items, item_warnings = extract_items(lines, image.width, image.height)
    subtotal = sum(item["amount"] for item in items if isinstance(item.get("amount"), int)) if items else None
    tax = round(subtotal * 0.05) if subtotal else None
    total = subtotal + tax if subtotal and tax is not None else None
    return {
        "ok": True,
        "provider": "paddleocr",
        "rawText": raw_text,
        "lines": lines,
        "fields": {
            "invoiceNo": find_invoice_no(lines, image.height),
            "buyerTaxId": find_tax_id(lines, image.height),
            "items": items,
            "subtotal": subtotal,
            "tax": tax,
            "total": total,
        },
        "warnings": item_warnings,
        "notices": ["PaddleOCR 僅供初步填入，仍需人工確認"],
        "debug": {"imageWidth": image.width, "imageHeight": image.height},
    }
