"""Numbered text rendering of a document's top-level blocks."""

from docx.oxml.ns import qn

from . import ooxml

TEXT_LIMIT = 240
CELL_LIMIT = 40
PREVIEW_ROWS = 3
DEFAULT_LIMIT = 80
MAX_LIMIT = 200


def _cut(text, limit):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


class _Styles:
    """Style id → display name lookups for one document, built once."""

    def __init__(self, doc):
        self.names = {}
        self.default_paragraph = None
        try:
            from docx.enum.style import WD_STYLE_TYPE

            for style in doc.styles:
                self.names[style.style_id] = style.name
            default = doc.styles.default(WD_STYLE_TYPE.PARAGRAPH)
            self.default_paragraph = default.name if default is not None else None
        except Exception:  # noqa: BLE001 - a broken styles part must not hide the text
            pass

    def name(self, element, style_type):
        holder = element.find(ooxml.PPR if style_type == "paragraph" else qn("w:tblPr"))
        node = holder.find(qn("w:pStyle") if style_type == "paragraph" else qn("w:tblStyle")) if holder is not None else None
        style_id = node.get(ooxml.VAL) if node is not None else None
        if style_id:
            return self.names.get(style_id, style_id)
        return self.default_paragraph if style_type == "paragraph" else None


def _list_level(p, doc):
    ppr = p.find(ooxml.PPR)
    numpr = ppr.find(ooxml.NUMPR) if ppr is not None else None
    if numpr is None:
        style_id = None
        if ppr is not None and ppr.find(qn("w:pStyle")) is not None:
            style_id = ppr.find(qn("w:pStyle")).get(ooxml.VAL)
        numpr = _style_numpr(doc, style_id) if style_id else None
    if numpr is None:
        return None
    num_id = numpr.find(qn("w:numId"))
    if num_id is not None and num_id.get(ooxml.VAL) == "0":
        return None
    level = numpr.find(ooxml.ILVL)
    value = level.get(ooxml.VAL) if level is not None else "0"
    return int(value) + 1 if value and value.isdigit() else 1


def _style_numpr(doc, style_id):
    try:
        styles_element = doc.styles.element
    except Exception:  # noqa: BLE001
        return None
    seen = set()
    while style_id and style_id not in seen:
        seen.add(style_id)
        style = next((s for s in styles_element.iterchildren(qn("w:style")) if s.get(qn("w:styleId")) == style_id), None)
        if style is None:
            return None
        ppr = style.find(ooxml.PPR)
        if ppr is not None and ppr.find(ooxml.NUMPR) is not None:
            return ppr.find(ooxml.NUMPR)
        based = style.find(qn("w:basedOn"))
        style_id = based.get(ooxml.VAL) if based is not None else None
    return None


def describe(element, index, doc, styles=None):
    """Structured description of one block."""
    styles = styles or _Styles(doc)
    if element.tag == ooxml.TBL:
        rows = list(element.iterchildren(ooxml.TR))
        grid = element.find(ooxml.TBL_GRID)
        cols = len(list(grid.iterchildren(ooxml.GRID_COL))) if grid is not None else 0
        cols = cols or max((len(list(row.iterchildren(ooxml.TC))) for row in rows), default=0)
        preview = [
            [_cut(ooxml.cell_text(tc), CELL_LIMIT) for tc in row.iterchildren(ooxml.TC)]
            for row in rows[:PREVIEW_ROWS]
        ]
        return {
            "i": index,
            "kind": "table",
            "style": styles.name(element, "table"),
            "rows": len(rows),
            "cols": cols,
            "preview": preview,
            "text": " / ".join(" | ".join(row) for row in preview),
        }
    if element.tag == ooxml.SDT:
        return {"i": index, "kind": "control", "style": None, "text": _cut(ooxml.text_of(element), TEXT_LIMIT)}
    text = _cut(ooxml.paragraph_text(element), TEXT_LIMIT)
    block = {"i": index, "kind": "paragraph", "style": styles.name(element, "paragraph"), "text": text}
    if ooxml.has_drawing(element):
        block["kind"] = "image"
        block["text"] = ("[image] " + text).strip()
    else:
        level = _list_level(element, doc)
        if level is not None:
            block["kind"] = "list"
            block["level"] = level
    return block


def render(block):
    """One outline line, e.g. `[3] ▦ table 5×4 (Table Grid): Дата | Подія / …`."""
    index = f"[{block['i']}]"
    kind = block["kind"]
    if kind == "table":
        style = f" ({block['style']})" if block.get("style") else ""
        return f"{index} ▦ table {block['rows']}×{block['cols']}{style}: {block['text']}"
    if kind == "control":
        return f"{index} ⧉ content control: {block['text'] or '(empty)'}"
    glyph = {"image": "🖼", "list": "•"}.get(kind, "¶")
    style = block.get("style") or "Normal"
    if kind == "list":
        style = f"{style} ({block['level']})"
    return f"{index} {glyph} {style}: {block['text'] or '(empty)'}"


def header_texts(doc):
    """Distinct non-empty header and footer texts of all sections."""
    headers, footers = [], []
    for section in doc.sections:
        for target, names in ((headers, ("header", "first_page_header", "even_page_header")),
                              (footers, ("footer", "first_page_footer", "even_page_footer"))):
            for name in names:
                try:
                    part = getattr(section, name)
                    if part.is_linked_to_previous:
                        continue
                    text = _cut(ooxml.text_of(part._element), TEXT_LIMIT)
                except Exception:  # noqa: BLE001 - a missing part has no text
                    continue
                if text and text not in target:
                    target.append(text)
    return headers, footers


def outline(doc, after=0, limit=DEFAULT_LIMIT):
    """Returns {text, blocks, total, nextAfter, headers, footers} for blocks
    `after` .. `after + limit - 1` (0-based, at most 200 per call)."""
    if not isinstance(after, int) or after < 0:
        raise ValueError("after must be a block index >= 0")
    if not isinstance(limit, int) or limit < 1:
        raise ValueError("limit must be a positive integer")
    limit = min(limit, MAX_LIMIT)
    elements = ooxml.body_blocks(doc)
    total = len(elements)
    styles = _Styles(doc)
    blocks = [
        describe(element, index, doc, styles)
        for index, element in enumerate(elements[after : after + limit], start=after)
    ]
    next_after = after + limit if after + limit < total else None
    lines = [render(block) for block in blocks]
    headers, footers = header_texts(doc)
    if after == 0:
        if headers:
            lines.append("headers: " + " · ".join(f"«{text}»" for text in headers))
        if footers:
            lines.append("footers: " + " · ".join(f"«{text}»" for text in footers))
    if next_after is not None:
        lines.append(f"… {total - next_after} more blocks; continue with after={next_after}")
    return {
        "text": "\n".join(lines),
        "blocks": blocks,
        "total": total,
        "nextAfter": next_after,
        "headers": headers,
        "footers": footers,
    }
