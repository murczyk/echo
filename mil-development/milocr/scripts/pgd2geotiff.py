from pathlib import Path

import fire
import imagery24
from loguru import logger

LOG_DIR = Path("logs")
LOG_DIR.mkdir(exist_ok=True)

logger.add(LOG_DIR / "app_{time:YYYY-MM-DD_HH-mm-ss}.log", level="ERROR", enqueue=True)


def pgd2geotiff(src: Path, dst: Path, skip_existing: bool = True) -> None:
    src, dst = Path(src), Path(dst)
    for dir, _, filenames in src.walk():
        for filename in filenames:
            if Path(filename).suffix.lower() != ".pgd":
                continue
            src_path = dir / filename
            dst_path = (dst / dir.relative_to(src) / filename).with_suffix(".geotiff")
            dst_path.parent.mkdir(exist_ok=True, parents=True)
            if dst_path.exists() and skip_existing:
                continue
            logger.info(f"Converting [{src_path}] to [{dst_path}]")
            try:
                imagery24.convert(src_path, dst_path)
            except Exception as e:
                logger.error(f"Couldn't convert [{src_path}] with exception [{e}]")


if __name__ == "__main__":
    fire.Fire(pgd2geotiff)
