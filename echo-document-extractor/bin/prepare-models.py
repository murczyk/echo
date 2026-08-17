from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

import yaml

PRODUCTION_ROOT = Path("/opt/echo-document-extractor/models")


def main() -> None:
    parser = argparse.ArgumentParser(description="Download and stage pinned Paddle models")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() and any(args.output.iterdir()):
        parser.error("output directory must be new or empty")
    args.output.mkdir(mode=0o755, parents=True, exist_ok=True)
    args.cache.mkdir(mode=0o755, parents=True, exist_ok=True)
    os.environ["PADDLE_PDX_CACHE_HOME"] = str(args.cache.resolve())

    from paddleocr import PaddleOCR, PPStructureV3

    configs = []
    for language in ("ru", "uk", "en"):
        pipeline = PaddleOCR(lang=language, ocr_version="PP-OCRv5")
        config_path = args.cache / f"ocr-{language}.yaml"
        pipeline.export_paddlex_config_to_yaml(str(config_path))
        configs.append(config_path)
    structure = PPStructureV3()
    structure_path = args.cache / "PP-StructureV3.yaml"
    structure.export_paddlex_config_to_yaml(str(structure_path))
    configs.append(structure_path)

    loaded = [yaml.safe_load(path.read_text(encoding="utf-8")) for path in configs]
    cache_models = args.cache / "official_models"
    materialized = {path.name for path in cache_models.iterdir() if path.is_dir()}
    configured = {name for config in loaded for name in _model_names(config)}
    model_names = sorted(configured & materialized)
    for name in model_names:
        source = cache_models / name
        shutil.copytree(source, args.output / name)
    structure_config = loaded[-1]
    _rewrite_model_dirs(structure_config, materialized)
    (args.output / "PP-StructureV3.yaml").write_text(
        yaml.safe_dump(structure_config, sort_keys=False), encoding="utf-8"
    )


def _model_names(value: object) -> set[str]:
    names: set[str] = set()
    if isinstance(value, dict):
        if isinstance(value.get("model_name"), str):
            names.add(value["model_name"])
        for nested in value.values():
            names.update(_model_names(nested))
    elif isinstance(value, list):
        for nested in value:
            names.update(_model_names(nested))
    return names


def _rewrite_model_dirs(value: object, materialized: set[str]) -> None:
    if isinstance(value, dict):
        name = value.get("model_name")
        if isinstance(name, str) and name in materialized and "model_dir" in value:
            value["model_dir"] = str(PRODUCTION_ROOT / name)
        for nested in value.values():
            _rewrite_model_dirs(nested, materialized)
    elif isinstance(value, list):
        for nested in value:
            _rewrite_model_dirs(nested, materialized)


if __name__ == "__main__":
    main()
