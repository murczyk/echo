from __future__ import annotations

import hashlib
from collections import defaultdict
from pathlib import PurePosixPath

from lxml import etree, html

from .models import AssetRef, BBox, Block, Cell, CellStyle, Document, Page, Table, TextBlock


def blocks_from_html(
    markup: str,
    page_id: str,
    bbox: BBox,
    decision_id: str,
    skeleton: list[Block] | None = None,
) -> list[Block]:
    root = html.fromstring(markup)
    blocks: list[Block] = []
    nodes = root.xpath(
        ".//table | .//h1 | .//h2 | .//h3 | .//h4 | .//h5 | .//h6 | .//p | .//ul | .//ol | .//figure"
    )
    nodes = [
        node
        for node in nodes
        if not any(
            parent.tag in {"table", "td", "th", "ul", "ol", "figure"} for parent in node.iterancestors()
        )
    ]
    table_skeletons = [block for block in skeleton or [] if isinstance(block, Table)]
    text_skeletons = [block for block in skeleton or [] if isinstance(block, TextBlock)]
    table_index = 0
    text_index = 0
    for order, node in enumerate(nodes):
        block_id = f"{page_id}-b{order + 1}"
        if node.tag == "table":
            table_skeleton = table_skeletons[table_index] if table_index < len(table_skeletons) else None
            blocks.append(_table(node, block_id, table_skeleton or bbox, order, decision_id))
            table_index += 1
            continue
        block_bbox = text_skeletons[text_index].bbox if text_index < len(text_skeletons) else bbox
        text_index += 1
        kind = (
            "heading"
            if node.tag.startswith("h")
            else "list"
            if node.tag in {"ul", "ol"}
            else "figure"
            if node.tag == "figure"
            else "paragraph"
        )
        if kind == "list":
            paragraphs = [_text(item) for item in node.xpath("./li")]
        elif kind == "figure":
            captions = node.xpath("./figcaption")
            caption_paragraphs = captions[0].xpath("./p") if captions else []
            paragraphs = (
                [_text(item) for item in caption_paragraphs]
                if caption_paragraphs
                else [_text(captions[0])]
                if captions
                else []
            )
        else:
            paragraphs = [_text(node)]
        blocks.append(
            TextBlock(
                kind=kind,
                id=block_id,
                bbox=block_bbox,
                reading_order=order,
                paragraphs=paragraphs,
                level=int(node.tag[1]) if kind == "heading" else None,
                list_ordered=node.tag == "ol",
                confidence=0.9,
                decision_id=decision_id,
                image_present=node.get("data-image") == "present",
            )
        )
    return blocks


def unreadable_block(page_id: str, bbox: BBox, png: bytes) -> tuple[TextBlock, dict[str, bytes]]:
    digest = hashlib.sha256(png).hexdigest()
    path = f"assets/{digest}.png"
    asset = AssetRef(sha256=digest, path=path, bbox=bbox, page_id=page_id)
    return (
        TextBlock(kind="unreadable", id=f"{page_id}-b1", bbox=bbox, reading_order=0, asset=asset),
        {path: png},
    )


def asset_for_crop(page_id: str, bbox: BBox, png: bytes) -> tuple[AssetRef, dict[str, bytes]]:
    digest = hashlib.sha256(png).hexdigest()
    path = f"assets/{digest}.png"
    return AssetRef(sha256=digest, path=path, bbox=bbox, page_id=page_id), {path: png}


def _table(
    node: html.HtmlElement,
    table_id: str,
    skeleton: Table | BBox,
    order: int,
    decision_id: str,
) -> Table:
    table_bbox = skeleton.bbox if isinstance(skeleton, Table) else skeleton
    skeleton_cells = (
        {(cell.row, cell.column): cell for cell in skeleton.cells} if isinstance(skeleton, Table) else {}
    )
    occupied: set[tuple[int, int]] = set()
    cells = []
    rows = node.xpath("./thead/tr|./tbody/tr|./tr")
    row_boundaries = (
        sorted({value for cell in skeleton.cells for value in (cell.bbox[1], cell.bbox[3])})
        if isinstance(skeleton, Table)
        else []
    )
    for row_index, row in enumerate(rows):
        section = "thead" if any(parent.tag == "thead" for parent in row.iterancestors()) else "tbody"
        column = 0
        for element in row.xpath("./th|./td"):
            while (row_index, column) in occupied:
                column += 1
            rowspan = int(element.get("rowspan", "1"))
            colspan = int(element.get("colspan", "1"))
            for target_row in range(row_index, row_index + rowspan):
                for target_column in range(column, column + colspan):
                    occupied.add((target_row, target_column))
            paragraphs = [_text(child) for child in element.xpath("./p")]
            if not paragraphs and _text(element):
                paragraphs = [_text(element)]
            skeleton_cell = skeleton_cells.get((row_index, column))
            cell_bbox = (
                skeleton_cell.bbox
                if skeleton_cell
                else _estimated_cell_bbox(
                    skeleton,
                    table_bbox,
                    row_boundaries,
                    row_index,
                    column,
                    rowspan,
                    colspan,
                    len(rows),
                )
            )
            cells.append(
                Cell(
                    id=f"{table_id}-r{row_index + 1}c{column + 1}",
                    row=row_index,
                    column=column,
                    rowspan=rowspan,
                    colspan=colspan,
                    bbox=cell_bbox,
                    paragraphs=paragraphs,
                    is_header=element.tag == "th" or section == "thead",
                    section=section,
                    style=_style(element.get("style", "")),
                    confidence=0.9,
                    decision_id=decision_id,
                    image_present=element.get("data-image") == "present",
                )
            )
            column += colspan
    caption = _text(node.xpath("./caption")[0]) if node.xpath("./caption") else None
    boundaries = skeleton.column_boundaries if isinstance(skeleton, Table) else []
    content_bbox = (
        (
            table_bbox[0] if boundaries else min(cell.bbox[0] for cell in cells),
            min(cell.bbox[1] for cell in cells),
            table_bbox[2] if boundaries else max(cell.bbox[2] for cell in cells),
            max(cell.bbox[3] for cell in cells),
        )
        if cells
        else table_bbox
    )
    return Table(
        id=table_id,
        bbox=content_bbox,
        reading_order=order,
        cells=cells,
        caption=caption,
        column_boundaries=boundaries,
        confidence=0.9,
        decision_id=decision_id,
    )


def _estimated_cell_bbox(
    skeleton: Table | BBox,
    table_bbox: BBox,
    row_boundaries: list[int],
    row: int,
    column: int,
    rowspan: int,
    colspan: int,
    row_count: int,
) -> BBox:
    if isinstance(skeleton, Table) and len(skeleton.column_boundaries) >= 2:
        columns = skeleton.column_boundaries
        left = columns[min(column, len(columns) - 2)]
        right = columns[min(column + colspan, len(columns) - 1)]
    else:
        left, right = table_bbox[0], table_bbox[2]
    if len(row_boundaries) >= 2:
        top = row_boundaries[min(row, len(row_boundaries) - 2)]
        bottom = row_boundaries[min(row + rowspan, len(row_boundaries) - 1)]
    else:
        height = max(1, table_bbox[3] - table_bbox[1])
        top = table_bbox[1] + height * row // max(1, row_count)
        bottom = table_bbox[1] + height * min(row + rowspan, row_count) // max(1, row_count)
    return (left, top, max(left + 1, right), max(top + 1, bottom))


def _style(value: str) -> CellStyle:
    declarations = {}
    for item in value.split(";"):
        if ":" in item:
            name, content = item.split(":", 1)
            declarations[name.strip().casefold()] = content.strip()
    alignment = declarations.get("vertical-align", declarations.get("text-align", "top"))
    if alignment not in {"left", "center", "right", "top", "middle", "bottom"}:
        alignment = "top"
    return CellStyle(
        bold=declarations.get("font-weight") in {"bold", "700"},
        italic=declarations.get("font-style") == "italic",
        alignment=alignment,
        font_color=declarations.get("color"),
        fill=declarations.get("background-color"),
    )


def _text(node: html.HtmlElement) -> str:
    parts = []
    if node.text:
        parts.append(node.text)
    for child in node:
        if child.tag == "br":
            parts.append("\n")
        else:
            parts.append(_text(child))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts).strip()


def table_dimensions(table: Table) -> tuple[int, int]:
    rows = max((cell.row + cell.rowspan for cell in table.cells), default=0)
    columns = max((cell.column + cell.colspan for cell in table.cells), default=0)
    return rows, columns


def table_rows(table: Table) -> dict[int, list[Cell]]:
    rows: dict[int, list[Cell]] = defaultdict(list)
    for cell in table.cells:
        rows[cell.row].append(cell)
    return rows


def parse_canonical_html(markup: str) -> Document:
    """Strictly parse canonical HTML back into the complete document IR."""
    parser = html.HTMLParser(recover=False)
    try:
        root = html.fromstring(markup, parser=parser)
    except (etree.ParserError, ValueError) as error:
        raise ValueError("invalid canonical HTML") from error
    if root.tag != "article":
        articles = root.xpath("//article[@data-document-id]")
        root = articles[0] if len(articles) == 1 else root
    if root.tag != "article" or not root.get("data-document-id"):
        raise ValueError("canonical root must be an identified article")
    if any(child.tag != "section" or child.get("data-page-id") is None for child in root):
        raise ValueError("canonical article may contain only page sections")
    pages = []
    for instance, section in enumerate(root.xpath("./section")):
        page_id = _required(section, "data-page-id")
        width = int(_required(section, "data-width"))
        height = int(_required(section, "data-height"))
        if int(_required(section, "data-source-page")) != instance + 1:
            raise ValueError("canonical source page order is not consecutive")
        blocks = [_canonical_block(node, page_id, order, instance + 1) for order, node in enumerate(section)]
        pages.append(
            Page(
                id=page_id,
                source_name=_required(section, "data-source-name"),
                source_sha256=_required(section, "data-source-sha256"),
                raster_sha256=_required(section, "data-raster-sha256"),
                instance=instance,
                width=width,
                height=height,
                rotation_degrees=int(section.get("data-rotation", "0")),
                blocks=blocks,
            )
        )
    return Document(id=_required(root, "data-document-id"), pages=pages)


def _canonical_block(
    node: html.HtmlElement,
    page_id: str,
    order: int,
    page_number: int,
) -> Block:
    if node.tag not in {
        "p",
        "section",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "ul",
        "ol",
        "table",
        "figure",
    }:
        raise ValueError(f"unsupported canonical block tag: {node.tag}")
    if int(_required(node, "data-source-page")) != page_number:
        raise ValueError("canonical block references the wrong source page")
    block_id = _required(node, "data-id")
    bbox = _parse_bbox(_required(node, "data-bbox"))
    confidence = float(_required(node, "data-confidence"))
    decision_id = node.get("data-decision-id")
    if node.tag == "table":
        occupied: set[tuple[int, int]] = set()
        cells = []
        rows = node.xpath("./thead/tr|./tbody/tr|./tr")
        for row_index, row in enumerate(rows):
            section = "thead" if any(parent.tag == "thead" for parent in row.iterancestors()) else "tbody"
            column = 0
            for element in row.xpath("./th|./td"):
                if int(_required(element, "data-source-page")) != page_number:
                    raise ValueError("canonical cell references the wrong source page")
                while (row_index, column) in occupied:
                    column += 1
                rowspan, colspan = int(element.get("rowspan", "1")), int(element.get("colspan", "1"))
                for target_row in range(row_index, row_index + rowspan):
                    for target_column in range(column, column + colspan):
                        occupied.add((target_row, target_column))
                asset = _canonical_asset(element, page_id, _parse_bbox(_required(element, "data-bbox")))
                paragraphs = [_text(paragraph) for paragraph in element.xpath("./p")]
                cells.append(
                    Cell(
                        id=_required(element, "data-id"),
                        row=row_index,
                        column=column,
                        rowspan=rowspan,
                        colspan=colspan,
                        bbox=_parse_bbox(_required(element, "data-bbox")),
                        paragraphs=paragraphs,
                        is_header=element.tag == "th",
                        section=section,
                        style=_style(element.get("style", "")),
                        confidence=float(_required(element, "data-confidence")),
                        decision_id=element.get("data-decision-id"),
                        asset=asset,
                    )
                )
                column += colspan
        caption = _text(node.xpath("./caption")[0]) if node.xpath("./caption") else None
        boundaries = [int(value) for value in node.get("data-column-boundaries", "").split(",") if value]
        return Table(
            id=block_id,
            bbox=bbox,
            reading_order=order,
            cells=cells,
            caption=caption,
            continuation_key=node.get("data-continuation-key"),
            column_boundaries=boundaries,
            confidence=confidence,
            decision_id=decision_id,
        )
    kind = node.get("data-kind")
    if kind not in {"paragraph", "heading", "list", "figure", "unreadable"}:
        kind = (
            "heading"
            if node.tag.startswith("h")
            else "list"
            if node.tag in {"ul", "ol"}
            else "figure"
            if node.tag == "figure"
            else "paragraph"
        )
    paragraph_count = int(node.get("data-paragraph-count", "0"))
    if kind == "list":
        paragraphs = [_text(item) for item in node.xpath("./li")]
    elif kind in {"figure", "unreadable"}:
        captions = node.xpath("./figcaption")
        caption_paragraphs = captions[0].xpath("./p") if captions else []
        paragraphs = (
            [_text(item) for item in caption_paragraphs]
            if caption_paragraphs
            else [_text(captions[0])]
            if captions
            else []
        )
    elif kind == "heading" and node.xpath("./span[@data-paragraph]"):
        paragraphs = [_text(item) for item in node.xpath("./span[@data-paragraph]")]
    elif node.tag == "section":
        paragraphs = [_text(item) for item in node.xpath("./p")]
    else:
        paragraphs = [_text(node)] if paragraph_count else []
    if len(paragraphs) != paragraph_count:
        raise ValueError(
            f"canonical paragraph count does not match {block_id}: "
            f"expected {paragraph_count}, parsed {len(paragraphs)}"
        )
    return TextBlock(
        kind=kind,
        id=block_id,
        bbox=bbox,
        reading_order=order,
        paragraphs=paragraphs,
        level=int(node.tag[1]) if kind == "heading" else None,
        list_ordered=node.tag == "ol",
        confidence=confidence,
        decision_id=decision_id,
        asset=_canonical_asset(node, page_id, bbox),
    )


def _canonical_asset(node: html.HtmlElement, page_id: str, bbox: BBox) -> AssetRef | None:
    images = node.xpath("./img")
    if not images:
        return None
    path = _required(images[0], "src")
    digest = PurePosixPath(path).stem
    asset_bbox = _parse_bbox(images[0].get("data-bbox", ",".join(map(str, bbox))))
    return AssetRef(sha256=digest, path=path, bbox=asset_bbox, page_id=page_id)


def _parse_bbox(value: str) -> BBox:
    parts = tuple(int(part) for part in value.split(","))
    if len(parts) != 4:
        raise ValueError("canonical bbox must contain four integers")
    return parts  # type: ignore[return-value]


def _required(node: html.HtmlElement, attribute: str) -> str:
    value = node.get(attribute)
    if value is None:
        raise ValueError(f"canonical element lacks {attribute}")
    return value


def canonical_round_trip_preserves(document: Document, markup: str) -> bool:
    parsed = parse_canonical_html(markup)
    source = document.model_copy(
        update={"pages": [page.model_copy(update={"embedded_pdf_evidence": []}) for page in document.pages]}
    )
    return _relationships(parsed.model_dump(mode="json")) == _relationships(source.model_dump(mode="json"))


def _relationships(value: object) -> object:
    if isinstance(value, dict):
        return {
            key: _relationships(item)
            for key, item in value.items()
            if key not in {"confidence", "embedded_pdf_evidence"}
        }
    if isinstance(value, list):
        return [_relationships(item) for item in value]
    return value
