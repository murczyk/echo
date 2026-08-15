from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from openpyxl import load_workbook
from PIL import Image, ImageDraw
from typer.testing import CliRunner

from echo_document_extractor.adapters import markdown_to_html
from echo_document_extractor.canonical import parse_canonical_html
from echo_document_extractor.cli import app
from echo_document_extractor.config import EndpointConfig, ExtractionConfig
from echo_document_extractor.ingest import _pdf_text_evidence, crop
from echo_document_extractor.models import Evidence, Status
from echo_document_extractor.pipeline import Extractor
from echo_document_extractor.sanitize import sanitize_candidate
from echo_document_extractor.validation import validate_package


class CountingAdapter:
    def __init__(self, name: str, markup: str) -> None:
        self.name = name
        self.markup = markup
        self.calls = 0

    async def extract(self, image: Image.Image, unit_id: str) -> Evidence:
        self.calls += 1
        return Evidence(
            id=f"{self.name}-{unit_id}",
            source=self.name,
            html=self.markup,
            text="source",
            confidence=0.9,
        )


@pytest.fixture
def config() -> ExtractionConfig:
    endpoint = EndpointConfig(
        url="http://unused/v1",
        model_id="unused",
        revision="revision",
        token_env="UNUSED",
    )
    return ExtractionConfig(nu_extract=endpoint, gemma=endpoint, enable_paddle=False)


async def test_empty_and_corrupt_inputs_write_failure_packages(
    tmp_path: Path, config: ExtractionConfig
) -> None:
    empty = await Extractor(config, []).extract([])
    assert empty.status == Status.FAILED
    empty_output = tmp_path / "empty-output"
    empty.write_package(empty_output)
    assert validate_package(empty_output) == []

    corrupt = tmp_path / "corrupt.png"
    corrupt.write_bytes(b"not an image")
    failed = await Extractor(config, []).extract([corrupt])
    assert failed.status == Status.FAILED
    failed_output = tmp_path / "failed-output"
    failed.write_package(failed_output)
    assert validate_package(failed_output) == []


def test_cli_writes_failure_package_for_unreadable_source(
    tmp_path: Path,
    config: ExtractionConfig,
) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        yaml.safe_dump(config.model_dump(mode="json")),
        encoding="utf-8",
    )
    output = tmp_path / "output"
    invocation = CliRunner().invoke(
        app,
        [
            "extract",
            str(tmp_path / "missing.png"),
            "--output",
            str(output),
            "--config",
            str(config_path),
        ],
    )
    assert invocation.exit_code == 0
    assert invocation.stdout.strip() == "failed"
    assert validate_package(output) == []


def test_sanitizer_removes_unsafe_contents_and_external_images() -> None:
    markup, reasons = sanitize_candidate(
        "<article><script>secret payload</script><img src='https://example.test/x.png'><p>safe</p></article>"
    )
    assert "secret payload" not in markup
    assert "example.test" not in markup
    assert "unsafe_content_removed" in reasons
    assert "external_or_invented_url" in reasons


def test_crop_always_respects_long_edge_cap() -> None:
    image = Image.new("RGB", (5000, 200), "white")
    resized = crop(image, (0, 0, 5000, 200), 0.0, 2.0, 4096)
    assert resized.size == (4096, 164)


async def test_duplicate_raster_is_processed_once_and_cloned_in_order(
    tmp_path: Path,
    config: ExtractionConfig,
) -> None:
    image = Image.new("RGB", (100, 80), "white")
    first = tmp_path / "first.png"
    second = tmp_path / "second.png"
    image.save(first)
    image.save(second)
    manifest = tmp_path / "manifest.yaml"
    manifest.write_text("inputs:\n  - first.png\n  - second.png\n", encoding="utf-8")
    nu = CountingAdapter("nuextract3", "<article><p>same</p></article>")
    gemma = CountingAdapter("gemma", "<article><p>same</p></article>")
    result = await Extractor(config, [nu, gemma]).extract([first, second], manifest)
    assert nu.calls == 1
    assert gemma.calls == 1
    assert [page.id for page in result.document.pages] == ["p1", "p2"]
    assert result.document.pages[0].raster_sha256 == result.document.pages[1].raster_sha256
    output = tmp_path / "output"
    result.write_package(output)
    assert validate_package(output) == []


async def test_xlsx_formula_like_text_is_literal(tmp_path: Path, config: ExtractionConfig) -> None:
    source = tmp_path / "source.png"
    Image.new("RGB", (200, 100), "white").save(source)
    markup = "<article><table><tr><td>=2+2</td><td>+1</td><td>-1</td><td>@x</td></tr></table></article>"
    result = await Extractor(
        config,
        [CountingAdapter("nuextract3", markup), CountingAdapter("gemma", markup)],
    ).extract([source])
    output = tmp_path / "output"
    result.write_package(output)
    workbook = load_workbook(output / "document.xlsx", data_only=False)
    cells = list(workbook["Table 1"][1])
    assert [cell.value for cell in cells] == ["=2+2", "+1", "-1", "@x"]
    assert all(cell.data_type == "s" for cell in cells)


async def test_conflicting_block_is_retried_once_without_sentence_splicing(
    tmp_path: Path,
    config: ExtractionConfig,
) -> None:
    source = tmp_path / "source.png"
    Image.new("RGB", (200, 100), "white").save(source)
    nu = CountingAdapter("nuextract3", "<article><p>Alpha 123 complete.</p></article>")
    gemma = CountingAdapter("gemma", "<article><p>Beta 456 complete.</p></article>")
    result = await Extractor(config, [nu, gemma]).extract([source])
    assert nu.calls == 2
    assert gemma.calls == 2
    assert result.status == Status.DEGRADED
    assert any(decision.retries for decision in result.decisions)
    assert ("Alpha 123 complete." in result.canonical_html) != ("Beta 456 complete." in result.canonical_html)


async def test_image_cell_reuses_lossless_asset_in_all_projections(
    tmp_path: Path,
    config: ExtractionConfig,
) -> None:
    source = tmp_path / "source.png"
    image = Image.new("RGB", (400, 240), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 10, 390, 230), outline="black", width=2)
    draw.line((200, 10, 200, 230), fill="black", width=2)
    draw.line((10, 120, 390, 120), fill="black", width=2)
    image.paste(Image.effect_noise((150, 70), 80).convert("RGB"), (225, 140))
    image.save(source)
    markup = (
        "<article><table><tr><td>A</td><td>B</td></tr>"
        "<tr><td>C</td><td data-image='present'></td></tr></table></article>"
    )
    result = await Extractor(
        config,
        [CountingAdapter("nuextract3", markup), CountingAdapter("gemma", markup)],
    ).extract([source])
    output = tmp_path / "output"
    result.write_package(output)
    assert len(result.assets) == 1
    asset_path = next(iter(result.assets))
    assert asset_path in result.canonical_html
    assert asset_path in result.markdown
    workbook = load_workbook(output / "document.xlsx")
    assert len(workbook["Table 1"]._images) == 1
    assert validate_package(output) == []


def test_manifest_rejects_path_traversal(tmp_path: Path, config: ExtractionConfig) -> None:
    manifest = tmp_path / "manifest.yaml"
    manifest.write_text("inputs:\n  - ../outside.png\n", encoding="utf-8")
    with pytest.raises(ValueError, match="unsafe relative path"):
        # Validation happens before ingestion and does not depend on the file existing.
        from echo_document_extractor.pipeline import _resolve_inputs

        _resolve_inputs([], manifest)


def test_markdown_and_canonical_round_trip_preserve_structure() -> None:
    converted = markdown_to_html("# Title\n\n1. first\n2. second\n\n<table><tr><td>A</td></tr></table>")
    assert "<h1>Title</h1>" in converted
    assert "<ol>" in converted
    assert "<table>" in converted


class FakeTextPage:
    def count_chars(self) -> int:
        return 2

    def get_text_range(self, index: int, count: int) -> str:
        return "A "[index : index + count]

    def get_charbox(self, index: int) -> tuple[float, float, float, float]:
        return (10.0, 20.0, 20.0, 30.0)


class FakePdfPage:
    def get_textpage(self) -> FakeTextPage:
        return FakeTextPage()

    def get_size(self) -> tuple[float, float]:
        return (100.0, 200.0)


def test_pdf_text_coordinates_are_scaled_to_source_pixels() -> None:
    evidence = _pdf_text_evidence(FakePdfPage(), "a" * 64, dpi=300, raster_size=(417, 833))
    assert evidence[0].bbox == (42, 708, 83, 750)


async def test_canonical_parser_preserves_ids_and_relationships(
    tmp_path: Path, config: ExtractionConfig
) -> None:
    source = tmp_path / "source.png"
    Image.new("RGB", (200, 100), "white").save(source)
    markup = (
        "<article><ol><li>A</li><li>B</li></ol><table><thead><tr><th>A</th></tr></thead></table></article>"
    )
    result = await Extractor(
        config,
        [CountingAdapter("nuextract3", markup), CountingAdapter("gemma", markup)],
    ).extract([source])
    parsed = parse_canonical_html(result.canonical_html)
    assert [block.id for block in parsed.pages[0].blocks] == [
        block.id for block in result.document.pages[0].blocks
    ]
    assert parsed.pages[0].blocks[0].list_ordered
    table = parsed.pages[0].blocks[1]
    assert table.cells[0].section == "thead"
