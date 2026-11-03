"""Low-level WordprocessingML helpers shared by the outline and edit modules."""

from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph

MC_FALLBACK = "{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback"
W14 = "http://schemas.microsoft.com/office/word/2010/wordml"

P = qn("w:p")
TBL = qn("w:tbl")
SDT = qn("w:sdt")
TR = qn("w:tr")
TC = qn("w:tc")
R = qn("w:r")
T = qn("w:t")
TAB = qn("w:tab")
BR = qn("w:br")
CR = qn("w:cr")
RPR = qn("w:rPr")
PPR = qn("w:pPr")
TCPR = qn("w:tcPr")
SECTPR = qn("w:sectPr")
NUMPR = qn("w:numPr")
ILVL = qn("w:ilvl")
VAL = qn("w:val")
GRID_COL = qn("w:gridCol")
TBL_GRID = qn("w:tblGrid")
VMERGE = qn("w:vMerge")
TRPR = qn("w:trPr")
TBL_HEADER = qn("w:tblHeader")
DOC_PR = qn("wp:docPr")
TXBX = qn("w:txbxContent")
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

BLOCK_TAGS = (P, TBL, SDT)
DRAWING_TAGS = (qn("w:drawing"), qn("w:pict"), qn("w:object"))
TRACKING_TAGS = (qn("w:ins"), qn("w:del"), qn("w:moveFrom"), qn("w:moveTo"), qn("w:rPrChange"))


def body_blocks(doc):
    """Top-level body children counted by the outline: paragraphs, tables and
    content controls, in document order (the final sectPr is skipped)."""
    return [child for child in doc.element.body.iterchildren() if child.tag in BLOCK_TAGS]


def wrap(element, parent):
    if element.tag == P:
        return Paragraph(element, parent)
    if element.tag == TBL:
        return Table(element, parent)
    return element


def element_of(target):
    for attribute in ("_p", "_tbl", "_tc", "_element"):
        element = getattr(target, attribute, None)
        if element is not None:
            return element
    return target


def in_fallback(element):
    return any(ancestor.tag == MC_FALLBACK for ancestor in element.iterancestors())


def owner_paragraph(element):
    for ancestor in element.iterancestors():
        if ancestor.tag == P:
            return ancestor
    return None


def has_drawing(element):
    return any(True for _ in element.iter(*DRAWING_TAGS))


def text_of(element):
    """Visible text of an element: runs' text, tabs as tab characters and line
    breaks as newlines. Textbox content and compatibility fallbacks are
    skipped so each text appears once."""
    parts = []
    for node in element.iter(T, TAB, BR, CR):
        if in_fallback(node) or any(ancestor.tag == TXBX for ancestor in node.iterancestors()):
            continue
        if node.tag == T:
            parts.append(node.text or "")
        elif node.tag == TAB:
            parts.append("\t")
        elif node.tag == BR and node.get(qn("w:type")) in ("page", "column"):
            parts.append(" ")
        else:
            parts.append("\n")
    return "".join(parts)


def paragraph_text(p):
    return text_of(p)


def cell_text(tc):
    return " ".join(text_of(p) for p in tc.iterchildren(P)).strip()


def strip_tracking(rpr):
    for child in list(rpr):
        if child.tag in TRACKING_TAGS:
            rpr.remove(child)
    return rpr


def strip_ids(element):
    """Removes ids that must stay unique so a copied block is not a duplicate."""
    for node in element.iter():
        for attribute in (f"{{{W14}}}paraId", f"{{{W14}}}textId"):
            if attribute in node.attrib:
                del node.attrib[attribute]
    for tag in (qn("w:bookmarkStart"), qn("w:bookmarkEnd")):
        for node in list(element.iter(tag)):
            node.getparent().remove(node)


def renumber_drawings(elements, part):
    """Gives every drawing in `elements` a document-unique wp:docPr id; Word
    reports duplicated ids as unreadable content."""
    used = set()
    for node in part.element.iter(DOC_PR):
        value = node.get("id", "")
        if value.isdigit():
            used.add(int(value))
    next_id = max(used, default=0) + 1
    for element in elements:
        for node in element.iter(DOC_PR):
            node.set("id", str(next_id))
            next_id += 1
