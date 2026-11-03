"""Formatting-preserving edits on python-docx documents."""

import copy
import io

from docx.oxml import OxmlElement
from docx.table import Table, _Cell
from docx.text.paragraph import Paragraph

from . import ooxml

# Run children that only carry text; a run made of these (plus rPr) is text.
_TEXT_PARTS = {
    ooxml.T, ooxml.TAB, ooxml.BR, ooxml.CR, ooxml.RPR,
    ooxml.qn("w:lastRenderedPageBreak"), ooxml.qn("w:softHyphen"), ooxml.qn("w:noBreakHyphen"),
    ooxml.qn("w:sym"), ooxml.qn("w:delText"), ooxml.qn("w:fldChar"), ooxml.qn("w:instrText"),
}
# Paragraph children set_text keeps in place.
_KEPT_MARKERS = {
    ooxml.PPR, ooxml.qn("w:bookmarkStart"), ooxml.qn("w:bookmarkEnd"),
    ooxml.qn("w:commentRangeStart"), ooxml.qn("w:commentRangeEnd"),
    ooxml.qn("w:permStart"), ooxml.qn("w:permEnd"),
}


def _write_tokens(t, text):
    """Puts `text` into the w:t element `t`; newlines become line breaks and
    tabs become tab stops inside the same run."""
    pieces = []
    current = ""
    for char in text:
        if char in "\n\t":
            pieces.append(current)
            pieces.append(char)
            current = ""
        else:
            current += char
    pieces.append(current)
    t.text = pieces[0]
    t.set(ooxml.XML_SPACE, "preserve")
    anchor = t
    for piece in pieces[1:]:
        if piece == "\n":
            node = OxmlElement("w:br")
        elif piece == "\t":
            node = OxmlElement("w:tab")
        else:
            if not piece:
                continue
            node = OxmlElement("w:t")
            node.text = piece
            node.set(ooxml.XML_SPACE, "preserve")
        anchor.addnext(node)
        anchor = node


def _new_run(rpr, text):
    run = OxmlElement("w:r")
    if rpr is not None:
        run.append(ooxml.strip_tracking(copy.deepcopy(rpr)))
    t = OxmlElement("w:t")
    run.append(t)
    _write_tokens(t, text)
    return run


def _own_runs(p):
    return [r for r in p.iter(ooxml.R) if ooxml.owner_paragraph(r) is p and not ooxml.in_fallback(r)]


def _template_rpr(p):
    """Run properties for new text: the first run that has text, else the
    first run with properties, else the paragraph mark's properties."""
    runs = _own_runs(p)
    for run in runs:
        if any((t.text or "").strip() for t in run.iterchildren(ooxml.T)):
            return run.find(ooxml.RPR)
    for run in runs:
        if run.find(ooxml.RPR) is not None:
            return run.find(ooxml.RPR)
    ppr = p.find(ooxml.PPR)
    mark = ppr.find(ooxml.RPR) if ppr is not None else None
    if mark is None:
        return None
    rpr = OxmlElement("w:rPr")
    for child in mark:
        rpr.append(copy.deepcopy(child))
    return rpr


def _is_text_run(run):
    return all(child.tag in _TEXT_PARTS for child in run)


def _set_paragraph_text(p, text):
    rpr = _template_rpr(p)
    removable = []
    for child in p:
        if child.tag in _KEPT_MARKERS:
            continue
        if child.tag == ooxml.R and not _is_text_run(child):
            # A picture or other object: keep it, drop its text.
            for part in list(child):
                if part.tag in _TEXT_PARTS and part.tag != ooxml.RPR:
                    child.remove(part)
            continue
        if child.tag != ooxml.R and ooxml.has_drawing(child):
            continue
        removable.append(child)
    run = _new_run(rpr, text) if text else None
    if run is not None:
        if removable:
            removable[0].addprevious(run)
        else:
            p.append(run)
    for child in removable:
        p.remove(child)


def _cell_paragraph(cell):
    tc = cell._tc
    paragraphs = list(tc.iterchildren(ooxml.P))
    first = paragraphs[0] if paragraphs else None
    for child in list(tc):
        if child.tag == ooxml.TCPR or child is first:
            continue
        tc.remove(child)
    if first is None:
        first = OxmlElement("w:p")
        tc.append(first)
    return Paragraph(first, cell)


def set_text(target, text):
    """Replaces all text of a paragraph or a table cell, keeping its look.

    The paragraph keeps its properties (style, alignment, spacing, numbering)
    and the new text takes the formatting of the first run that had text.
    Pictures in the paragraph stay; other runs, fields and hyperlinks are
    replaced. A cell keeps only its first paragraph (other paragraphs and
    nested tables are removed). "\\n" becomes a line break and "\\t" a tab
    inside the same paragraph; use insert_paragraph_after for new paragraphs.
    """
    text = "" if text is None else str(text)
    if isinstance(target, _Cell):
        target = _cell_paragraph(target)
    if not isinstance(target, Paragraph):
        raise TypeError("set_text needs a Paragraph or a table cell; use fill_table for tables")
    _set_paragraph_text(target._p, text)
    return target


def _text_segments(p):
    """(element, text, writable) in order; tabs and breaks are read-only."""
    segments = []
    for node in p.iter(ooxml.T, ooxml.TAB, ooxml.BR, ooxml.CR):
        if ooxml.owner_paragraph(node) is not p or ooxml.in_fallback(node):
            continue
        if node.getparent().tag != ooxml.R:
            continue
        if node.tag == ooxml.T:
            segments.append((node, node.text or "", True))
        else:
            segments.append((node, "\t" if node.tag == ooxml.TAB else "\n", False))
    return segments


def _replace_in_paragraph(p, old, new):
    segments = _text_segments(p)
    joined = "".join(text for _, text, _ in segments)
    if old not in joined:
        return 0
    starts = []
    offset = 0
    for _, text, _ in segments:
        starts.append(offset)
        offset += len(text)
    matches = []
    position = joined.find(old)
    while position >= 0:
        matches.append(position)
        position = joined.find(old, position + len(old))
    count = 0
    for begin in reversed(matches):
        end = begin + len(old)
        first = max(i for i, start in enumerate(starts) if start <= begin)
        last = max(i for i, start in enumerate(starts) if start < end)
        node, _, writable = segments[first]
        if not writable:
            continue
        # A later match in the same run may already have rewritten it.
        text = node.text or ""
        head = text[: begin - starts[first]]
        if first == last:
            _write_tokens(node, head + new + text[end - starts[first]:])
        else:
            _write_tokens(node, head + new)
            for middle in range(first + 1, last):
                _clear_segment(segments[middle])
            tail_node, _, tail_writable = segments[last]
            if tail_writable:
                tail_node.text = (tail_node.text or "")[end - starts[last]:]
                tail_node.set(ooxml.XML_SPACE, "preserve")
            else:
                tail_node.getparent().remove(tail_node)
        count += 1
    return count


def _clear_segment(segment):
    node, _, writable = segment
    if writable:
        node.text = ""
    else:
        node.getparent().remove(node)


def _story_roots(doc, headers):
    roots = [doc.element.body]
    if headers:
        for part in doc.part.package.iter_parts():
            name = str(part.partname)
            if name.startswith(("/word/header", "/word/footer")) and hasattr(part, "element"):
                roots.append(part.element)
    return roots


def replace_text(doc, old, new, headers=True):
    """Replaces every occurrence of `old` with `new` and returns the count.

    Matches may span runs with different formatting; the replacement takes the
    formatting of the run where the match starts. Searches body paragraphs,
    tables, content controls and text boxes, plus headers and footers when
    `headers` is true. Matching is exact and case-sensitive, within one
    paragraph. "\\n" in `new` becomes a line break.
    """
    if not old:
        raise ValueError("old must be a non-empty string")
    new = "" if new is None else str(new)
    count = 0
    for root in _story_roots(doc, headers):
        for p in list(root.iter(ooxml.P)):
            replaced = _replace_in_paragraph(p, old, new)
            if not ooxml.in_fallback(p):
                count += replaced
    return count


def _clean_clone(p):
    clone = copy.deepcopy(p)
    for child in list(clone):
        if child.tag != ooxml.PPR:
            clone.remove(child)
    ppr = clone.find(ooxml.PPR)
    if ppr is not None:
        for sect in list(ppr.iterchildren(ooxml.SECTPR)):
            ppr.remove(sect)
    ooxml.strip_ids(clone)
    return clone


def insert_paragraph_after(anchor, text, like=None):
    """Inserts a new paragraph after `anchor` (a Paragraph or Table) and
    returns it. It copies the paragraph properties of `like` (default: the
    anchor when it is a paragraph) and the formatting of its first text run,
    but none of its content; after a table without `like` it is a plain
    "Normal" paragraph. Section breaks of `like` are not copied."""
    anchor_element = ooxml.element_of(anchor)
    if anchor_element.tag not in (ooxml.P, ooxml.TBL):
        raise TypeError("anchor must be a Paragraph or a Table")
    if like is None and isinstance(anchor, Paragraph):
        like = anchor
    if like is not None and not isinstance(like, Paragraph):
        raise TypeError("like must be a Paragraph whose formatting the new paragraph copies")
    if like is not None:
        clone = _clean_clone(like._p)
        rpr = _template_rpr(like._p)
    else:
        clone = OxmlElement("w:p")
        rpr = None
    if text:
        clone.append(_new_run(rpr, str(text)))
    anchor_element.addnext(clone)
    parent = getattr(anchor, "_parent", None) or like._parent
    return Paragraph(clone, parent)


def fill_table(table, rows, header_rows=1, template_row=None, footer_rows=0):
    """Replaces the data rows of `table` with `rows` (a list of lists).

    The first `header_rows` and the last `footer_rows` rows (e.g. totals) stay
    unchanged. Each new row is a copy of `template_row` (0-based row index,
    default: the first data row, or the last header row when there is none)
    so borders, shading, heights and fonts are
    kept; every cell gets its value via set_text. Merged cells (gridSpan) count
    once: a row needs at most as many values as the template row has cells;
    missing values leave cells empty. Returns the number of rows written.
    """
    if not isinstance(table, Table):
        raise TypeError("fill_table needs a Table, e.g. echodoc.block(doc, 3)")
    tbl = table._tbl
    existing = list(tbl.iterchildren(ooxml.TR))
    if header_rows < 0 or footer_rows < 0 or header_rows + footer_rows > len(existing):
        raise ValueError(f"the table has {len(existing)} rows; header_rows + footer_rows is too large")
    data = existing[header_rows: len(existing) - footer_rows]
    if template_row is None:
        if data:
            template = data[0]
        elif existing:
            template = existing[max(header_rows - 1, 0)]
        else:
            raise ValueError("the table has no rows to copy")
    else:
        if not 0 <= template_row < len(existing):
            raise ValueError(f"template_row must be 0..{len(existing) - 1}")
        template = existing[template_row]
    template = copy.deepcopy(template)
    cells = len(list(template.iterchildren(ooxml.TC)))
    clones = []
    for number, values in enumerate(rows):
        values = list(values) if isinstance(values, (list, tuple)) else [values]
        if len(values) > cells:
            raise ValueError(f"row {number} has {len(values)} values but the template row has {cells} cells")
        clone = copy.deepcopy(template)
        ooxml.strip_ids(clone)
        for tc in clone.iterchildren(ooxml.TC):
            tcpr = tc.find(ooxml.TCPR)
            if tcpr is not None:
                for merge in list(tcpr.iterchildren(ooxml.VMERGE)):
                    tcpr.remove(merge)
        for index, tc in enumerate(clone.iterchildren(ooxml.TC)):
            value = values[index] if index < len(values) else ""
            set_text(_Cell(tc, table), "" if value is None else value)
        clones.append(clone)
    ooxml.renumber_drawings(clones, table.part)
    for row in data:
        tbl.remove(row)
    anchor = existing[header_rows - 1] if header_rows else None
    for clone in clones:
        if anchor is None:
            first = next(tbl.iterchildren(ooxml.TR), None)
            if first is not None:
                first.addprevious(clone)
            else:
                tbl.append(clone)
        else:
            anchor.addnext(clone)
        anchor = clone
    return len(clones)


def _range(doc, start, end):
    blocks = ooxml.body_blocks(doc)
    if not (isinstance(start, int) and isinstance(end, int)) or not 0 <= start <= end < len(blocks):
        raise IndexError(f"block range {start}..{end} is outside 0..{len(blocks) - 1}")
    return blocks


def copy_blocks(doc, start, end, after):
    """Copies blocks start..end (inclusive) and inserts the copies after block
    `after` (-1 inserts them at the beginning). Returns (first, last) indices
    of the copies; indices of blocks after them shift. Bookmarks are not
    copied and pictures get fresh ids."""
    blocks = _range(doc, start, end)
    if not isinstance(after, int) or not -1 <= after < len(blocks):
        raise IndexError(f"after must be -1..{len(blocks) - 1}")
    copies = [copy.deepcopy(element) for element in blocks[start: end + 1]]
    for element in copies:
        ooxml.strip_ids(element)
    ooxml.renumber_drawings(copies, doc.part)
    if after == -1:
        anchor = blocks[0]
        for element in copies:
            anchor.addprevious(element)
    else:
        anchor = blocks[after]
        for element in copies:
            anchor.addnext(element)
            anchor = element
    first = after + 1
    return first, first + len(copies) - 1


def delete_blocks(doc, start, end):
    """Deletes blocks start..end (inclusive) and returns how many were removed.
    Deleting a paragraph that ends a section merges that section into the next.
    The body always keeps at least one paragraph."""
    blocks = _range(doc, start, end)
    body = doc.element.body
    for element in blocks[start: end + 1]:
        body.remove(element)
    if not ooxml.body_blocks(doc):
        paragraph = OxmlElement("w:p")
        sect = body.find(ooxml.SECTPR)
        if sect is not None:
            sect.addprevious(paragraph)
        else:
            body.append(paragraph)
    return end - start + 1


def figure(width_cm=16, height_cm=9):
    """Returns (fig, ax) from matplotlib with a headless backend, sized in cm."""
    import matplotlib

    matplotlib.use("Agg")
    from matplotlib import pyplot

    return pyplot.subplots(figsize=(width_cm / 2.54, height_cm / 2.54), dpi=150)


def add_chart(paragraph, fig, width_cm=16):
    """Appends the matplotlib figure `fig` to `paragraph` as an inline PNG
    picture `width_cm` wide (height keeps the aspect ratio); returns the run."""
    from docx.shared import Cm

    if not isinstance(paragraph, Paragraph):
        raise TypeError("add_chart needs a Paragraph, e.g. insert_paragraph_after(...)")
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", dpi=150, bbox_inches="tight")
    buffer.seek(0)
    run = paragraph.add_run()
    run.add_picture(buffer, width=Cm(width_cm))
    return run
