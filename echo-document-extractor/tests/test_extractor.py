from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from echo_document_extractor.config import EndpointConfig, ExtractionConfig
from echo_document_extractor.models import Evidence, Status
from echo_document_extractor.pipeline import Extractor
from echo_document_extractor.sanitize import sanitize_candidate
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
