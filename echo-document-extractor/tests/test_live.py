from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from echo_document_extractor import ExtractionConfig, Extractor
from echo_document_extractor.canonical import table_dimensions
from echo_document_extractor.models import Status, Table
from echo_document_extractor.validation import evaluate

LIVE_CONFIG = os.environ.get("ECHO_DOC_LIVE_CONFIG")
LIVE_LAYOUT_MANIFEST = os.environ.get("ECHO_DOC_LIVE_LAYOUT_MANIFEST")
LIVE_RAW = os.environ.get("ECHO_DOC_LIVE_RAW")
LIVE_LEGACY_MANIFEST = os.environ.get("ECHO_DOC_LIVE_LEGACY_MANIFEST")
live = pytest.mark.skipif(
    not (LIVE_CONFIG and LIVE_RAW),
    reason="set ECHO_DOC_LIVE_CONFIG and ECHO_DOC_LIVE_RAW",
)


@pytest.mark.live
@live
async def test_live_layout_suite(tmp_path: Path) -> None:
    if not LIVE_LAYOUT_MANIFEST:
        pytest.skip("set ECHO_DOC_LIVE_LAYOUT_MANIFEST")
    layout = json.loads(Path(LIVE_LAYOUT_MANIFEST).read_text(encoding="utf-8"))
    documents = layout["documents"]
    assert documents
    assert sum(len(document["pages"]) for document in documents) > 0
    config = ExtractionConfig.from_yaml(LIVE_CONFIG)
    extractor = Extractor(config)
    raw = Path(LIVE_RAW)
    for document in documents:
        inputs = [raw / page["filename"] for page in document["pages"]]
        manifest = None
        if len(inputs) > 1:
            document_dir = tmp_path / document["id"]
            document_dir.mkdir()
            manifest = document_dir / "manifest.yaml"
            manifest.write_text(
                "inputs:\n" + "".join(f"  - {path.name}\n" for path in inputs),
                encoding="utf-8",
            )
            manifest_inputs = [manifest.parent / path.name for path in inputs]
            for source, target in zip(inputs, manifest_inputs, strict=True):
                shutil.copy2(source, target)
            inputs = manifest_inputs
        result = await extractor.extract(inputs, manifest)
        assert result.status != Status.FAILED
        assert not any("request_error" in evidence.rejection_reasons for evidence in result.evidence)
        _assert_layout_expectations(result, document["expect"])
        if document["expect"].get("retain_original_raster_on_model_failure") and (
            "model candidates failed hard checks; used local evidence" in result.quality.degraded_reasons
        ):
            assert any(
                getattr(block, "kind", None) == "unreadable" and getattr(block, "asset", None)
                for page in result.document.pages
                for block in page.blocks
            )
        for anchor in document["expect"].get("anchors", []):
            assert anchor in result.canonical_html
        repeat = await extractor.extract(inputs, manifest)
        assert repeat.canonical_html == result.canonical_html
        assert [item.model_dump(mode="json") for item in repeat.decisions] == [
            item.model_dump(mode="json") for item in result.decisions
        ]


@pytest.mark.live
@live
async def test_live_two_audited_legacy_pages(tmp_path: Path) -> None:
    if not LIVE_LEGACY_MANIFEST:
        pytest.skip("set ECHO_DOC_LIVE_LEGACY_MANIFEST")
    cases = json.loads(Path(LIVE_LEGACY_MANIFEST).read_text(encoding="utf-8"))["cases"]
    assert len(cases) == 2
    config = ExtractionConfig.from_yaml(LIVE_CONFIG)
    extractor = Extractor(config)
    for case in cases:
        result = await extractor.extract([Path(LIVE_RAW) / case["input"]])
        output = tmp_path / case["id"]
        result.write_package(output)
        metrics = evaluate(Path(LIVE_RAW) / case["gold"], output)
        assert metrics["passed"]
        assert metrics["critical_token_recall"] == 1.0


def _assert_layout_expectations(result: object, expected: dict[str, object]) -> None:
    tables = [block for page in result.document.pages for block in page.blocks if isinstance(block, Table)]
    assert len(tables) >= expected.get("min_tables", 0)
    dimensions = [table_dimensions(table) for table in tables]
    if columns := expected.get("table_columns"):
        assert [value[1] for value in dimensions] == columns
    if rows := expected.get("table_rows"):
        assert [value[0] for value in dimensions] == rows
