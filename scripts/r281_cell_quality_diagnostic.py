from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import time
from collections import defaultdict
from pathlib import Path
from statistics import mean, median

from PIL import Image, ImageEnhance, ImageFilter, ImageOps

DEFAULT_PROFILE = {
    "templateFamily": "taiwan-triplicate-default",
    "canonicalSize": {"width": 1200, "height": 700},
    "tableRoi": {"x": 0.10, "y": 0.35, "w": 0.78, "h": 0.43},
    "columns": {
        "itemName": {"x1": 0.00, "x2": 0.288},
        "quantity": {"x1": 0.288, "x2": 0.417},
        "unitPrice": {"x1": 0.417, "x2": 0.558},
        "amountReference": {"x1": 0.558, "x2": 0.750},
    },
}
VARIANTS = ("A_original", "B_upscale2x", "C_grayscale", "D_local_contrast", "E_threshold", "F_grid_suppressed")
FIELDS = ("itemName", "quantity", "unitPrice", "amountReference")
FAILED_FIELDS = ("itemName", "quantity", "unitPrice")


def load_json(path: Path):
    return json.loads(path.read_text())


def normalize_text(value):
    if value is None:
        return ""
    return re.sub(r"\s+", "", str(value)).strip().upper()


def normalize_number(value):
    if value is None or value == "":
        return None
    digits = re.sub(r"[^0-9]", "", str(value))
    return int(digits) if digits else None


def equal_field(field, a, b):
    return normalize_number(a) == normalize_number(b) if field in {"quantity", "unitPrice", "amountReference"} else normalize_text(a) == normalize_text(b)


def path_from(root: Path, raw):
    if not raw:
        return None
    p = Path(str(raw))
    return p if p.is_absolute() else root / p


def bbox_union(boxes):
    boxes = [b for b in boxes if isinstance(b, dict)]
    if not boxes:
        return None
    keys = ("x1", "y1", "x2", "y2")
    if not all(k in boxes[0] for k in keys):
        return None
    return {"x1": min(int(b.get("x1", 0)) for b in boxes), "y1": min(int(b.get("y1", 0)) for b in boxes), "x2": max(int(b.get("x2", 0)) for b in boxes), "y2": max(int(b.get("y2", 0)) for b in boxes)}


def find_debug(root: Path, result):
    p = path_from(root, result.get("debug"))
    return load_json(p) if p and p.exists() else {}


def available_languages():
    try:
        proc = subprocess.run(["tesseract", "--list-langs"], text=True, capture_output=True, timeout=15)
        return {line.strip() for line in proc.stdout.splitlines() if line.strip() and not line.startswith("List")}
    except Exception:
        return set()


def choose_language(field, langs):
    if field == "itemName" and "chi_tra" in langs:
        return "chi_tra+eng"
    return "eng"


def line_center(line):
    b = line.get("box") or {}
    return ((float(b.get("x1", 0)) + float(b.get("x2", 0))) / 2, (float(b.get("y1", 0)) + float(b.get("y2", 0))) / 2)


def derive_table_geometry(debug):
    roi = ((debug.get("targetedTableRecovery") or {}).get("roi") or {})
    if not roi:
        roi = {"left": 120, "top": 245, "width": 936, "height": 301, "coordinateSpace": "corrected-image", "normalizedGeometry": dict(DEFAULT_PROFILE["tableRoi"]), "selectionReason": "normalized-family-fallback"}
    left, top = int(roi.get("left", 120)), int(roi.get("top", 245))
    width, height = int(roi.get("width", 936)), int(roi.get("height", 301))
    lines = ((debug.get("paddleOcrRaw") or {}).get("lines") or [])
    header_lines = []
    for line in lines:
        text = str(line.get("text", ""))
        if any(token in text for token in ("數量", "数量", "單價", "单价", "金額", "金额")):
            cx, cy = line_center(line)
            if top - 30 <= cy <= top + height * 0.35:
                header_lines.append(line)
    bands = {}
    if header_lines:
        header_y = min(line.get("box", {}).get("y1", top) for line in header_lines)
        for line in header_lines:
            text = str(line.get("text", ""))
            cx, _ = line_center(line)
            if "數量" in text or "数量" in text:
                if any(token in text for token in ("單價", "单价", "金")):
                    bands["quantity"] = (cx - 128, cx - 32)
                    bands["unitPrice"] = (cx - 23, cx + 93)
                    bands["amountReference"] = (cx + 100, cx + 250)
                else:
                    bands["quantity"] = (cx - 48, cx + 48)
            if "單價" in text or "单价" in text:
                bands.setdefault("unitPrice", (cx - 58, cx + 58))
            if "金額" in text or "金额" in text:
                bands["amountReference"] = (cx - 75, cx + 75)
    else:
        header_y = top + height * 0.16
    default = {
        "quantity": (left + width * DEFAULT_PROFILE["columns"]["quantity"]["x1"], left + width * DEFAULT_PROFILE["columns"]["quantity"]["x2"]),
        "unitPrice": (left + width * DEFAULT_PROFILE["columns"]["unitPrice"]["x1"], left + width * DEFAULT_PROFILE["columns"]["unitPrice"]["x2"]),
        "amountReference": (left + width * DEFAULT_PROFILE["columns"]["amountReference"]["x1"], left + width * DEFAULT_PROFILE["columns"]["amountReference"]["x2"]),
    }
    for key, value in default.items():
        bands.setdefault(key, value)
    q1, q2 = bands["quantity"]
    u1, u2 = bands["unitPrice"]
    a1, a2 = bands["amountReference"]
    columns = {
        "itemName": (left, q1),
        "quantity": (q1, q2),
        "unitPrice": (u1, u2),
        "amountReference": (a1, min(left + width, max(a2, left + width * 0.75))),
    }
    norm_columns = {k: {"x1": round((x1-left)/width, 5), "x2": round((x2-left)/width, 5)} for k, (x1, x2) in columns.items()}
    return {"roi": {"left": left, "top": top, "width": width, "height": height, "normalizedGeometry": roi.get("normalizedGeometry", dict(DEFAULT_PROFILE["tableRoi"]))}, "columns": columns, "normalizedColumns": norm_columns, "headerY": header_y, "headerMethod": "detected-header" if header_lines else "normalized-family-fallback"}


def cluster_centers(values, tolerance=34):
    clusters = []
    for y in sorted(values):
        if not clusters or abs(y - mean(clusters[-1])) > tolerance:
            clusters.append([y])
        else:
            clusters[-1].append(y)
    return [mean(c) for c in clusters]


def derive_row_bands(debug, geometry, expected_count):
    roi = geometry["roi"]
    top, bottom = roi["top"], roi["top"] + roi["height"]
    lines = ((debug.get("paddleOcrRaw") or {}).get("lines") or [])
    header_y = geometry["headerY"]
    ys = []
    for line in lines:
        _, cy = line_center(line)
        if header_y + 18 <= cy <= bottom - 8:
            ys.append(cy)
    centers = cluster_centers(ys)
    if len(centers) > expected_count:
        centers = centers[:expected_count]
    data_top = max(top + 28, header_y + 20)
    data_bottom = bottom - 10
    if len(centers) != expected_count:
        step = (data_bottom - data_top) / max(expected_count, 1)
        centers = [data_top + step * (i + 0.5) for i in range(expected_count)]
        method = "normalized-row-fallback"
    else:
        method = "ocr-row-centers"
    boundaries = []
    for i, center in enumerate(centers):
        upper = data_top if i == 0 else (centers[i - 1] + center) / 2
        lower = data_bottom if i == len(centers) - 1 else (center + centers[i + 1]) / 2
        boundaries.append({"rowOrdinal": i + 1, "center": round(center, 2), "top": round(max(data_top, upper), 2), "bottom": round(min(data_bottom, lower), 2), "method": method})
    return boundaries


def grid_suppress(image):
    gray = image.convert("L")
    pix = gray.load()
    w, h = gray.size
    out = image.convert("RGB")
    out_pix = out.load()
    dark_limit = 155
    for y in range(h):
        dark = sum(1 for x in range(w) if pix[x, y] < dark_limit)
        if dark >= max(8, int(w * 0.45)):
            for x in range(w): out_pix[x, y] = (255, 255, 255)
    for x in range(w):
        dark = sum(1 for y in range(h) if pix[x, y] < dark_limit)
        if dark >= max(8, int(h * 0.65)):
            for y in range(h): out_pix[x, y] = (255, 255, 255)
    return out


def make_variants(crop):
    original = crop.convert("RGB")
    gray = ImageOps.grayscale(original)
    upscale = original.resize((max(1, original.width * 2), max(1, original.height * 2)), Image.Resampling.LANCZOS)
    contrast = ImageEnhance.Contrast(gray).enhance(1.55)
    threshold = contrast.point(lambda p: 255 if p >= 175 else 0)
    return {
        "A_original": original,
        "B_upscale2x": upscale,
        "C_grayscale": gray,
        "D_local_contrast": contrast,
        "E_threshold": threshold,
        "F_grid_suppressed": grid_suppress(original),
    }


def run_tesseract(image_path, field, language, whitelist):
    if shutil.which("tesseract") is None:
        return {"usable": False, "recoverable": False, "confidence": 0.0, "latencyMs": 0.0, "tokenCount": 0, "charCount": 0, "coverage": 0.0, "text": "", "errorType": "tesseract_missing"}
    config = ["--psm", "7"]
    if whitelist:
        config += ["-c", f"tessedit_char_whitelist={whitelist}"]
    started = time.perf_counter()
    try:
        proc = subprocess.run(["tesseract", str(image_path), "stdout", "-l", language, *config], text=True, capture_output=True, timeout=30)
        latency = (time.perf_counter() - started) * 1000
        text = re.sub(r"\s+", "", proc.stdout or "")
        usable = bool(text) and (bool(re.search(r"[A-Za-z0-9\u3400-\u9fff]", text)))
        if field in {"quantity", "unitPrice"}:
            usable = usable and bool(re.search(r"\d", text))
        return {"usable": usable, "recoverable": False, "confidence": None, "latencyMs": round(latency, 3), "tokenCount": 1 if usable else 0, "charCount": len(text), "coverage": len(text), "text": text, "errorType": None if proc.returncode == 0 else "tesseract_nonzero"}
    except subprocess.TimeoutExpired:
        return {"usable": False, "recoverable": False, "confidence": 0.0, "latencyMs": 30000.0, "tokenCount": 0, "charCount": 0, "coverage": 0.0, "text": "", "errorType": "tesseract_timeout"}


def classify_human_placeholder():
    return "PENDING_MANUAL_CLASSIFICATION"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--artifact", default=os.getenv("R281_BENCHMARK_ARTIFACT"))
    parser.add_argument("--document-gt", default=os.getenv("R281_DOCUMENT_GT"))
    parser.add_argument("--grouping", default=os.getenv("R281_GROUPING"))
    parser.add_argument("--root", default=os.getenv("R281_REPO_ROOT", str(Path(__file__).resolve().parents[1])))
    parser.add_argument("--private-output", default=os.getenv("R281_PRIVATE_OUTPUT", ""))
    parser.add_argument("--sanitized-output", default=os.getenv("R281_SANITIZED_OUTPUT", ""))
    parser.add_argument("--crop-root", default=os.getenv("R281_CROP_ROOT", ""))
    args = parser.parse_args()
    if args.self_test:
        assert DEFAULT_PROFILE["tableRoi"]["x"] == 0.10
        assert set(VARIANTS) == {"A_original", "B_upscale2x", "C_grayscale", "D_local_contrast", "E_threshold", "F_grid_suppressed"}
        img = Image.new("RGB", (40, 20), "white")
        assert make_variants(img)["B_upscale2x"].size == (80, 40)
        assert len(derive_row_bands({"paddleOcrRaw": {"lines": []}}, {"roi": {"top": 10, "height": 80}, "headerY": 20}, 2)) == 2
        print("r281_cell_quality_self_test=PASS")
        return
    required = {"artifact": args.artifact, "document_gt": args.document_gt, "grouping": args.grouping, "private_output": args.private_output, "sanitized_output": args.sanitized_output, "crop_root": args.crop_root}
    missing = [k for k, v in required.items() if not v]
    if missing:
        raise SystemExit("missing required diagnostic paths: " + ",".join(missing))
    root = Path(args.root)
    artifact = load_json(Path(args.artifact))
    document_gt = load_json(Path(args.document_gt))
    grouping = load_json(Path(args.grouping))
    crop_root = Path(args.crop_root)
    crop_root.mkdir(parents=True, exist_ok=True)
    results = sorted(artifact.get("results", []), key=lambda x: str(x.get("filename", "")))
    sample_by_name = {r.get("filename"): i + 1 for i, r in enumerate(results)}
    doc_results = {d.get("documentId"): d for d in artifact.get("documentResults", [])}
    gt_docs = document_gt.get("documents", document_gt if isinstance(document_gt, list) else [])
    grouping_docs = grouping.get("documents", grouping if isinstance(grouping, list) else [])
    grouping_by_id = {d.get("documentId"): d for d in grouping_docs if isinstance(d, dict)}
    langs = available_languages()
    private_cells = []
    sanitized_cells = []
    template_families = defaultdict(int)
    geometry_records = []
    doc_summary = []
    for doc_index, gt_doc in enumerate(gt_docs, 1):
        doc_id = gt_doc.get("documentId", f"document-{doc_index:02d}")
        observed = doc_results.get(doc_id, {})
        expected_items = observed.get("expected", {}).get("items") or gt_doc.get("expectedLineItems") or gt_doc.get("items") or []
        predicted_items = observed.get("predicted", {}).get("items") or []
        source_ids = gt_doc.get("sourceImageIds") or grouping_by_id.get(doc_id, {}).get("sourceImageIds") or []
        # The existing document comparator aligns the first available structural row to each expected ordinal.
        failures = []
        for row_index, expected in enumerate(expected_items):
            predicted = predicted_items[row_index] if row_index < len(predicted_items) else {}
            for field in FAILED_FIELDS:
                expected_value = expected.get(field)
                predicted_value = predicted.get(field)
                if not equal_field(field, expected_value, predicted_value):
                    failures.append({"rowOrdinal": row_index + 1, "field": field, "expected": expected_value, "predicted": predicted_value})
        # Keep field failures conservative and complete for missing rows.
        doc_summary.append({"documentOrdinal": doc_index, "documentId": doc_id, "expectedRowCount": len(expected_items), "predictedRowCount": len(predicted_items), "failedCellCount": len(failures), "sourceImageCount": len(source_ids)})
        for source_id in source_ids:
            sample_index = sample_by_name.get(source_id)
            result = results[sample_index - 1] if sample_index else {}
            debug = find_debug(root, result)
            geometry = derive_table_geometry(debug)
            template_id = ((debug.get("templateDetection") or {}).get("template") or {}).get("templateId") or DEFAULT_PROFILE["templateFamily"]
            template_families[template_id] += 1
            row_bands = derive_row_bands(debug, geometry, len(expected_items))
            corrected = path_from(root, debug.get("correctedImagePath")) or path_from(root, debug.get("originalImagePath"))
            if not corrected or not corrected.exists():
                continue
            with Image.open(corrected) as opened:
                image = ImageOps.exif_transpose(opened).convert("RGB")
                geometry_records.append({"sample": sample_index, "documentOrdinal": doc_index, "templateId": template_id, "roi": geometry["roi"]["normalizedGeometry"], "columns": geometry["normalizedColumns"], "headerMethod": geometry["headerMethod"], "rowMethod": row_bands[0]["method"] if row_bands else "none", "rowCount": len(row_bands)})
                for failure in failures:
                    row_index = failure["rowOrdinal"] - 1
                    if row_index >= len(row_bands):
                        continue
                    field = failure["field"]
                    x1, x2 = geometry["columns"][field]
                    row = row_bands[row_index]
                    y1, y2 = row["top"], row["bottom"]
                    pad = 3
                    box = (max(0, int(math.floor(x1 + pad))), max(0, int(math.floor(y1 + pad))), min(image.width, int(math.ceil(x2 - pad))), min(image.height, int(math.ceil(y2 - pad))))
                    if box[2] <= box[0] or box[3] <= box[1]:
                        continue
                    cell_id = f"document-{doc_index:02d}_row-{failure['rowOrdinal']:02d}_{field}_sample-{sample_index:02d}"
                    cell_dir = crop_root / cell_id
                    cell_dir.mkdir(parents=True, exist_ok=True)
                    crop = image.crop(box)
                    variants = make_variants(crop)
                    private_variant_records = []
                    language = choose_language(field, langs)
                    whitelist = "0123456789,./" if field in {"quantity", "unitPrice"} else None
                    for variant_name, variant_image in variants.items():
                        path = cell_dir / f"{variant_name}.png"
                        variant_image.save(path)
                        record = run_tesseract(path, field, language, whitelist)
                        record["variant"] = variant_name
                        record["path"] = str(path)
                        record["language"] = language
                        record["expected"] = failure["expected"]
                        record["recoverable"] = equal_field(field, failure["expected"], record.get("text"))
                        private_variant_records.append(record)
                    private_cells.append({
                        "cellId": cell_id,
                        "documentOrdinal": doc_index,
                        "sample": sample_index,
                        "rowOrdinal": failure["rowOrdinal"],
                        "field": field,
                        "expected": failure["expected"],
                        "predicted": failure["predicted"],
                        "bbox": {"x1": box[0], "y1": box[1], "x2": box[2], "y2": box[3]},
                        "coordinateSpace": "corrected-image",
                        "templateId": template_id,
                        "humanClass": classify_human_placeholder(),
                        "visibleDefects": [],
                        "variants": private_variant_records,
                    })
                    sanitized_cells.append({
                        "documentOrdinal": doc_index,
                        "sample": sample_index,
                        "rowOrdinal": failure["rowOrdinal"],
                        "field": field,
                        "humanClass": classify_human_placeholder(),
                        "variantCount": len(private_variant_records),
                        "recoverableVariantCount": sum(1 for x in private_variant_records if x["recoverable"]),
                        "usableVariantCount": sum(1 for x in private_variant_records if x["usable"]),
                        "variantStats": [
                            {"variant": x["variant"], "usable": bool(x["usable"]), "recoverable": bool(x["recoverable"]), "latencyMs": x["latencyMs"], "tokenCount": x["tokenCount"], "charCount": x["charCount"]}
                            for x in private_variant_records
                        ],
                    })
    # Aggregate only counts and timing; raw text, expected values, filenames and paths stay private.
    by_field_variant = defaultdict(list)
    for cell in private_cells:
        for item in cell["variants"]:
            by_field_variant[(cell["field"], item["variant"])].append(item)
    variant_summary = []
    for (field, variant), items in sorted(by_field_variant.items()):
        latencies = [float(x["latencyMs"]) for x in items if x.get("latencyMs") is not None]
        variant_summary.append({"field": field, "variant": variant, "attemptedCells": len(items), "usableCount": sum(bool(x.get("usable")) for x in items), "recoverableCount": sum(bool(x.get("recoverable")) for x in items), "averageLatencyMs": round(mean(latencies), 3) if latencies else None, "medianLatencyMs": round(median(latencies), 3) if latencies else None, "averageCharCount": round(mean([int(x.get("charCount", 0)) for x in items]), 3) if items else 0})
    norm_rois = [tuple(sorted((float(v) for v in rec["roi"].values()))) for rec in geometry_records if rec.get("roi")]
    consistency = 1.0
    if len(norm_rois) > 1:
        diffs = []
        anchor = norm_rois[0]
        for other in norm_rois[1:]:
            diffs.append(sum(abs(a-b) for a,b in zip(anchor, other)) / max(1, len(anchor)))
        consistency = round(max(0.0, 1.0 - mean(diffs)), 5)
    private_output = {
        "schemaVersion": "r2.8.1-cell-quality-private-v1",
        "templateProfile": DEFAULT_PROFILE,
        "availableTesseractLanguages": sorted(langs),
        "documents": doc_summary,
        "geometry": geometry_records,
        "cells": private_cells,
    }
    sanitized = {
        "schemaVersion": "r2.8.1-cell-quality-sanitized-v1",
        "boundary": {"images": len(results), "documents": len(gt_docs), "canonicalRows": sum(len(d.get("expectedLineItems") or d.get("items") or []) for d in gt_docs)},
        "templateFamilies": {"count": len(template_families), "observationsByFamily": dict(template_families), "geometryConsistencyScore": consistency},
        "documents": [{k: v for k, v in d.items() if k != "documentId"} for d in doc_summary],
        "geometry": [{k: v for k, v in rec.items() if k not in {"sample", "documentOrdinal"}} for rec in geometry_records],
        "failedCells": {"total": len(sanitized_cells), "byField": {field: sum(1 for x in sanitized_cells if x["field"] == field) for field in FAILED_FIELDS}, "byHumanClass": {"PENDING_MANUAL_CLASSIFICATION": len(sanitized_cells)}, "cells": sanitized_cells},
        "variantSummary": variant_summary,
        "diagnosticCalls": {"targetedCellCount": len(private_cells), "variantCalls": len(private_cells) * len(VARIANTS), "productionPaddleCallsAdded": 0},
    }
    Path(args.private_output).write_text(json.dumps(private_output, ensure_ascii=False, indent=2) + "\n")
    Path(args.sanitized_output).write_text(json.dumps(sanitized, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": "PASS", "documents": len(gt_docs), "canonicalRows": sanitized["boundary"]["canonicalRows"], "failedCells": sanitized["failedCells"]["total"], "byField": sanitized["failedCells"]["byField"], "templateFamilyCount": sanitized["templateFamilies"]["count"], "cellVariantCalls": sanitized["diagnosticCalls"]["variantCalls"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
