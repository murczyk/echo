#!/usr/bin/env python3

import argparse
from pathlib import Path
import sys


GENERATED_FIELD = '''    #[sea_orm(column_type = "custom(\\"ltree\\")")]
    pub hierarchy_path: String,
'''
PATCHED_FIELD = '''    #[sea_orm(
        column_type = "custom(\\"ltree\\")",
        select_as = "text",
        save_as = "ltree"
    )]
    pub hierarchy_path: String,
'''


def fail(message: str) -> None:
    raise ValueError(message)


def patch_file_entry(entity_dir: Path) -> None:
    entity_dir = entity_dir.resolve()
    file_entry = (entity_dir / "file_entry.rs").resolve()
    if file_entry.parent != entity_dir:
        fail(f"file_entry.rs must be directly inside {entity_dir}")
    if not file_entry.is_file():
        fail(f"file_entry entity not found: {file_entry}")

    source = file_entry.read_text()
    field_count = source.count("pub hierarchy_path: String,")
    if field_count != 1:
        fail(
            "file_entry.rs must contain exactly one hierarchy_path: String field; "
            f"found {field_count}"
        )

    generated_count = source.count(GENERATED_FIELD)
    patched_count = source.count(PATCHED_FIELD)
    if generated_count == 1 and patched_count == 0:
        file_entry.write_text(source.replace(GENERATED_FIELD, PATCHED_FIELD, 1))
        return
    if generated_count == 0 and patched_count == 1:
        return
    fail(
        "file_entry.rs has an unexpected hierarchy_path annotation; expected exactly "
        "one generated or already-patched ltree field"
    )


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--entity-dir",
        type=Path,
        default=repo_root / "wdintel-rs/src/file_registry/entities",
    )
    args = parser.parse_args()
    try:
        patch_file_entry(args.entity_dir)
    except ValueError as error:
        print(f"patch_seaorm_files.py: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
