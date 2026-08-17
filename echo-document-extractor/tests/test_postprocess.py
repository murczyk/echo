from echo_document_extractor.models import Cell, Decision, Document, Evidence, Page, Table, TextBlock
from echo_document_extractor.pipeline import _record_text_corrections
from echo_document_extractor.postprocess import normalize_document_unit_designations


def test_same_page_canonical_unit_abbreviation_repairs_confusable_table_values() -> None:
    heading = TextBlock(
        kind="heading",
        id="p1-b1",
        bbox=(0, 0, 1000, 100),
        reading_order=0,
        paragraphs=["Штурмовые группы 119 пдп"],
        level=4,
        decision_id="decision-p1-b1",
    )
    cells = [
        Cell(
            id="p1-b2-r1c1",
            row=0,
            column=0,
            bbox=(0, 100, 500, 200),
            paragraphs=["шр/2/119 nøn"],
            decision_id="decision-p1-b2-r1c1",
        ),
        Cell(
            id="p1-b2-r1c2",
            row=0,
            column=1,
            bbox=(500, 100, 1000, 200),
            paragraphs=["119 noon; 120 nøn; nøn"],
            decision_id="decision-p1-b2-r1c2",
        ),
    ]
    table = Table(id="p1-b2", bbox=(0, 100, 1000, 200), reading_order=1, cells=cells)
    page = Page(
        id="p1",
        source_name="source.png",
        source_sha256="a" * 64,
        raster_sha256="b" * 64,
        instance=0,
        width=1000,
        height=1000,
        blocks=[heading, table],
    )

    document, corrections = normalize_document_unit_designations(Document(id="document", pages=[page]))

    output = next(block for block in document.pages[0].blocks if isinstance(block, Table))
    assert output.cells[0].paragraphs == ["шр/2/119 пдп"]
    assert output.cells[1].paragraphs == ["119 noon; 120 nøn; nøn"]
    assert [(item.before, item.after) for item in corrections] == [("шр/2/119 nøn", "шр/2/119 пдп")]

    evidence = [Evidence(id="source-cell", source="gemma")]
    decisions = [
        Decision(
            id="decision-p1-b2-r1c1",
            unit_id="p1-b2-r1c1",
            selected_evidence_id="source-cell",
            reason="model selection",
            hard_checks_passed=True,
        )
    ]
    _record_text_corrections(corrections, evidence, decisions)

    assert evidence[-1].source == "document_context_rules"
    assert decisions[0].selected_evidence_id == "postprocess-p1-b2-r1c1"
    assert "source-cell" in decisions[0].alternative_evidence_ids


def test_confusable_unit_is_not_guessed_without_same_page_canonical_form() -> None:
    block = TextBlock(
        kind="paragraph",
        id="p1-b1",
        bbox=(0, 0, 100, 100),
        reading_order=0,
        paragraphs=["шр/2/119 nøn"],
        decision_id="decision-p1-b1",
    )
    page = Page(
        id="p1",
        source_name="source.png",
        source_sha256="a" * 64,
        raster_sha256="b" * 64,
        instance=0,
        width=100,
        height=100,
        blocks=[block],
    )

    document, corrections = normalize_document_unit_designations(Document(id="document", pages=[page]))

    output = document.pages[0].blocks[0]
    assert isinstance(output, TextBlock)
    assert output.paragraphs == ["шр/2/119 nøn"]
    assert corrections == []
