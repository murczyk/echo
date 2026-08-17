from __future__ import annotations

import re
from dataclasses import dataclass

from .models import BBox, Cell, Document, Page, Table, TextBlock

NUMBERED_UNIT_PATTERN = re.compile(
    r"(?<!\w)(?P<number>\d{1,4})\s+(?P<token>[^\W\d_]{2,6})(?!\w)",
    re.UNICODE,
)
CYRILLIC_ABBREVIATION_PATTERN = re.compile(r"^[а-яіїєґ]{2,6}$", re.IGNORECASE)
UNIT_CONFUSABLES = str.maketrans(
    {
        "a": "а",
        "b": "в",
        "c": "с",
        "d": "д",
        "e": "е",
        "h": "н",
        "i": "і",
        "k": "к",
        "m": "м",
        "n": "п",
        "o": "о",
        "p": "р",
        "t": "т",
        "x": "х",
        "y": "у",
        "ø": "д",
        "π": "п",
        "ο": "о",
    }
)


@dataclass(frozen=True)
class TextCorrection:
    page_id: str
    unit_id: str
    bbox: BBox
    confidence: float
    decision_id: str | None
    before: str
    after: str


def normalize_document_unit_designations(
    document: Document,
) -> tuple[Document, list[TextCorrection]]:
    pages = []
    corrections = []
    for page in document.pages:
        canonical = _canonical_abbreviations(page)
        page, page_corrections = _normalize_page(page, canonical)
        pages.append(page)
        corrections.extend(page_corrections)
    return document.model_copy(update={"pages": pages}), corrections


def _canonical_abbreviations(page: Page) -> dict[str, set[str]]:
    canonical: dict[str, set[str]] = {}
    for text in _page_text(page):
        for match in NUMBERED_UNIT_PATTERN.finditer(text):
            token = match.group("token").casefold()
            if CYRILLIC_ABBREVIATION_PATTERN.fullmatch(token):
                canonical.setdefault(match.group("number"), set()).add(token)
    return canonical


def _normalize_page(
    page: Page,
    canonical: dict[str, set[str]],
) -> tuple[Page, list[TextCorrection]]:
    blocks = []
    corrections = []
    for block in page.blocks:
        if isinstance(block, Table):
            block, block_corrections = _normalize_table(page.id, block, canonical)
        else:
            block, block_corrections = _normalize_text_block(page.id, block, canonical)
        blocks.append(block)
        corrections.extend(block_corrections)
    return page.model_copy(update={"blocks": blocks}), corrections


def _normalize_text_block(
    page_id: str,
    block: TextBlock,
    canonical: dict[str, set[str]],
) -> tuple[TextBlock, list[TextCorrection]]:
    paragraphs = [_normalize_text(paragraph, canonical) for paragraph in block.paragraphs]
    if paragraphs == block.paragraphs:
        return block, []
    updated = block.model_copy(update={"paragraphs": paragraphs})
    return updated, [_correction(page_id, block, block.paragraphs, paragraphs)]


def _normalize_table(
    page_id: str,
    table: Table,
    canonical: dict[str, set[str]],
) -> tuple[Table, list[TextCorrection]]:
    corrections = []
    caption = _normalize_text(table.caption, canonical) if table.caption else table.caption
    if caption != table.caption:
        corrections.append(_correction(page_id, table, [table.caption or ""], [caption or ""]))
    cells = []
    for cell in table.cells:
        paragraphs = [_normalize_text(paragraph, canonical) for paragraph in cell.paragraphs]
        if paragraphs != cell.paragraphs:
            corrections.append(_correction(page_id, cell, cell.paragraphs, paragraphs))
            cell = cell.model_copy(update={"paragraphs": paragraphs})
        cells.append(cell)
    return table.model_copy(update={"caption": caption, "cells": cells}), corrections


def _normalize_text(text: str, canonical: dict[str, set[str]]) -> str:
    def replacement(match: re.Match[str]) -> str:
        token = match.group("token")
        if CYRILLIC_ABBREVIATION_PATTERN.fullmatch(token):
            return match.group(0)
        normalized = token.casefold().translate(UNIT_CONFUSABLES)
        matches = [value for value in canonical.get(match.group("number"), set()) if value == normalized]
        if len(matches) != 1:
            return match.group(0)
        return f"{match.group('number')} {matches[0]}"

    return NUMBERED_UNIT_PATTERN.sub(replacement, text)


def _page_text(page: Page) -> list[str]:
    values = []
    for block in page.blocks:
        if isinstance(block, Table):
            if block.caption:
                values.append(block.caption)
            values.extend(paragraph for cell in block.cells for paragraph in cell.paragraphs)
        else:
            values.extend(block.paragraphs)
    return values


def _correction(
    page_id: str,
    unit: TextBlock | Table | Cell,
    before: list[str],
    after: list[str],
) -> TextCorrection:
    return TextCorrection(
        page_id=page_id,
        unit_id=unit.id,
        bbox=unit.bbox,
        confidence=unit.confidence,
        decision_id=unit.decision_id,
        before="\n".join(before),
        after="\n".join(after),
    )
