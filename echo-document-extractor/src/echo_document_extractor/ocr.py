from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from PIL import Image

from .models import BBox, CellEvidence, Evidence, OcrTokenEvidence, RegionEvidence, TableEvidence


@dataclass
class PaddleResult:
    evidence: list[Evidence] = field(default_factory=list)
    visual_regions: list[BBox] = field(default_factory=list)


class PaddleEvidenceProvider:
    def __init__(self, enabled: bool = True, languages: tuple[str, ...] = ("ru", "uk", "en")) -> None:
        self.enabled = enabled
        self.languages = languages
        self._ocr: dict[str, object] = {}
        self._structure: object | None = None
        if enabled:
            self._preflight()

    def _preflight(self) -> None:
        try:
            from paddleocr import PaddleOCR, PPStructureV3

            self._ocr = {
                language: PaddleOCR(
                    lang=language,
                    use_doc_orientation_classify=True,
                    use_doc_unwarping=True,
                    use_textline_orientation=True,
                )
                for language in self.languages
            }
            self._structure = PPStructureV3()
        except Exception as error:
            raise RuntimeError(
                "Paddle evidence is enabled but PP-OCRv5/PP-StructureV3 is unavailable; "
                "install the paddle extra and local models or set enable_paddle: false"
            ) from error

    def extract(self, image: Image.Image, page_id: str) -> list[Evidence]:
        return self.extract_all(image, page_id).evidence

    def extract_all(self, image: Image.Image, page_id: str) -> PaddleResult:
        if not self.enabled:
            return PaddleResult()
        array = np.asarray(image.convert("RGB"))
        tokens: list[OcrTokenEvidence] = []
        for language, recognizer in self._ocr.items():
            try:
                results = recognizer.predict(array)
            except Exception as error:
                raise RuntimeError(f"PP-OCRv5 {language} inference failed") from error
            tokens.extend(_ocr_tokens(results, page_id, language, image.size))
        merged = _merge_tokens(tokens)
        try:
            structure_results = self._structure.predict(array) if self._structure is not None else []
        except Exception as error:
            raise RuntimeError("PP-StructureV3 inference failed") from error
        regions, visual_regions = _structure_evidence(structure_results, page_id, image.size)
        return PaddleResult([*regions, *merged], visual_regions)


def _payload(item: Any) -> dict[str, Any]:
    value = getattr(item, "json", item)
    if callable(value):
        value = value()
    if not isinstance(value, dict):
        return {}
    nested = value.get("res")
    return nested if isinstance(nested, dict) else value


def _ocr_tokens(
    results: object,
    page_id: str,
    language: str,
    image_size: tuple[int, int],
) -> list[OcrTokenEvidence]:
    evidence = []
    for result_index, item in enumerate(results or []):
        data = _payload(item)
        texts = data.get("rec_texts", [])
        scores = data.get("rec_scores", [])
        boxes = data.get("rec_boxes", data.get("dt_polys", []))
        for token_index, text in enumerate(texts):
            value = str(text).strip()
            bbox = _as_bbox(boxes[token_index] if token_index < len(boxes) else None, image_size)
            if not value or bbox is None:
                continue
            confidence = float(scores[token_index]) if token_index < len(scores) else 0.0
            evidence.append(
                OcrTokenEvidence(
                    id=f"ocr-{page_id}-{language}-{result_index + 1}-{token_index + 1}",
                    source="ppocr",
                    source_family="paddle",
                    page_id=page_id,
                    text=value,
                    bbox=bbox,
                    confidence=max(0.0, min(1.0, confidence)),
                    language=language,
                    metadata={"language_support": round(_language_support(value, language), 4)},
                )
            )
    return evidence


def _structure_evidence(
    results: object,
    page_id: str,
    image_size: tuple[int, int],
) -> tuple[list[Evidence], list[BBox]]:
    evidence: list[Evidence] = []
    visual_regions: list[BBox] = []
    region_index = 0
    table_index = 0
    for item in results or []:
        data = _payload(item)
        parsing = data.get("parsing_res_list", data.get("layout_parsing_result", []))
        for block in parsing if isinstance(parsing, list) else []:
            if not isinstance(block, dict):
                continue
            bbox = _as_bbox(block.get("block_bbox", block.get("bbox", block.get("coordinate"))), image_size)
            if bbox is None:
                continue
            region_index += 1
            label = str(block.get("block_label", block.get("label", block.get("type", "text")))).casefold()
            region_type = _region_type(label)
            text = str(block.get("block_content", block.get("content", block.get("text", ""))))
            evidence.append(
                RegionEvidence(
                    id=f"structure-{page_id}-r{region_index}",
                    source="ppstructure",
                    source_family="paddle",
                    page_id=page_id,
                    text=text,
                    bbox=bbox,
                    confidence=_confidence(block),
                    region_type=region_type,
                    metadata={"parsing_order": region_index - 1, "raw_label": label},
                )
            )
            if region_type in {"figure", "photo", "map", "diagram"}:
                visual_regions.append(bbox)
        table_results = data.get("table_res_list", data.get("table_result", []))
        if isinstance(table_results, dict):
            table_results = [table_results]
        for table in table_results if isinstance(table_results, list) else []:
            if not isinstance(table, dict):
                continue
            bbox = _as_bbox(table.get("bbox", table.get("table_bbox")), image_size)
            if bbox is None:
                continue
            table_index += 1
            table_id = f"{page_id}-pt{table_index}"
            cells = table.get("cell_box_list", table.get("cells", table.get("table_cells", [])))
            cell_items = cells if isinstance(cells, list) else []
            parsed_cells = _structure_cells(cell_items, image_size)
            evidence.append(
                TableEvidence(
                    id=f"structure-{page_id}-t{table_index}",
                    source="ppstructure",
                    source_family="paddle",
                    page_id=page_id,
                    unit_id=table_id,
                    bbox=bbox,
                    confidence=_confidence(table),
                    rows=max((cell["row"] + cell["rowspan"] for cell in parsed_cells), default=0),
                    columns=max((cell["column"] + cell["colspan"] for cell in parsed_cells), default=0),
                )
            )
            for cell_index, cell in enumerate(parsed_cells):
                evidence.append(
                    CellEvidence(
                        id=f"structure-{page_id}-t{table_index}-c{cell_index + 1}",
                        source="ppstructure",
                        source_family="paddle",
                        page_id=page_id,
                        unit_id=f"{table_id}-c{cell_index + 1}",
                        text=cell["text"],
                        bbox=cell["bbox"],
                        confidence=cell["confidence"],
                        row=cell["row"],
                        column=cell["column"],
                        rowspan=cell["rowspan"],
                        colspan=cell["colspan"],
                        metadata={"table_id": table_id},
                    )
                )
    return evidence, _deduplicate_regions(visual_regions)


def _structure_cells(
    values: list[object],
    image_size: tuple[int, int],
) -> list[dict[str, object]]:
    parsed = []
    for value in values:
        data = value if isinstance(value, dict) else {"bbox": value}
        bbox = _as_bbox(data.get("bbox", data.get("box", value)), image_size)
        if bbox is None:
            continue
        parsed.append({"data": data, "bbox": bbox})
    row_positions = _cluster_positions([item["bbox"][1] for item in parsed])
    column_positions = _cluster_positions([item["bbox"][0] for item in parsed])
    result = []
    for item in parsed:
        data = item["data"]
        bbox = item["bbox"]
        row = int(data.get("row", data.get("start_row", _nearest(row_positions, bbox[1]))))
        column = int(data.get("column", data.get("start_col", _nearest(column_positions, bbox[0]))))
        rowspan = int(data.get("rowspan", int(data.get("end_row", row)) - row + 1))
        colspan = int(data.get("colspan", int(data.get("end_col", column)) - column + 1))
        result.append(
            {
                "bbox": bbox,
                "row": max(0, row),
                "column": max(0, column),
                "rowspan": max(1, rowspan),
                "colspan": max(1, colspan),
                "text": str(data.get("text", "")),
                "confidence": _confidence(data),
            }
        )
    return result


def _cluster_positions(values: list[int], tolerance: int = 8) -> list[int]:
    groups: list[list[int]] = []
    for value in sorted(values):
        if not groups or value - groups[-1][-1] > tolerance:
            groups.append([value])
        else:
            groups[-1].append(value)
    return [round(sum(group) / len(group)) for group in groups]


def _nearest(values: list[int], value: int) -> int:
    return min(range(len(values)), key=lambda index: abs(values[index] - value)) if values else 0


def _merge_tokens(tokens: list[OcrTokenEvidence]) -> list[OcrTokenEvidence]:
    groups: list[list[OcrTokenEvidence]] = []
    for token in sorted(tokens, key=lambda item: (item.bbox[1], item.bbox[0], item.language)):
        for group in groups:
            if _iou(token.bbox, group[0].bbox) >= 0.65:
                group.append(token)
                break
        else:
            groups.append([token])
    merged = []
    for index, group in enumerate(groups):
        selected = max(
            group,
            key=lambda item: item.confidence + 0.08 * _language_support(item.text, item.language),
        )
        languages = sorted({item.language for item in group})
        merged.append(
            selected.model_copy(
                update={
                    "id": re.sub(r"-[^-]+-\d+-\d+$", f"-merged-{index + 1}", selected.id),
                    "confidence": min(
                        1.0, max(item.confidence for item in group) + 0.02 * (len(languages) - 1)
                    ),
                    "metadata": {"languages": ",".join(languages), "passes": len(group)},
                }
            )
        )
    return merged


def _language_support(value: str, language: str) -> float:
    letters = [character.casefold() for character in value if character.isalpha()]
    if not letters:
        return 0.5
    unique = {
        "uk": set("іїєґ"),
        "ru": set("ыэъё"),
        "en": set("abcdefghijklmnopqrstuvwxyz"),
    }[language]
    matches = sum(character in unique for character in letters)
    if matches:
        return min(1.0, 0.7 + matches / len(letters))
    if language == "en":
        return sum("a" <= character <= "z" for character in letters) / len(letters)
    return sum("а" <= character <= "я" or character in "іїєґё" for character in letters) / len(letters)


def _as_bbox(value: object, image_size: tuple[int, int]) -> BBox | None:
    if value is None:
        return None
    try:
        array = np.asarray(value, dtype=float)
    except (TypeError, ValueError):
        return None
    if array.size < 4:
        return None
    if array.ndim >= 2:
        xs, ys = array[..., 0], array[..., 1]
        left, top, right, bottom = xs.min(), ys.min(), xs.max(), ys.max()
    else:
        left, top, right, bottom = array.flat[:4]
    width, height = image_size
    result = (
        max(0, min(width - 1, int(round(left)))),
        max(0, min(height - 1, int(round(top)))),
        max(1, min(width, int(round(right)))),
        max(1, min(height, int(round(bottom)))),
    )
    return result if result[2] > result[0] and result[3] > result[1] else None


def _confidence(value: dict[str, Any]) -> float:
    raw = value.get("score", value.get("confidence", 0.7))
    try:
        return max(0.0, min(1.0, float(raw)))
    except (TypeError, ValueError):
        return 0.7


def _region_type(label: str) -> str:
    if any(name in label for name in ("image", "figure", "photo")):
        return "photo" if "photo" in label else "figure"
    if "map" in label:
        return "map"
    if any(name in label for name in ("diagram", "chart")):
        return "diagram"
    if "table" in label:
        return "table"
    if any(name in label for name in ("title", "heading")):
        return "title"
    if "list" in label:
        return "list"
    return "text"


def _iou(first: BBox, second: BBox) -> float:
    left, top = max(first[0], second[0]), max(first[1], second[1])
    right, bottom = min(first[2], second[2]), min(first[3], second[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    first_area = (first[2] - first[0]) * (first[3] - first[1])
    second_area = (second[2] - second[0]) * (second[3] - second[1])
    union = first_area + second_area - intersection
    return intersection / union if union else 0.0


def _deduplicate_regions(regions: list[BBox]) -> list[BBox]:
    result = []
    for region in regions:
        if not any(_iou(region, prior) >= 0.9 for prior in result):
            result.append(region)
    return result
