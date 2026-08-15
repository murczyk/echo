from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from echo_document_extractor.canonical import table_dimensions
from echo_document_extractor.config import EndpointConfig, ExtractionConfig
from echo_document_extractor.models import (
    CandidateEvidence,
    Cell,
    CellEvidence,
    Evidence,
    Status,
    Table,
    TextBlock,
)
from echo_document_extractor.pipeline import (
    Extractor,
    _expanded_text_bbox,
    _local_candidate,
    _matching_text_bbox,
    _normalize_table_sections,
    _project_table_structure,
    _project_table_values,
    _retry_cell_values,
    _table_content_retry_needed,
    _unique_cross_family_consensus,
)
from echo_document_extractor.sanitize import has_fatal_sanitization_reason, sanitize_candidate
from echo_document_extractor.validation import validate_package


class StaticAdapter:
    def __init__(self, name: str, markup: str, valid: bool = True) -> None:
        self.name = name
        self.markup = markup
        self.valid = valid

    async def extract(self, image: Image.Image, unit_id: str) -> Evidence:
        return Evidence(
            id=f"{self.name}-{unit_id}",
            source=self.name,
            html=self.markup,
            text="A 123",
            confidence=0.9,
            valid=self.valid,
        )


@pytest.fixture
def config() -> ExtractionConfig:
    endpoint = EndpointConfig(
        url="http://unused/v1", model_id="unused", revision="revision", token_env="UNUSED"
    )
    return ExtractionConfig(nu_extract=endpoint, gemma=endpoint, enable_paddle=False)


def create_image(path: Path) -> None:
    image = Image.new("RGB", (300, 180), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 10, 290, 170), outline="black", width=2)
    draw.line((10, 80, 290, 80), fill="black", width=2)
    draw.line((150, 10, 150, 170), fill="black", width=2)
    image.save(path)


async def test_package_preserves_empty_and_merged_cells(tmp_path: Path, config: ExtractionConfig) -> None:
    source = tmp_path / "source.png"
    create_image(source)
    markup = (
        "<article><p>A 123</p><table><tr><th colspan='2'>Header</th></tr>"
        "<tr><td></td><td>B</td></tr></table></article>"
    )
    extractor = Extractor(config, [StaticAdapter("nuextract3", markup), StaticAdapter("gemma", markup)])
    result = await extractor.extract([source])
    output = tmp_path / "output"
    result.write_package(output)
    assert result.status == Status.ACCEPTED
    assert 'colspan="2"' in result.canonical_html
    assert "<td" in result.canonical_html
    assert validate_package(output) == []


async def test_duplicate_images_require_manifest(tmp_path: Path, config: ExtractionConfig) -> None:
    first = tmp_path / "first.png"
    second = tmp_path / "second.png"
    create_image(first)
    create_image(second)
    with pytest.raises(ValueError, match="manifest"):
        await Extractor(config, []).extract([first, second])


async def test_all_sources_failed_preserves_raster(tmp_path: Path, config: ExtractionConfig) -> None:
    source = tmp_path / "source.png"
    create_image(source)
    result = await Extractor(config, [StaticAdapter("bad", "", False)]).extract([source])
    assert result.status == Status.FAILED
    assert "<img" in result.canonical_html
    assert len(result.assets) == 1


def test_sanitizer_rejects_repetition_and_strips_unsafe_content() -> None:
    repeated = "repeated phrase with enough characters to trigger rejection"
    markup, reasons = sanitize_candidate(
        f"<script>x()</script><p onclick='x()'>{repeated}\n{repeated}\n{repeated}</p>"
    )
    assert "script" not in markup
    assert "onclick" not in markup
    assert "repetition" in reasons
    assert has_fatal_sanitization_reason(reasons)


async def test_sanitizer_cleanup_does_not_discard_safe_content(
    tmp_path: Path, config: ExtractionConfig
) -> None:
    source = tmp_path / "source.png"
    create_image(source)
    markup = "<div><article><p>A 123</p></article></div>"
    result = await Extractor(
        config,
        [StaticAdapter("nuextract3", markup), StaticAdapter("gemma", markup)],
    ).extract([source])
    assert result.status == Status.ACCEPTED
    assert "A 123" in result.canonical_html


def test_cell_retry_preserves_base_table_topology() -> None:
    base = Cell(
        id="p1-t1-c2",
        row=1,
        column=2,
        rowspan=2,
        colspan=3,
        bbox=(10, 20, 90, 80),
    )
    candidate = CandidateEvidence(
        id="gemma-p1-t1-c2-retry",
        source="gemma",
        page_id="p1",
        unit_id=base.id,
        bbox=base.bbox,
        html="<table><tr><td>retried value</td></tr></table>",
    )
    evidence, values = _retry_cell_values([candidate], base)
    selected = values[evidence[0].id]
    assert (selected.row, selected.column, selected.rowspan, selected.colspan) == (1, 2, 2, 3)


def test_geometry_supported_empty_cell_does_not_trigger_model_retry() -> None:
    cell = Cell(id="p1-t1-c1", row=0, column=0, bbox=(0, 0, 100, 50))
    table = Table(id="p1-t1", bbox=(0, 0, 100, 50), reading_order=0, cells=[cell])
    supporting = [
        CellEvidence(
            id="opencv-cell",
            source="opencv",
            page_id="p1",
            unit_id=cell.id,
            bbox=cell.bbox,
            row=0,
            column=0,
        )
    ]

    assert not _table_content_retry_needed(table, [], supporting, 2)


def test_conflicting_cells_trigger_one_table_content_retry() -> None:
    cell = Cell(
        id="p1-t1-c1",
        row=0,
        column=0,
        bbox=(0, 0, 100, 50),
        paragraphs=["A"],
        confidence=0.9,
    )
    base = Table(id="p1-t1", bbox=(0, 0, 100, 50), reading_order=0, cells=[cell])
    nu = base.model_copy(update={"cells": [cell]})
    gemma = base.model_copy(update={"cells": [cell.model_copy(update={"paragraphs": ["B"]})]})

    assert _table_content_retry_needed(
        base,
        [
            (Evidence(id="nu", source="nuextract3", page_id="p1"), nu),
            (Evidence(id="gemma", source="gemma", page_id="p1"), gemma),
        ],
        [],
        2,
    )


def test_local_candidate_excludes_adjacent_row_evidence() -> None:
    cell_bbox = (50, 353, 90, 375)
    supporting = [
        Evidence(id="ocr-10", source="ppocr", page_id="p1", text="10.", bbox=(64, 331, 91, 354)),
        Evidence(id="ocr-11", source="ppocr", page_id="p1", text="11.", bbox=(64, 353, 92, 375)),
        Evidence(id="ocr-12", source="ppocr", page_id="p1", text="12.", bbox=(65, 374, 91, 398)),
    ]
    selected = _local_candidate("p1-b2-r12c1", cell_bbox, supporting)
    assert selected is not None
    assert selected.text == "11."


def test_text_bbox_expands_across_adjacent_ocr_lines_only() -> None:
    supporting = [
        Evidence(id="title", source="ppocr", page_id="p1", text="Title", bbox=(50, 15, 150, 37)),
        Evidence(id="subtitle", source="ppocr", page_id="p1", text="Subtitle", bbox=(40, 42, 160, 64)),
        Evidence(id="table", source="ppocr", page_id="p1", text="Header", bbox=(40, 150, 160, 172)),
    ]

    assert _expanded_text_bbox((45, 0, 155, 25), supporting) == (40, 0, 160, 64)


def test_text_bbox_uses_matching_ocr_line_instead_of_full_page() -> None:
    block = TextBlock(
        kind="paragraph",
        id="p1-b1",
        bbox=(0, 0, 300, 300),
        reading_order=0,
        paragraphs=["Assault groups"],
    )
    supporting = [
        Evidence(
            id="title",
            source="ppocr",
            page_id="p1",
            text="Assault groups",
            bbox=(40, 120, 180, 145),
        ),
        Evidence(
            id="other",
            source="ppocr",
            page_id="p1",
            text="Unrelated table value",
            bbox=(40, 150, 180, 175),
        ),
    ]

    assert _matching_text_bbox(block, supporting) == (40, 120, 180, 145)


def test_geometry_expands_semantic_table_to_physical_grid() -> None:
    geometry = Table(
        id="p1-g1",
        bbox=(0, 0, 300, 100),
        reading_order=0,
        column_boundaries=[0, 100, 200, 300],
        cells=[
            Cell(id="g-h1", row=0, column=0, colspan=2, bbox=(0, 0, 200, 50)),
            Cell(id="g-h2", row=0, column=2, bbox=(200, 0, 300, 50)),
            Cell(id="g-a-top", row=1, column=0, bbox=(0, 50, 100, 60)),
            Cell(id="g-empty-top", row=1, column=1, bbox=(100, 50, 200, 60)),
            Cell(id="g-b-top", row=1, column=2, bbox=(200, 50, 300, 60)),
            Cell(id="g-a-bottom", row=2, column=0, bbox=(0, 60, 100, 100)),
            Cell(id="g-empty-bottom", row=2, column=1, bbox=(100, 60, 200, 100)),
            Cell(id="g-b-bottom", row=2, column=2, bbox=(200, 60, 300, 100)),
        ],
    )
    semantic = Table(
        id="p1-b1",
        bbox=geometry.bbox,
        reading_order=0,
        cells=[
            Cell(id="s-h1", row=0, column=0, bbox=geometry.bbox, paragraphs=["Group"]),
            Cell(id="s-h2", row=0, column=1, bbox=geometry.bbox, paragraphs=["Value"]),
            Cell(id="s-a", row=1, column=0, bbox=geometry.bbox, paragraphs=["A"]),
            Cell(id="s-b", row=1, column=1, bbox=geometry.bbox, paragraphs=["B"]),
        ],
    )
    supporting = [
        Evidence(id="ocr-a", source="ppocr", page_id="p1", text="A", bbox=(10, 55, 40, 90)),
        Evidence(id="ocr-b", source="ppocr", page_id="p1", text="B", bbox=(210, 55, 240, 90)),
    ]

    projected = _project_table_structure(semantic, geometry, supporting)

    assert projected is not None
    assert table_dimensions(projected) == (2, 3)
    assert next(cell for cell in projected.cells if cell.row == 0 and cell.column == 0).colspan == 2
    assert [(cell.column, cell.paragraphs) for cell in projected.cells if cell.row == 1] == [
        (0, ["A"]),
        (1, []),
        (2, ["B"]),
    ]
    candidate = _project_table_values(semantic, projected, supporting)
    inserted = next(cell for cell in candidate.cells if cell.row == 1 and cell.column == 1)
    assert inserted.confidence == 0


def test_geometry_projects_equal_column_table_to_matching_row_window() -> None:
    geometry = Table(
        id="p1-g1",
        bbox=(0, 0, 200, 80),
        reading_order=0,
        column_boundaries=[0, 100, 200],
        cells=[
            Cell(id=f"g-r{row + 1}c{column + 1}", row=row, column=column, bbox=bbox)
            for row in range(4)
            for column, bbox in enumerate(
                ((0, row * 20, 100, row * 20 + 20), (100, row * 20, 200, row * 20 + 20))
            )
        ],
    )
    semantic = Table(
        id="p1-b1",
        bbox=geometry.bbox,
        reading_order=0,
        cells=[
            Cell(id="s-r1c1", row=0, column=0, bbox=geometry.bbox, paragraphs=["C"]),
            Cell(id="s-r1c2", row=0, column=1, bbox=geometry.bbox, paragraphs=["D"]),
            Cell(id="s-r2c1", row=1, column=0, bbox=geometry.bbox, paragraphs=["E"]),
            Cell(id="s-r2c2", row=1, column=1, bbox=geometry.bbox, paragraphs=["F"]),
        ],
    )
    supporting = [
        Evidence(
            id=f"ocr-{text}",
            source="ppocr",
            page_id="p1",
            text=text,
            bbox=(column * 100 + 10, row * 20 + 2, column * 100 + 30, row * 20 + 18),
        )
        for row, values in enumerate((("A", "B"), ("X", "Y"), ("C", "D"), ("E", "F")))
        for column, text in enumerate(values)
    ]

    projected = _project_table_structure(semantic, geometry, supporting)

    assert projected is not None
    assert projected.bbox == (0, 40, 200, 80)
    assert sorted({cell.bbox[1] for cell in projected.cells}) == [40, 60]


def test_table_sections_are_leading_header_rows_followed_by_body_rows() -> None:
    cells = [
        Cell(id="r1c1", row=0, column=0, bbox=(0, 0, 10, 10), section="thead"),
        Cell(id="r1c2", row=0, column=1, bbox=(10, 0, 20, 10), section="thead"),
        Cell(id="r2c1", row=1, column=0, bbox=(0, 10, 10, 20), section="thead"),
        Cell(id="r2c2", row=1, column=1, bbox=(10, 10, 20, 20), section="tbody"),
        Cell(id="r3c1", row=2, column=0, bbox=(0, 20, 10, 30), section="thead"),
        Cell(id="r3c2", row=2, column=1, bbox=(10, 20, 20, 30), section="thead"),
    ]
    normalized = _normalize_table_sections(cells)
    assert [cell.section for cell in normalized] == [
        "thead",
        "thead",
        "tbody",
        "tbody",
        "tbody",
        "tbody",
    ]


def test_retry_conflict_is_resolved_only_by_unique_cross_family_consensus() -> None:
    correct = CandidateEvidence(
        id="nu-retry",
        source="nuextract3",
        page_id="p1",
        unit_id="cell",
        bbox=(0, 0, 10, 10),
        text="Новоивановка",
    )
    candidates = [
        CandidateEvidence(
            id="nu-initial",
            source="nuextract3",
            page_id="p1",
            unit_id="cell",
            bbox=(0, 0, 10, 10),
            text="Новоповановка",
        ),
        CandidateEvidence(
            id="gemma-initial",
            source="gemma",
            page_id="p1",
            unit_id="cell",
            bbox=(0, 0, 10, 10),
            text="Новоивановка",
        ),
        correct,
        CandidateEvidence(
            id="gemma-retry",
            source="gemma",
            page_id="p1",
            unit_id="cell",
            bbox=(0, 0, 10, 10),
            text="7.",
        ),
    ]
    assert _unique_cross_family_consensus(correct, candidates)

    candidates[1] = candidates[1].model_copy(update={"text": "7."})
    assert not _unique_cross_family_consensus(correct, candidates)
