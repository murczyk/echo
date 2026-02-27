import tempfile
from pathlib import Path

import fire
import imagery24
import rasterio
from loguru import logger

from milocr.ocr import (
    PaddleOCRDetector,
    get_tiles,
    read_geotiff,
    save_text_detections_csv,
    visualize_ocr,
)


def main(src: str, dst: str = "result.png", device: str = "gpu"):
    """Run PaddleOCRDetector on a GeoTIFF file and save visualization.

    Args:
        src: Path to the input GeoTIFF file
        dst: Path to save the output visualization (default: result.png)
        device: Device to use for OCR ("gpu" or "cpu")
    """
    src_path = Path(src)
    dst_path = Path(dst)

    if not src_path.exists():
        logger.error(f"Source file not found: {src_path}")
        return

    with tempfile.TemporaryDirectory() as temp_dir:
        logger.info("pgd detected, converting")
        if src_path.suffix.lower() == ".pgd":
            geotiff = temp_dir / Path(src_path.stem).with_suffix(".tiff")
            imagery24.convert(src, geotiff)
            src_path = geotiff

        logger.info(f"Reading GeoTIFF: {src_path}")
        with rasterio.open(str(src_path)) as data:
            image = read_geotiff(data)
        logger.info(f"Image shape: {image.shape}")

    logger.info(f"Running PaddleOCRDetector (requested device={device})...")
    ocr = PaddleOCRDetector(device=device)
    logger.info(f"PaddleOCRDetector initialized on device={ocr.device}")
    detections = ocr.predict(image)

    logger.info(f"Detected {len(detections.texts)} text regions")
    logger.info(f"Saving visualization to: {dst_path}")

    # Get tiles for visualization
    height, width = image.shape[:2]
    tiles = get_tiles(height, width, ocr.max_size, ocr.overlap)

    dst_path.parent.mkdir(exist_ok=True, parents=True)
    visualize_ocr(image, detections, str(dst_path), tiles=tiles)

    # Save raw text detections (before normalization) to CSV
    raw_csv_path = dst_path.with_stem(dst_path.stem + "_raw").with_suffix(".csv")
    save_text_detections_csv(detections, str(raw_csv_path), use_raw=True)
    logger.info(f"Saved raw text detections to: {raw_csv_path}")

    # Save normalized text detections to CSV
    csv_path = dst_path.with_suffix(".csv")
    save_text_detections_csv(detections, str(csv_path))
    logger.info(f"Saved text detections to: {csv_path}")

    logger.info("Done!")


if __name__ == "__main__":
    fire.Fire(main)
