import gc
from pathlib import Path

import fire
import paddle
import rasterio
from loguru import logger
from tqdm import tqdm

from milocr.ocr import (
    PaddleOCRDetector,
    get_tiles,
    read_geotiff,
    save_text_detections_csv,
    visualize_ocr,
)


def process_file(
    src_path: Path, dst_path: Path, ocr: PaddleOCRDetector, visualize: bool = True
) -> bool:
    """Process a single GeoTIFF file with OCR.

    Args:
        src_path: Path to the input GeoTIFF file
        dst_path: Base path for output files (without extension)
        ocr: PaddleOCRDetector instance
        visualize: Whether to save visualization image

    Returns:
        True if successful, False otherwise
    """
    try:
        logger.info(f"Processing: {src_path}")
        with rasterio.open(str(src_path)) as data:
            image = read_geotiff(data)

        detections = ocr.predict(image)
        logger.info(f"  Detected {len(detections.texts)} text regions")

        dst_path.parent.mkdir(exist_ok=True, parents=True)

        if visualize:
            viz_path = dst_path.with_suffix(".png")
            height, width = image.shape[:2]
            tiles = get_tiles(height, width, ocr.max_size, ocr.overlap)
            visualize_ocr(image, detections, str(viz_path), tiles=tiles)
            logger.info(f"  Saved visualization: {viz_path}")

        raw_csv_path = dst_path.with_name(dst_path.stem + "_raw.csv")
        save_text_detections_csv(detections, str(raw_csv_path), use_raw=True)

        csv_path = dst_path.with_suffix(".csv")
        save_text_detections_csv(detections, str(csv_path))
        logger.info(f"  Saved CSV: {csv_path}")

        return True

    except Exception as e:
        logger.error(f"  Error processing {src_path}: {e}")
        raise Exception(f"  Error processing {src_path}: {e}")
        # return False


def main(
    src_dir: str,
    dst_dir: str,
    visualize: bool = True,
    skip_existing: bool = True,
    device: str = "gpu",
):
    """Recursively run PaddleOCRDetector on all GeoTIFF files in a directory.

    Args:
        src_dir: Input directory containing GeoTIFF files
        dst_dir: Output directory (mirrors input structure)
        visualize: Whether to save visualization images (default: True)
        skip_existing: Skip files if output already exists (default: True).
                       Set to False to overwrite existing files.
        device: Device to use for OCR ("gpu" or "cpu")
    """
    src_path = Path(src_dir).resolve()
    dst_path = Path(dst_dir).resolve()

    if not src_path.exists():
        logger.error(f"Source directory not found: {src_path}")
        return

    if not src_path.is_dir():
        logger.error(f"Source path is not a directory: {src_path}")
        return

    logger.info(f"Source directory: {src_path}")
    logger.info(f"Output directory: {dst_path}")
    logger.info(f"Device: {device}")

    files = [f for f in src_path.rglob("*.geotiff") if f.is_file()]

    if not files:
        logger.warning(f"No matching files found in {src_path}")
        return

    logger.info(f"Found {len(files)} files to process")

    logger.info("Initializing PaddleOCRDetector...")
    ocr = PaddleOCRDetector(device=device)

    success_count = 0
    fail_count = 0
    skipped_count = 0

    for src_file in tqdm(sorted(files), desc="Processing files"):
        rel_path = src_file.relative_to(src_path)
        dst_file = dst_path / rel_path.with_suffix("")

        if skip_existing:
            csv_path = dst_file.with_suffix(".csv")
            if csv_path.exists():
                logger.debug(f"Skipping (exists): {src_file}")
                skipped_count += 1
                continue

        if process_file(src_file, dst_file, ocr, visualize=visualize):
            success_count += 1
        else:
            fail_count += 1

        # Clear GPU memory after each file (only if OCR actually runs on GPU)
        if getattr(ocr, "device", None) == "gpu":
            gc.collect()
            paddle.device.cuda.empty_cache()

    logger.info(
        f"Done! Processed {success_count} files, "
        f"{skipped_count} skipped, {fail_count} failed"
    )


if __name__ == "__main__":
    fire.Fire(main)
