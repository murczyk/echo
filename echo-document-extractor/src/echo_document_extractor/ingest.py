from __future__ import annotations

import hashlib
import io
import mimetypes
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .models import BBox, Evidence, SourceTransform


@dataclass(frozen=True)
class RasterPage:
    source_name: str
    instance: int
    source_sha256: str
    raster_sha256: str
    image: Image.Image
    rotation_degrees: int = 0
    embedded_evidence: tuple[Evidence, ...] = ()

    @property
    def sha256(self) -> str:
        """Compatibility alias for the normalized raster hash."""
        return self.raster_sha256

    def png_bytes(self) -> bytes:
        output = io.BytesIO()
        self.image.save(output, "PNG", optimize=False)
        return output.getvalue()


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _normalized_png(image: Image.Image) -> bytes:
    content = io.BytesIO()
    image.save(content, "PNG", optimize=False)
    return content.getvalue()


def _read_image(path: Path) -> tuple[bytes, Image.Image, int]:
    try:
        source = path.read_bytes()
    except OSError as error:
        raise ValueError(f"unreadable image: {path.name}") from error
    if not source:
        raise ValueError(f"empty input: {path.name}")
    try:
        with Image.open(io.BytesIO(source)) as opened:
            orientation = int(opened.getexif().get(274, 1))
            image = ImageOps.exif_transpose(opened).convert("RGB")
            image.load()
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise ValueError(f"unreadable image: {path.name}") from error
    rotation = {3: 180, 6: 90, 8: 270}.get(orientation, 0)
    return source, image, rotation


def _image_pages(path: Path, first_instance: int) -> Iterator[RasterPage]:
    source, image, rotation = _read_image(path)
    pages = _split_spread(image)
    source_digest = _sha256(source)
    for index, page in enumerate(pages):
        normalized = _normalized_png(page)
        source_name = path.name if len(pages) == 1 else f"{path.name}#spread={index + 1}"
        yield RasterPage(
            source_name,
            first_instance + index,
            source_digest,
            _sha256(normalized),
            page,
            rotation,
        )


def image_page_count(path: Path) -> int:
    _, image, _ = _read_image(path)
    return len(_split_spread(image))


def _split_spread(image: Image.Image) -> list[Image.Image]:
    width, height = image.size
    if width < height * 1.45:
        return [image]
    gray = np.asarray(image.convert("L"))
    dark_fraction = np.mean(gray < 40, axis=0)
    runs = _dark_column_runs(dark_fraction > 0.75, max(6, round(width * 0.002)))
    minimum_width = max(8, round(width * 0.004))
    central = [
        (start, end)
        for start, end in runs
        if end - start >= minimum_width and width * 0.35 <= (start + end) / 2 <= width * 0.65
    ]
    if not central:
        return [image]
    start, end = min(central, key=lambda run: abs((run[0] + run[1]) / 2 - width / 2))
    if start < height * 0.55 or width - end < height * 0.55:
        return [image]
    return [image.crop((0, 0, start, height)), image.crop((end, 0, width, height))]


def _dark_column_runs(mask: np.ndarray, maximum_gap: int) -> list[tuple[int, int]]:
    raw: list[tuple[int, int]] = []
    start = None
    for index, selected in enumerate(mask):
        if selected and start is None:
            start = index
        elif not selected and start is not None:
            raw.append((start, index))
            start = None
    if start is not None:
        raw.append((start, len(mask)))
    merged: list[tuple[int, int]] = []
    for start, end in raw:
        if merged and start - merged[-1][1] <= maximum_gap:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


def _pdf_pages(path: Path, dpi: int, first_instance: int) -> Iterator[RasterPage]:
    try:
        import pypdfium2 as pdfium
    except ImportError as error:
        raise RuntimeError("PDF support requires pypdfium2") from error

    try:
        size = path.stat().st_size
    except OSError as error:
        raise ValueError(f"unreadable PDF: {path.name}") from error
    if not size:
        raise ValueError(f"empty input: {path.name}")
    try:
        document = pdfium.PdfDocument(str(path))
    except Exception as error:
        raise ValueError(f"unreadable PDF: {path.name}") from error
    if len(document) == 0:
        raise ValueError(f"PDF contains no pages: {path.name}")
    try:
        scale = dpi / 72
        source_digest = _sha256_file(path)
        for index in range(len(document)):
            try:
                page = document[index]
                image = page.render(scale=scale).to_pil().convert("RGB")
                image.load()
            except Exception as error:
                raise ValueError(f"unable to render {path.name} page {index + 1}") from error
            raster_digest = _sha256(_normalized_png(image))
            try:
                rotation = int(page.get_rotation()) % 360
            except Exception:
                rotation = 0
            evidence = tuple(_pdf_text_evidence(page, raster_digest, dpi, image.size, rotation))
            try:
                yield RasterPage(
                    f"{path.name}#page={index + 1}",
                    first_instance + index,
                    source_digest,
                    raster_digest,
                    image,
                    rotation,
                    evidence,
                )
            finally:
                page.close()
    finally:
        document.close()


def _pdf_text_evidence(
    page: object,
    digest: str,
    dpi: int = 300,
    raster_size: tuple[int, int] | None = None,
    rotation_degrees: int | None = None,
) -> list[Evidence]:
    """Extract word/line runs and transform PDF points into source raster pixels."""
    try:
        text_page = page.get_textpage()
        count = int(text_page.count_chars())
        page_width, page_height = page.get_size()
    except Exception:
        return []
    scale = dpi / 72
    if rotation_degrees is None:
        try:
            rotation_degrees = int(page.get_rotation()) % 360
        except Exception:
            rotation_degrees = 0
    raster_width, raster_height = raster_size or (
        max(1, round(page_width * scale)),
        max(1, round(page_height * scale)),
    )
    runs: list[tuple[str, list[tuple[float, float, float, float]]]] = []
    text = ""
    boxes: list[tuple[float, float, float, float]] = []
    for index in range(count):
        try:
            character = text_page.get_text_range(index, 1)
        except Exception:
            character = ""
        if not character:
            continue
        if character.isspace():
            if text:
                runs.append((text, boxes))
                text, boxes = "", []
            continue
        try:
            box = tuple(float(value) for value in text_page.get_charbox(index))
        except Exception:
            box = ()
        text += character
        if len(box) == 4:
            boxes.append(box)
    if text:
        runs.append((text, boxes))

    transform = SourceTransform(
        scale_x=scale,
        scale_y=scale,
        rotation_degrees=rotation_degrees if rotation_degrees <= 180 else rotation_degrees - 360,
    )
    evidence: list[Evidence] = []
    for index, (value, run_boxes) in enumerate(runs):
        if not value.strip() or not run_boxes:
            continue
        pdf_box = (
            min(box[0] for box in run_boxes),
            page_height - max(box[3] for box in run_boxes),
            max(box[2] for box in run_boxes),
            page_height - min(box[1] for box in run_boxes),
        )
        rotated = _rotate_pdf_bbox(pdf_box, page_width, page_height, rotation_degrees)
        left = max(0, round(rotated[0] * scale))
        top = max(0, round(rotated[1] * scale))
        right = min(raster_width, round(rotated[2] * scale))
        bottom = min(raster_height, round(rotated[3] * scale))
        if right <= left or bottom <= top:
            continue
        evidence.append(
            Evidence(
                id=f"pdf-{digest[:12]}-{index + 1}",
                kind="ocr_token",
                source="embedded_pdf",
                source_family="embedded_pdf",
                text=value,
                bbox=(left, top, right, bottom),
                confidence=1.0,
                transform=transform,
            )
        )
    return evidence


def _rotate_pdf_bbox(
    bbox: tuple[float, float, float, float],
    width: float,
    height: float,
    rotation: int,
) -> tuple[float, float, float, float]:
    left, top, right, bottom = bbox
    if rotation == 90:
        return (height - bottom, left, height - top, right)
    if rotation == 180:
        return (width - right, height - bottom, width - left, height - top)
    if rotation == 270:
        return (top, width - right, bottom, width - left)
    return bbox


def iter_ingest(inputs: list[str | Path], dpi: int) -> Iterator[RasterPage]:
    if not inputs:
        raise ValueError("no input files")
    instance = 0
    for value in inputs:
        path = Path(value)
        if not path.is_file():
            raise ValueError(f"input is not a readable file: {path.name}")
        mime = mimetypes.guess_type(path.name)[0]
        if mime == "application/pdf" or path.suffix.casefold() == ".pdf":
            for page in _pdf_pages(path, dpi, instance):
                yield page
                instance += 1
        elif (mime and mime.startswith("image/")) or path.suffix.casefold() in {".png", ".jpg", ".jpeg"}:
            for page in _image_pages(path, instance):
                yield page
                instance += 1
        else:
            raise ValueError(f"unsupported input: {path.name}")


def ingest(inputs: list[str | Path], dpi: int) -> list[RasterPage]:
    return list(iter_ingest(inputs, dpi))


def crop(image: Image.Image, bbox: BBox, padding: float, upscale: float, max_edge: int) -> Image.Image:
    cropped, _ = crop_with_transform(image, bbox, padding, upscale, max_edge)
    return cropped


def crop_with_transform(
    image: Image.Image,
    bbox: BBox,
    padding: float,
    upscale: float,
    max_edge: int,
) -> tuple[Image.Image, SourceTransform]:
    left, top, right, bottom = bbox
    if right > image.width or bottom > image.height:
        raise ValueError("crop bounding box exceeds source raster")
    pad_x = round((right - left) * padding)
    pad_y = round((bottom - top) * padding)
    box = (
        max(0, left - pad_x),
        max(0, top - pad_y),
        min(image.width, right + pad_x),
        min(image.height, bottom + pad_y),
    )
    cropped = image.crop(box)
    factor = min(upscale, max_edge / max(cropped.size))
    if abs(factor - 1.0) > 1e-9:
        cropped = cropped.resize(
            (max(1, round(cropped.width * factor)), max(1, round(cropped.height * factor))),
            Image.Resampling.LANCZOS,
        )
    return cropped, SourceTransform(
        scale_x=1 / factor,
        scale_y=1 / factor,
        offset_x=float(box[0]),
        offset_y=float(box[1]),
    )
