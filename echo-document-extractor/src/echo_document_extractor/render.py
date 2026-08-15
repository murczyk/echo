from __future__ import annotations

import io
import re
from pathlib import Path

from lxml import etree, html
from openpyxl import Workbook
from openpyxl.drawing.image import Image as SpreadsheetImage
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from .canonical import table_dimensions
from .models import AssetRef, CellStyle, ExtractionResult, Table, TextBlock


def render_html(result: ExtractionResult) -> str:
    article = html.Element(
        "article",
        {
            "data-document-id": result.document.id,
            "data-status": result.status.value,
        },
    )
    for page in result.document.pages:
        section = etree.SubElement(
            article,
            "section",
            {
                "data-page-id": page.id,
                "data-source-page": str(page.instance + 1),
                "data-source-name": page.source_name,
                "data-source-sha256": page.source_sha256,
                "data-raster-sha256": page.raster_sha256,
                "data-width": str(page.width),
                "data-height": str(page.height),
                "data-rotation": str(page.rotation_degrees),
            },
        )
        for block in sorted(page.blocks, key=lambda item: item.reading_order):
            section.append(_block_element(block, page.instance + 1))
    return "<!doctype html>\n" + html.tostring(
        article,
        encoding="unicode",
        pretty_print=True,
        method="html",
    )


def _block_element(block: TextBlock | Table, page_number: int) -> html.HtmlElement:
    attributes = _provenance_attributes(
        block.id,
        page_number,
        block.bbox,
        block.confidence,
        block.decision_id,
    )
    if isinstance(block, Table):
        if block.column_boundaries:
            attributes["data-column-boundaries"] = ",".join(map(str, block.column_boundaries))
        if block.continuation_key:
            attributes["data-continuation-key"] = block.continuation_key
        table = html.Element("table", attributes)
        if block.caption is not None:
            etree.SubElement(table, "caption").text = block.caption
        rows, columns = table_dimensions(block)
        by_position = {(cell.row, cell.column): cell for cell in block.cells}
        covered: set[tuple[int, int]] = set()
        sections: dict[str, html.HtmlElement] = {}
        for row_index in range(rows):
            row_cells = [cell for cell in block.cells if cell.row == row_index]
            section_name = (
                "thead" if row_cells and all(cell.section == "thead" for cell in row_cells) else "tbody"
            )
            parent = sections.get(section_name)
            if parent is None:
                parent = etree.SubElement(table, section_name)
                sections[section_name] = parent
            row = etree.SubElement(parent, "tr")
            for column in range(columns):
                if (row_index, column) in covered or (row_index, column) not in by_position:
                    continue
                cell = by_position[(row_index, column)]
                cell_attributes = _provenance_attributes(
                    cell.id,
                    page_number,
                    cell.bbox,
                    cell.confidence,
                    cell.decision_id,
                )
                if cell.rowspan > 1:
                    cell_attributes["rowspan"] = str(cell.rowspan)
                if cell.colspan > 1:
                    cell_attributes["colspan"] = str(cell.colspan)
                style = _style_attribute(cell.style)
                if style:
                    cell_attributes["style"] = style
                element = etree.SubElement(row, "th" if cell.is_header else "td", cell_attributes)
                for target_row in range(cell.row, cell.row + cell.rowspan):
                    for target_column in range(cell.column, cell.column + cell.colspan):
                        if (target_row, target_column) != (cell.row, cell.column):
                            covered.add((target_row, target_column))
                _paragraphs(element, cell.paragraphs)
                if cell.asset:
                    etree.SubElement(
                        element,
                        "img",
                        _asset_attributes(cell.asset, "Source document image cell"),
                    )
        return table
    attributes["data-kind"] = block.kind
    attributes["data-paragraph-count"] = str(len(block.paragraphs))
    if block.kind == "heading":
        element = html.Element(f"h{block.level}", attributes)
        if block.paragraphs:
            _set_multiline_text(element, block.paragraphs[0])
        return element
    if block.kind == "list":
        element = html.Element("ol" if block.list_ordered else "ul", attributes)
        for paragraph in block.paragraphs:
            item = etree.SubElement(element, "li")
            _set_multiline_text(item, paragraph)
        return element
    if block.kind in {"figure", "unreadable"}:
        element = html.Element("figure", attributes)
        if block.asset:
            etree.SubElement(
                element,
                "img",
                _asset_attributes(block.asset, "Source document region"),
            )
        if block.paragraphs:
            caption = etree.SubElement(element, "figcaption")
            _set_multiline_text(caption, "\n\n".join(block.paragraphs))
        return element
    if len(block.paragraphs) <= 1:
        element = html.Element("p", attributes)
        if block.paragraphs:
            _set_multiline_text(element, block.paragraphs[0])
        return element
    element = html.Element("section", attributes)
    for paragraph in block.paragraphs:
        child = etree.SubElement(element, "p")
        _set_multiline_text(child, paragraph)
    return element


def _paragraphs(parent: html.HtmlElement, paragraphs: list[str]) -> None:
    for value in paragraphs:
        paragraph = etree.SubElement(parent, "p")
        _set_multiline_text(paragraph, value)


def _set_multiline_text(element: html.HtmlElement, value: str) -> None:
    lines = value.split("\n")
    element.text = lines[0]
    for line in lines[1:]:
        br = etree.SubElement(element, "br")
        br.tail = line


def _style_attribute(style: CellStyle) -> str:
    values = []
    if style.bold:
        values.append("font-weight: bold")
    if style.italic:
        values.append("font-style: italic")
    if style.alignment in {"left", "center", "right"}:
        values.append(f"text-align: {style.alignment}")
    elif style.alignment != "top":
        values.append(f"vertical-align: {style.alignment}")
    if style.font_color:
        values.append(f"color: #{style.font_color.lstrip('#').upper()}")
    if style.fill:
        values.append(f"background-color: #{style.fill.lstrip('#').upper()}")
    return "; ".join(values)


def _asset_attributes(asset: AssetRef, alt: str) -> dict[str, str]:
    return {
        "src": asset.path,
        "alt": alt,
        "data-bbox": ",".join(map(str, asset.bbox)),
    }


def _provenance_attributes(
    unit_id: str,
    page: int,
    bbox: tuple[int, int, int, int],
    confidence: float,
    decision_id: str | None,
) -> dict[str, str]:
    attributes = {
        "data-id": unit_id,
        "data-source-page": str(page),
        "data-bbox": ",".join(map(str, bbox)),
        "data-confidence": f"{confidence:.4f}",
    }
    if decision_id:
        attributes["data-decision-id"] = decision_id
    return attributes


def render_markdown(result: ExtractionResult) -> str:
    output = []
    parsed = html.fromstring(result.canonical_html)
    for section in parsed.xpath("//article/section[@data-page-id]"):
        output.append(f"## Page {section.get('data-source-page')}")
        for node in section:
            if node.tag == "table":
                output.append(html.tostring(node, encoding="unicode", method="html"))
            elif node.tag == "figure":
                image = node.xpath("./img")
                if image:
                    value = f"![Source document region]({image[0].get('src')})"
                    captions = node.xpath("./figcaption")
                    if captions:
                        value += f"\n\n{_node_text(captions[0])}"
                    output.append(value)
                else:
                    captions = node.xpath("./figcaption")
                    if captions:
                        output.append(_node_text(captions[0]))
            elif node.tag in {"ul", "ol"}:
                marker = "1." if node.tag == "ol" else "-"
                output.append("\n".join(f"{marker} {_node_text(item)}" for item in node.xpath("./li")))
            elif node.tag == "section":
                output.append("\n\n".join(_node_text(item) for item in node.xpath("./p")))
            else:
                level = int(node.tag[1]) if node.tag.startswith("h") else 0
                prefix = "#" * (level + 1) + " " if level else ""
                output.append(prefix + _node_text(node))
    return "\n\n".join(item for item in output if item)


def _node_text(node: html.HtmlElement) -> str:
    parts = []
    if node.text:
        parts.append(node.text)
    for child in node:
        if child.tag == "br":
            parts.append("\n")
        else:
            parts.append(_node_text(child))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts).strip()


def write_xlsx(result: ExtractionResult, path: Path) -> None:
    workbook = Workbook()
    workbook.remove(workbook.active)
    provenance = workbook.create_sheet("_provenance")
    provenance.append(["sheet", "range", "page", "bbox", "confidence", "decision_id", "unit_id"])
    table_number = 0
    previous: tuple[Table, object, int] | None = None
    for page in result.document.pages:
        page_tables = [block for block in page.blocks if isinstance(block, Table)]
        for table in page_tables:
            joining = bool(previous and previous[2] + 1 == page.instance and _can_join(previous[0], table))
            if joining and previous:
                sheet = previous[1]
                skip_rows = _header_rows(table)
                start_row = sheet.max_row + 1 - skip_rows
            else:
                table_number += 1
                sheet = workbook.create_sheet(f"Table {table_number}")
                start_row = 1
                skip_rows = 0
            _write_table(sheet, provenance, table, page.instance + 1, start_row, result.assets, skip_rows)
            previous = (table, sheet, page.instance)
    provenance.sheet_state = "hidden"
    workbook.save(path)


def _write_table(
    sheet: object,
    provenance: object,
    table: Table,
    page: int,
    start_row: int,
    assets: dict[str, bytes],
    skip_rows: int = 0,
) -> None:
    for cell in table.cells:
        if cell.row < skip_rows:
            row = cell.row + 1
            column = cell.column + 1
            end_row = row + cell.rowspan - 1
            end_column = column + cell.colspan - 1
            target = sheet.cell(row, column)
            cell_range = (
                target.coordinate
                if end_row == row and end_column == column
                else f"{target.coordinate}:{get_column_letter(end_column)}{end_row}"
            )
            provenance.append(
                [
                    sheet.title,
                    cell_range,
                    page,
                    ",".join(map(str, cell.bbox)),
                    cell.confidence,
                    cell.decision_id,
                    cell.id,
                ]
            )
            continue
        row = start_row + cell.row
        column = cell.column + 1
        target = sheet.cell(row, column)
        target.value = "\n\n".join(cell.paragraphs)
        target.data_type = "s"
        vertical = cell.style.alignment if cell.style.alignment in {"top", "middle", "bottom"} else "top"
        horizontal = cell.style.alignment if cell.style.alignment in {"left", "center", "right"} else None
        target.alignment = Alignment(wrap_text=True, vertical=vertical, horizontal=horizontal)
        target.font = Font(
            bold=cell.is_header or cell.style.bold,
            italic=cell.style.italic,
            color=cell.style.font_color.lstrip("#") if cell.style.font_color else None,
        )
        if cell.style.fill:
            target.fill = PatternFill("solid", fgColor=cell.style.fill.lstrip("#"))
        end_row = row + cell.rowspan - 1
        end_column = column + cell.colspan - 1
        if cell.rowspan > 1 or cell.colspan > 1:
            sheet.merge_cells(
                start_row=row,
                start_column=column,
                end_row=end_row,
                end_column=end_column,
            )
        cell_range = (
            target.coordinate
            if end_row == row and end_column == column
            else f"{target.coordinate}:{get_column_letter(end_column)}{end_row}"
        )
        provenance.append(
            [
                sheet.title,
                cell_range,
                page,
                ",".join(map(str, cell.bbox)),
                cell.confidence,
                cell.decision_id,
                cell.id,
            ]
        )
        if cell.asset and cell.asset.path in assets:
            image = SpreadsheetImage(io.BytesIO(assets[cell.asset.path]))
            sheet.add_image(image, target.coordinate)


def _can_join(first: Table, second: Table) -> bool:
    _, first_columns = table_dimensions(first)
    _, second_columns = table_dimensions(second)
    if first_columns != second_columns or not first.cells or not second.cells:
        return False
    if (first.continuation_key or second.continuation_key) and (
        not first.continuation_key or first.continuation_key != second.continuation_key
    ):
        return False
    if _normalized_caption(first.caption) != _normalized_caption(second.caption):
        return False
    first_header = _header_signature(first)
    if not first_header or first_header != _header_signature(second):
        return False
    first_boundaries = _normalized_boundaries(first)
    second_boundaries = _normalized_boundaries(second)
    if (
        not first_boundaries
        or len(first_boundaries) != len(second_boundaries)
        or any(
            abs(left - right) > 0.02 for left, right in zip(first_boundaries, second_boundaries, strict=True)
        )
    ):
        return False
    return _row_number_continuity(first, second)


def _normalized_boundaries(table: Table) -> list[float]:
    left, right = table.bbox[0], table.bbox[2]
    width = right - left
    boundaries = table.column_boundaries
    if not boundaries:
        boundaries = sorted({value for cell in table.cells for value in (cell.bbox[0], cell.bbox[2])})
    _, columns = table_dimensions(table)
    if len(boundaries) != columns + 1:
        return []
    return [round((value - left) / width, 4) for value in boundaries] if width else []


def _header_signature(table: Table) -> tuple[str, ...]:
    header_rows = set(range(_header_rows(table)))
    return tuple(
        _normalized_text("\n".join(cell.paragraphs))
        for cell in sorted(table.cells, key=lambda item: (item.row, item.column))
        if cell.row in header_rows
    )


def _header_rows(table: Table) -> int:
    rows = sorted({cell.row for cell in table.cells if cell.is_header or cell.section == "thead"})
    count = 0
    for row in rows:
        if row == count:
            count += 1
        else:
            break
    return count


def _row_number_continuity(first: Table, second: Table) -> bool:
    first_values = _first_column_numbers(first)
    second_values = _first_column_numbers(second)
    return bool(first_values and second_values and second_values[0] == first_values[-1] + 1)


def _first_column_numbers(table: Table) -> list[int]:
    values = []
    header_rows = _header_rows(table)
    for cell in sorted(table.cells, key=lambda item: item.row):
        if cell.column != 0 or cell.row < header_rows:
            continue
        match = re.fullmatch(r"\s*(\d+)\s*", "\n".join(cell.paragraphs))
        if match:
            values.append(int(match.group(1)))
    return values


def _normalized_caption(value: str | None) -> str:
    return _normalized_text(value or "")


def _normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()
