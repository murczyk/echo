import time
from abc import ABC, abstractmethod
from itertools import product

import cv2
import numpy as np
import rasterio
from loguru import logger
from rasterio.plot import reshape_as_image
from tqdm import tqdm

from milocr.datatypes import TextDetections

# Latin to Cyrillic mappings for normalization
LATIN_TO_CYRILLIC = {
    "A": "А",
    "a": "а",
    "B": "В",
    "b": "в",
    "C": "С",
    "c": "с",
    "D": "Д",
    "d": "д",
    "E": "Е",
    "e": "е",
    "F": "Г",
    "H": "Н",
    "h": "н",
    "I": "И",
    "K": "К",
    "k": "к",
    "L": "Л",
    "M": "М",
    "m": "м",
    "N": "Н",
    "O": "О",
    "o": "о",
    "P": "Р",
    "p": "р",
    "R": "Р",
    "S": "С",
    "s": "с",
    "T": "Т",
    "t": "т",
    "U": "У",
    "V": "В",
    "v": "в",
    "W": "Ш",
    "w": "ш",
    "X": "Х",
    "x": "х",
    "Y": "У",
    "y": "у",
    "Z": "З",
    "z": "з",
    "g": "г",
    "i": "и",
    "l": "л",
    "n": "н",
    "r": "р",
    "u": "у",
}

# Patterns that indicate Russian text even without Cyrillic
RUSSIAN_PATTERNS = ["ul.", "ul ", "UL.", "UL "]


def get_tiles(
    image_height: int,
    image_width: int,
    max_size: int = 4000,
    overlap: int = 400,
) -> list[tuple[int, int, int, int]]:
    """Generate tile coordinates with overlap.

    Args:
        image_height: Height of the image
        image_width: Width of the image
        max_size: Maximum tile size
        overlap: Overlap between tiles

    Returns:
        list of (x_start, y_start, x_end, y_end) tuples
    """
    step = max_size - overlap
    y_starts = range(0, image_height, step)
    x_starts = range(0, image_width, step)

    return [
        (
            x,
            y,
            min(x + max_size, image_width),
            min(y + max_size, image_height),
        )
        for y, x in product(y_starts, x_starts)
    ]


def normalize_to_cyrillic(text: str) -> str:
    """Normalize mixed Latin/Cyrillic text to Cyrillic.

    Replaces Latin characters with Cyrillic equivalents when text
    contains Cyrillic characters or Russian patterns.
    """
    # Check if text contains any Cyrillic or Russian patterns
    has_cyrillic = any("\u0400" <= c <= "\u04ff" for c in text)
    has_russian_pattern = any(p in text for p in RUSSIAN_PATTERNS)

    if not has_cyrillic and not has_russian_pattern:
        return text

    # Replace Latin characters with Cyrillic equivalents
    return "".join(LATIN_TO_CYRILLIC.get(c, c) for c in text)


class BaseTextDetector(ABC):
    """Abstract base class for text detectors with tiling support."""

    def __init__(
        self, max_size: int = 4000, overlap: int = 400, normalize: bool = True
    ):
        """Initialize detector.

        Args:
            max_size: Maximum tile size for large images
            overlap: Overlap between tiles to avoid cutting text
            normalize: Whether to apply text normalization (Latin to Cyrillic)
        """
        self.max_size = max_size
        self.overlap = overlap
        self.normalize = normalize

    def _merge_detections(
        self,
        all_polys: list,
        all_texts: list,
        all_raw_texts: list,
        all_scores: list,
        iou_threshold: float = 0.5,
    ) -> TextDetections:
        """Merge detections from multiple tiles, removing duplicates via NMS.

        Args:
            all_polys: list of all polygons from all tiles
            all_texts: list of all normalized texts from all tiles
            all_raw_texts: list of all raw texts from all tiles
            all_scores: list of all scores from all tiles
            iou_threshold: IoU threshold for considering detections as duplicates

        Returns:
            Merged TextDetections with duplicates removed
        """
        if not all_polys:
            return TextDetections(polys=[], texts=[], scores=[], raw_texts=[])

        # Convert polygons to bounding boxes [x, y, width, height]
        boxes = []
        for poly in all_polys:
            pts = np.array(poly)
            x_min, y_min = pts.min(axis=0)
            x_max, y_max = pts.max(axis=0)
            boxes.append([x_min, y_min, x_max - x_min, y_max - y_min])

        indices = cv2.dnn.NMSBoxes(
            boxes, all_scores, score_threshold=0.0, nms_threshold=iou_threshold
        )

        return TextDetections(
            polys=[all_polys[i] for i in indices],
            texts=[all_texts[i] for i in indices],
            scores=[all_scores[i] for i in indices],
            raw_texts=[all_raw_texts[i] for i in indices],
        )

    def _normalize_text(self, text: str) -> str:
        """Normalize text if normalization is enabled."""
        return normalize_to_cyrillic(text) if self.normalize else text

    @abstractmethod
    def _predict_tile(self, image: np.ndarray) -> TextDetections:
        """Predict text in a single tile.

        Args:
            image: BGR image tile

        Returns:
            TextDetections for this tile (raw_texts should contain original text)
        """

    def predict(self, image: np.ndarray) -> TextDetections:
        """Predict texts from image, handling large images via tiling.

        Args:
            image: BGR image (height, width, 3)

        Returns:
            TextDetections with detected texts
        """
        height, width = image.shape[:2]

        # If image is small enough, process directly
        if height <= self.max_size and width <= self.max_size:
            detections = self._predict_tile(image)
            return TextDetections(
                polys=detections.polys,
                texts=[self._normalize_text(t) for t in detections.raw_texts],
                scores=detections.scores,
                raw_texts=detections.raw_texts,
            )

        # Process large image in overlapping tiles
        tiles = get_tiles(height, width, self.max_size, self.overlap)
        logger.info(f"Processing {len(tiles)} tiles")

        all_polys = []
        all_texts = []
        all_raw_texts = []
        all_scores = []

        edge_margin = 5  # pixels from tile edge to consider "touching"

        for i, (x_start, y_start, x_end, y_end) in enumerate(
            tqdm(tiles, desc="Processing tiles")
        ):
            tile = image[y_start:y_end, x_start:x_end]
            tile_h, tile_w = tile.shape[:2]
            start_time = time.time()
            detections = self._predict_tile(tile)
            elapsed = time.time() - start_time
            logger.info(
                f"Tile {i:2d}: ({x_start:5d}, {y_start:5d}) -> ({x_end:5d}, {y_end:5d}) | "
                f"{tile_w}x{tile_h} | {len(detections.raw_texts):3d} texts | {elapsed:.2f}s"
            )

            if not detections.polys:
                continue

            offset = np.array([x_start, y_start])
            for poly, raw_text, score in zip(
                detections.polys, detections.raw_texts, detections.scores
            ):
                pts = np.array(poly)

                # Skip detections touching tile edges (partial detections)
                touches_left = x_start > 0 and pts[:, 0].min() < edge_margin
                touches_right = x_end < width and pts[:, 0].max() > tile_w - edge_margin
                touches_top = y_start > 0 and pts[:, 1].min() < edge_margin
                touches_bottom = (
                    y_end < height and pts[:, 1].max() > tile_h - edge_margin
                )

                if touches_left or touches_right or touches_top or touches_bottom:
                    continue

                adjusted_poly = (pts + offset).tolist()
                all_polys.append(adjusted_poly)
                all_raw_texts.append(raw_text)
                all_texts.append(self._normalize_text(raw_text))
                all_scores.append(score)

        return self._merge_detections(all_polys, all_texts, all_raw_texts, all_scores)


class PaddleOCRDetector(BaseTextDetector):
    """Text detector using PaddleOCR."""

    def __init__(
        self,
        lang: str = "ru",
        max_size: int = 700,
        overlap: int = 300,
        normalize: bool = True,
        device: str = "gpu",
    ):
        """Initialize PaddleOCR detector.

        Args:
            lang: Language for OCR
            max_size: Maximum tile size for large images
            overlap: Overlap between tiles
            normalize: Whether to apply text normalization
            device: Device to use ("gpu" or "cpu")
        """
        super().__init__(max_size=max_size, overlap=overlap, normalize=normalize)

        from paddleocr import PaddleOCR as _PaddleOCR

        self.ocr = _PaddleOCR(
            lang=lang,
            device=device,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=True,
        )

    def _predict_tile(self, image: np.ndarray) -> TextDetections:
        """Predict text in a single tile using PaddleOCR."""
        results = self.ocr.predict(image)[0]

        polys = []
        raw_texts = []
        scores = []

        for poly, text, score in zip(
            results["rec_polys"], results["rec_texts"], results["rec_scores"]
        ):
            # Skip underscore-only detections
            if text.replace("_", "").replace(" ", "") == "":
                continue
            polys.append(poly)
            raw_texts.append(text)
            scores.append(score)

        return TextDetections(polys=polys, texts=[], scores=scores, raw_texts=raw_texts)


def read_geotiff(data) -> np.ndarray:
    """Read a GeoTIFF file and return as BGR image.

    Composites RGBA image onto white background to properly handle transparency.

    Args:
        path: Path to the GeoTIFF file

    Returns:
        BGR image as numpy array (height, width, 3)
    """
    image = reshape_as_image(data.read())

    # Composite RGBA onto white background
    # output = foreground * alpha + background * (1 - alpha)
    alpha = image[:, :, 3:4].astype(np.float32) / 255.0
    rgb = image[:, :, :3].astype(np.float32)
    white_bg = np.full_like(rgb, 255.0)

    composited = rgb * alpha + white_bg * (1.0 - alpha)
    composited = composited.astype(np.uint8)

    # Convert RGB to BGR for OpenCV/PaddleOCR compatibility
    return cv2.cvtColor(composited, cv2.COLOR_RGB2BGR)


def visualize_ocr(image, text_detections, output_path: str, tiles: list | None = None):
    """Visualize OCR detections on an image and save to file.

    Args:
        image: BGR image as numpy array
        text_detections: TextDetections object with polys, texts, and scores
        output_path: Path to save the output image
        tiles: Optional list of (x_start, y_start, x_end, y_end) tile coordinates
    """
    from PIL import Image, ImageDraw, ImageFont

    output = image.copy()

    # Draw polygons with OpenCV
    for bbox in text_detections.polys:
        pts = np.array(bbox, dtype=np.int32)
        cv2.polylines(output, [pts], isClosed=True, color=(0, 0, 255), thickness=1)

    # Convert to PIL for Cyrillic text rendering
    output_rgb = cv2.cvtColor(output, cv2.COLOR_BGR2RGB)
    pil_image = Image.fromarray(output_rgb)
    draw = ImageDraw.Draw(pil_image)

    # Find a font that supports Cyrillic using fontconfig
    import subprocess

    font = None
    try:
        result = subprocess.run(
            ["fc-match", "-f", "%{file}", ":lang=ru"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            font = ImageFont.truetype(result.stdout.strip(), 16)
    except (OSError, subprocess.SubprocessError):
        pass
    if font is None:
        font = ImageFont.load_default()

    for bbox, text in zip(text_detections.polys, text_detections.texts):
        pts = np.array(bbox, dtype=np.int32)
        draw.text((pts[0][0], pts[0][1] - 18), text, font=font, fill=(255, 0, 0))

    # Draw tile boundaries if provided
    if tiles:
        for x_start, y_start, x_end, y_end in tiles:
            draw.rectangle(
                [x_start, y_start, x_end, y_end],
                outline=(0, 255, 0),
                width=2,
            )

    # Convert back to BGR and save
    output = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)
    cv2.imwrite(output_path, output)


def save_text_detections_csv(text_detections, output_path: str, use_raw: bool = False):
    """Save non-numeric text detections to CSV file.

    Args:
        text_detections: TextDetections object
        output_path: Path to save CSV file
        use_raw: If True, use raw_texts instead of normalized texts
    """
    import csv

    texts = text_detections.raw_texts if use_raw else text_detections.texts

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(
            ["text", "confidence", "x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"]
        )

        for poly, text, score in zip(
            text_detections.polys, texts, text_detections.scores
        ):
            # Skip if text is purely numeric
            if text.replace(" ", "").replace(".", "").replace(",", "").isdigit():
                continue

            pts = np.array(poly, dtype=np.int32)
            writer.writerow(
                [
                    text,
                    f"{score:.3f}",
                    pts[0][0],
                    pts[0][1],
                    pts[1][0],
                    pts[1][1],
                    pts[2][0],
                    pts[2][1],
                    pts[3][0],
                    pts[3][1],
                ]
            )
