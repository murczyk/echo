from __future__ import annotations

import json
from pathlib import Path

import pytest

from echo_document_extractor.model_store import (
    create_manifest,
    load_manifest,
    materialize,
    missing_objects,
    prime_objects,
    verify_model_set,
)


def test_model_store_reuses_verified_source_files(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    (source / "config.yaml").write_text("model: local\n", encoding="utf-8")
    directory = source / "recognizer"
    directory.mkdir()
    (directory / "weights.pdparams").write_bytes(b"weights")
    manifest_path = tmp_path / "manifest.json"

    created = create_manifest(source, manifest_path)
    loaded = load_manifest(manifest_path)

    assert loaded == created
    objects = tmp_path / "objects"
    assert prime_objects(loaded, source, objects) == 2
    assert missing_objects(loaded, objects) == []
    destination = tmp_path / "set"
    materialize(loaded, objects, destination)
    verify_model_set(loaded, destination)
    assert (destination / "SHA256SUMS").is_file()
    assert (destination / "manifest.json").is_file()


def test_model_manifest_rejects_traversal(tmp_path: Path) -> None:
    manifest = {
        "schema_version": 1,
        "model_set": "0" * 64,
        "files": [{"path": "../weights", "sha256": "0" * 64, "size": 1}],
    }
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="unsafe manifest path"):
        load_manifest(path)
