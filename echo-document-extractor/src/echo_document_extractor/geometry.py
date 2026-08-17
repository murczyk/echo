from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np
from PIL import Image

from .models import (
    BBox,
    Cell,
    CellEvidence,
    Evidence,
    PageEvidence,
    SourceTransform,
    Table,
    TableEvidence,
    TextBlock,
    TopologyEvidence,
)


@dataclass
class GeometryResult:
    blocks: list[TextBlock | Table] = field(default_factory=list)
    evidence: list[Evidence] = field(default_factory=list)
    visual_regions: list[BBox] = field(default_factory=list)
    skew_degrees: float = 0.0


def detect_geometry(image: Image.Image, page_id: str) -> GeometryResult:
    rgb = np.asarray(image.convert("RGB"))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    skew = _estimate_skew(binary)
    working, inverse = _deskew(binary, skew)
    horizontal = _lines(working, horizontal=True)
    vertical = _lines(working, horizontal=False)
    grid = cv2.bitwise_or(horizontal, vertical)
    tables = _grid_tables(grid, page_id, inverse, image.size)
    table_boxes = [table.bbox for table in tables]
    content_boxes = _text_regions(working, inverse, image.size, table_boxes)
    visual_regions = _visual_regions(gray, rgb, table_boxes)
    raw_blocks: list[TextBlock | Table] = [*tables]
    for index, bbox in enumerate(content_boxes):
        raw_blocks.append(
            TextBlock(
                kind="paragraph",
                id=f"{page_id}-gtext-{index + 1}",
                bbox=bbox,
                reading_order=0,
            )
        )
    if not raw_blocks:
        raw_blocks.append(
            TextBlock(
                kind="paragraph",
                id=f"{page_id}-gtext-1",
                bbox=_content_bbox(binary, image.width, image.height),
                reading_order=0,
            )
        )
    ordered = _reading_order(raw_blocks, image.width)
    evidence: list[Evidence] = [
        PageEvidence(
            id=f"geometry-{page_id}",
            source="opencv",
            page_id=page_id,
            bbox=(0, 0, image.width, image.height),
            confidence=0.85 if tables else 0.55,
            transform=SourceTransform(rotation_degrees=-skew),
            metadata={"skew_degrees": round(skew, 4)},
        )
    ]
    for table in tables:
        rows = max((cell.row + cell.rowspan for cell in table.cells), default=0)
        columns = max((cell.column + cell.colspan for cell in table.cells), default=0)
        evidence.append(
            TableEvidence(
                id=f"geometry-{table.id}",
                source="opencv",
                page_id=page_id,
                unit_id=table.id,
                bbox=table.bbox,
                confidence=0.9,
                rows=rows,
                columns=columns,
            )
        )
        evidence.append(
            TopologyEvidence(
                id=f"topology-{table.id}",
                source="opencv",
                page_id=page_id,
                unit_id=table.id,
                bbox=table.bbox,
                confidence=0.9,
                row_boundaries=sorted(
                    {cell.bbox[1] for cell in table.cells} | {cell.bbox[3] for cell in table.cells}
                ),
                column_boundaries=table.column_boundaries,
            )
        )
        evidence.extend(
            CellEvidence(
                id=f"geometry-{cell.id}",
                source="opencv",
                page_id=page_id,
                unit_id=cell.id,
                bbox=cell.bbox,
                confidence=0.9,
                row=cell.row,
                column=cell.column,
                rowspan=cell.rowspan,
                colspan=cell.colspan,
            )
            for cell in table.cells
        )
    return GeometryResult(ordered, evidence, visual_regions, skew)


def _estimate_skew(binary: np.ndarray) -> float:
    edges = cv2.Canny(binary, 50, 150, apertureSize=3)
    minimum = max(30, min(binary.shape) // 5)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 720, threshold=40, minLineLength=minimum, maxLineGap=20)
    angles = []
    if lines is not None:
        for x1, y1, x2, y2 in lines[:, 0]:
            angle = float(np.degrees(np.arctan2(y2 - y1, x2 - x1)))
            while angle <= -90:
                angle += 180
            while angle > 90:
                angle -= 180
            if abs(angle) <= 15:
                angles.append(angle)
    if not angles:
        return 0.0
    angle = float(np.median(angles))
    return angle if abs(angle) >= 0.1 else 0.0


def _deskew(binary: np.ndarray, angle: float) -> tuple[np.ndarray, np.ndarray]:
    if angle == 0:
        return binary, np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    height, width = binary.shape
    matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
    deskewed = cv2.warpAffine(binary, matrix, (width, height), flags=cv2.INTER_NEAREST, borderValue=0)
    return deskewed, cv2.invertAffineTransform(matrix)


def _lines(binary: np.ndarray, horizontal: bool) -> np.ndarray:
    length = max(10, (binary.shape[1] if horizontal else binary.shape[0]) // 35)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (length, 1) if horizontal else (1, length))
    return cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel)


def _content_bbox(binary: np.ndarray, width: int, height: int) -> BBox:
    points = cv2.findNonZero(binary)
    if points is None:
        return (0, 0, width, height)
    x, y, box_width, box_height = cv2.boundingRect(points)
    return (x, y, min(width, x + max(1, box_width)), min(height, y + max(1, box_height)))


def _grid_tables(
    grid: np.ndarray,
    page_id: str,
    inverse: np.ndarray,
    source_size: tuple[int, int],
) -> list[Table]:
    contours, _ = cv2.findContours(grid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        if width >= grid.shape[1] * 0.18 and height >= grid.shape[0] * 0.04:
            boxes.append((x, y, width, height))
    tables = []
    for table_index, (x, y, width, height) in enumerate(sorted(boxes, key=lambda item: (item[1], item[0]))):
        local = grid[y : y + height, x : x + width]
        xs = _projection_boundaries(local, vertical=True)
        ys = _projection_boundaries(local, vertical=False)
        if len(xs) < 2 or len(ys) < 2:
            continue
        cells = _cells_from_boundaries(local, xs, ys, x, y, f"{page_id}-t{table_index + 1}")
        if len(cells) < 2:
            continue
        table_bbox = _map_bbox((x, y, x + width, y + height), inverse, source_size)
        mapped_cells = [
            cell.model_copy(update={"bbox": _map_bbox(cell.bbox, inverse, source_size)}) for cell in cells
        ]
        boundaries = sorted({boundary for cell in mapped_cells for boundary in (cell.bbox[0], cell.bbox[2])})
        tables.append(
            Table(
                id=f"{page_id}-t{table_index + 1}",
                bbox=table_bbox,
                reading_order=0,
                cells=mapped_cells,
                column_boundaries=boundaries,
                confidence=0.9,
            )
        )
    return tables


def _projection_boundaries(grid: np.ndarray, vertical: bool) -> list[int]:
    projection = np.count_nonzero(grid, axis=0 if vertical else 1)
    dimension = grid.shape[0] if vertical else grid.shape[1]
    candidates = np.flatnonzero(projection >= max(3, dimension * 0.28)).tolist()
    if not candidates:
        return []
    groups: list[list[int]] = [[candidates[0]]]
    for value in candidates[1:]:
        if value <= groups[-1][-1] + 2:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [round(sum(group) / len(group)) for group in groups]


def _cells_from_boundaries(
    grid: np.ndarray,
    xs: list[int],
    ys: list[int],
    offset_x: int,
    offset_y: int,
    table_id: str,
) -> list[Cell]:
    row_count, column_count = len(ys) - 1, len(xs) - 1
    parent = {(row, column): (row, column) for row in range(row_count) for column in range(column_count)}

    def find(item: tuple[int, int]) -> tuple[int, int]:
        while parent[item] != item:
            parent[item] = parent[parent[item]]
            item = parent[item]
        return item

    def union(first: tuple[int, int], second: tuple[int, int]) -> None:
        first_root, second_root = find(first), find(second)
        if first_root != second_root:
            parent[second_root] = first_root

    for row in range(row_count):
        for column in range(column_count - 1):
            boundary = xs[column + 1]
            segment = grid[ys[row] : ys[row + 1] + 1, max(0, boundary - 1) : boundary + 2]
            if np.count_nonzero(segment) < segment.shape[0] * 0.35:
                union((row, column), (row, column + 1))
    for row in range(row_count - 1):
        for column in range(column_count):
            boundary = ys[row + 1]
            segment = grid[max(0, boundary - 1) : boundary + 2, xs[column] : xs[column + 1] + 1]
            if np.count_nonzero(segment) < segment.shape[1] * 0.35:
                union((row, column), (row + 1, column))
    groups: dict[tuple[int, int], set[tuple[int, int]]] = {}
    for position in parent:
        groups.setdefault(find(position), set()).add(position)
    cells = []
    for positions in sorted(groups.values(), key=lambda value: min(value)):
        rows = [position[0] for position in positions]
        columns = [position[1] for position in positions]
        top_row, bottom_row = min(rows), max(rows)
        left_column, right_column = min(columns), max(columns)
        rectangle = {
            (row, column)
            for row in range(top_row, bottom_row + 1)
            for column in range(left_column, right_column + 1)
        }
        if positions != rectangle:
            # A non-rectangular merge cannot be represented as HTML topology.
            for row, column in sorted(positions):
                cells.append(
                    Cell(
                        id=f"{table_id}-c{len(cells) + 1}",
                        row=row,
                        column=column,
                        bbox=(
                            xs[column] + offset_x,
                            ys[row] + offset_y,
                            xs[column + 1] + offset_x,
                            ys[row + 1] + offset_y,
                        ),
                    )
                )
            continue
        cells.append(
            Cell(
                id=f"{table_id}-c{len(cells) + 1}",
                row=top_row,
                column=left_column,
                rowspan=bottom_row - top_row + 1,
                colspan=right_column - left_column + 1,
                bbox=(
                    xs[left_column] + offset_x,
                    ys[top_row] + offset_y,
                    xs[right_column + 1] + offset_x,
                    ys[bottom_row + 1] + offset_y,
                ),
            )
        )
    return cells


def _map_bbox(bbox: BBox, inverse: np.ndarray, source_size: tuple[int, int]) -> BBox:
    left, top, right, bottom = bbox
    points = np.array([[[left, top], [right, top], [right, bottom], [left, bottom]]], dtype=np.float32)
    mapped = cv2.transform(points, inverse)[0]
    width, height = source_size
    mapped_left = max(0, min(width - 1, int(np.floor(mapped[:, 0].min()))))
    mapped_top = max(0, min(height - 1, int(np.floor(mapped[:, 1].min()))))
    mapped_right = max(mapped_left + 1, min(width, int(np.ceil(mapped[:, 0].max()))))
    mapped_bottom = max(mapped_top + 1, min(height, int(np.ceil(mapped[:, 1].max()))))
    return (mapped_left, mapped_top, mapped_right, mapped_bottom)


def _text_regions(
    binary: np.ndarray,
    inverse: np.ndarray,
    source_size: tuple[int, int],
    table_boxes: list[BBox],
) -> list[BBox]:
    kernel_width = max(10, binary.shape[1] // 80)
    connected = cv2.dilate(binary, cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_width, 3)), iterations=1)
    contours, _ = cv2.findContours(connected, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    result = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        if width < 8 or height < 4 or width * height < 60:
            continue
        bbox = _map_bbox((x, y, x + width, y + height), inverse, source_size)
        if any(_coverage(bbox, table) > 0.5 for table in table_boxes):
            continue
        result.append(bbox)
    return _merge_nearby(result)


def _merge_nearby(boxes: list[BBox]) -> list[BBox]:
    result: list[BBox] = []
    for box in sorted(boxes, key=lambda item: (item[1], item[0])):
        if result and _vertical_gap(result[-1], box) <= 4 and _horizontal_overlap(result[-1], box) >= 0.6:
            prior = result.pop()
            result.append((min(prior[0], box[0]), prior[1], max(prior[2], box[2]), max(prior[3], box[3])))
        else:
            result.append(box)
    return result


def _visual_regions(gray: np.ndarray, rgb: np.ndarray, table_boxes: list[BBox]) -> list[BBox]:
    edges = cv2.Canny(gray, 80, 180)
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    contours, _ = cv2.findContours(closed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    page_area = gray.shape[0] * gray.shape[1]
    regions = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        bbox = (x, y, x + width, y + height)
        area = width * height
        if area < page_area * 0.015 or area > page_area * 0.85 or width < 40 or height < 40:
            continue
        if any(_coverage(bbox, table) > 0.8 and _coverage(table, bbox) > 0.8 for table in table_boxes):
            continue
        margin_x = max(2, round(width * 0.05))
        margin_y = max(2, round(height * 0.05))
        patch = gray[y + margin_y : y + height - margin_y, x + margin_x : x + width - margin_x]
        patch_edges = edges[
            y + margin_y : y + height - margin_y,
            x + margin_x : x + width - margin_x,
        ]
        patch_rgb = rgb[y + margin_y : y + height - margin_y, x + margin_x : x + width - margin_x]
        saturation = cv2.cvtColor(patch_rgb, cv2.COLOR_RGB2HSV)[:, :, 1]
        visual_fill = np.count_nonzero(patch < 180) / patch.size
        saturated_fill = np.count_nonzero(saturation > 40) / saturation.size
        if (
            patch.size
            and float(np.std(patch)) >= 35
            and np.count_nonzero(patch_edges) / patch.size >= 0.025
            and (visual_fill >= 0.25 or saturated_fill >= 0.05)
        ):
            regions.append(bbox)
    return _deduplicate_contained(regions)


def _reading_order(blocks: list[TextBlock | Table], page_width: int) -> list[TextBlock | Table]:
    spanning = [block for block in blocks if block.bbox[2] - block.bbox[0] >= page_width * 0.65]
    narrow = [block for block in blocks if block not in spanning]
    columns: list[list[TextBlock | Table]] = []
    for block in sorted(narrow, key=lambda item: item.bbox[0]):
        for column in columns:
            if _horizontal_overlap(column[0].bbox, block.bbox) >= 0.25:
                column.append(block)
                break
        else:
            columns.append([block])
    ordered_narrow = [
        item
        for column in columns
        for item in sorted(column, key=lambda block: (block.bbox[1], block.bbox[0]))
    ]
    ordered: list[TextBlock | Table] = []
    remaining = ordered_narrow[:]
    for wide in sorted(spanning, key=lambda item: (item.bbox[1], item.bbox[0])):
        ordered.extend(item for item in remaining if item.bbox[3] <= wide.bbox[1])
        remaining = [item for item in remaining if item not in ordered]
        ordered.append(wide)
    ordered.extend(remaining)
    return [block.model_copy(update={"reading_order": index}) for index, block in enumerate(ordered)]


def _coverage(first: BBox, second: BBox) -> float:
    left, top = max(first[0], second[0]), max(first[1], second[1])
    right, bottom = min(first[2], second[2]), min(first[3], second[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    area = (first[2] - first[0]) * (first[3] - first[1])
    return intersection / area if area else 0.0


def _horizontal_overlap(first: BBox, second: BBox) -> float:
    overlap = max(0, min(first[2], second[2]) - max(first[0], second[0]))
    width = min(first[2] - first[0], second[2] - second[0])
    return overlap / width if width else 0.0


def _vertical_gap(first: BBox, second: BBox) -> int:
    return max(0, max(first[1], second[1]) - min(first[3], second[3]))


def _deduplicate_contained(boxes: list[BBox]) -> list[BBox]:
    result = []
    for box in sorted(boxes, key=lambda item: (item[2] - item[0]) * (item[3] - item[1]), reverse=True):
        if not any(_coverage(box, prior) > 0.9 for prior in result):
            result.append(box)
    return sorted(result, key=lambda item: (item[1], item[0]))
