from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import shutil
from pathlib import Path, PurePosixPath

MANIFEST_NAME = "manifest.json"
CHECKSUMS_NAME = "SHA256SUMS"
SCHEMA_VERSION = 1


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_path(value: object) -> PurePosixPath:
    if not isinstance(value, str):
        raise ValueError("manifest path must be a string")
    if any(character in value for character in "\r\n\t"):
        raise ValueError(f"unsafe manifest path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"unsafe manifest path: {value!r}")
    if path.name in {MANIFEST_NAME, CHECKSUMS_NAME}:
        raise ValueError(f"reserved manifest path: {value!r}")
    return path


def _files_hash(files: list[dict[str, object]]) -> str:
    encoded = json.dumps(files, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    return hashlib.sha256(encoded).hexdigest()


def load_manifest(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("unsupported model manifest schema")
    files = value.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("model manifest has no files")
    previous = ""
    normalized: list[dict[str, object]] = []
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("invalid model manifest file entry")
        relative = _safe_path(item.get("path")).as_posix()
        digest = item.get("sha256")
        size = item.get("size")
        if relative <= previous:
            raise ValueError("model manifest paths must be unique and sorted")
        if not isinstance(digest, str) or len(digest) != 64:
            raise ValueError(f"invalid SHA-256 for {relative}")
        try:
            bytes.fromhex(digest)
        except ValueError as error:
            raise ValueError(f"invalid SHA-256 for {relative}") from error
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            raise ValueError(f"invalid size for {relative}")
        normalized.append({"path": relative, "sha256": digest.lower(), "size": size})
        previous = relative
    expected = _files_hash(normalized)
    if value.get("model_set") != expected:
        raise ValueError("model manifest set hash does not match its files")
    return {"schema_version": SCHEMA_VERSION, "model_set": expected, "files": normalized}


def create_manifest(source: Path, output: Path) -> dict[str, object]:
    files = []
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"model source contains a symbolic link: {path}")
        if not path.is_file() or path.name in {MANIFEST_NAME, CHECKSUMS_NAME}:
            continue
        if path.stat().st_size <= 0:
            raise ValueError(f"model source contains an empty file: {path}")
        relative = path.relative_to(source).as_posix()
        _safe_path(relative)
        files.append({"path": relative, "sha256": _sha256(path), "size": path.stat().st_size})
    if not files:
        raise ValueError("model source contains no files")
    manifest = {"schema_version": SCHEMA_VERSION, "model_set": _files_hash(files), "files": files}
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def _valid_object(path: Path, digest: str, size: int) -> bool:
    return path.is_file() and path.stat().st_size == size and _sha256(path) == digest


def prime_objects(manifest: dict[str, object], source: Path, objects: Path) -> int:
    objects.mkdir(mode=0o755, parents=True, exist_ok=True)
    primed = 0
    for item in manifest["files"]:
        path = source / str(item["path"])
        target = objects / str(item["sha256"])
        if _valid_object(target, str(item["sha256"]), int(item["size"])):
            continue
        if not _valid_object(path, str(item["sha256"]), int(item["size"])):
            continue
        _link_or_copy(path, target)
        target.chmod(0o444)
        primed += 1
    return primed


def missing_objects(manifest: dict[str, object], objects: Path) -> list[dict[str, object]]:
    return [
        item
        for item in manifest["files"]
        if not _valid_object(objects / str(item["sha256"]), str(item["sha256"]), int(item["size"]))
    ]


def _link_or_copy(source: Path, target: Path) -> None:
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        os.link(source, temporary)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        shutil.copy2(source, temporary)
    os.replace(temporary, target)


def materialize(manifest: dict[str, object], objects: Path, destination: Path) -> None:
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("model-set destination must be new or empty")
    destination.mkdir(mode=0o755, parents=True, exist_ok=True)
    checksum_lines = []
    for item in manifest["files"]:
        source = objects / str(item["sha256"])
        if not _valid_object(source, str(item["sha256"]), int(item["size"])):
            raise ValueError(f"model object is missing or corrupt: {item['sha256']}")
        target = destination / str(item["path"])
        target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        _link_or_copy(source, target)
        target.chmod(0o444)
        checksum_lines.append(f"{item['sha256']}  ./{item['path']}\n")
    (destination / MANIFEST_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (destination / CHECKSUMS_NAME).write_text("".join(checksum_lines), encoding="utf-8")
    (destination / MANIFEST_NAME).chmod(0o444)
    (destination / CHECKSUMS_NAME).chmod(0o444)


def verify_model_set(manifest: dict[str, object], root: Path) -> None:
    for item in manifest["files"]:
        path = root / str(item["path"])
        if not _valid_object(path, str(item["sha256"]), int(item["size"])):
            raise ValueError(f"model file is missing or corrupt: {item['path']}")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage immutable extractor model sets")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("--source", type=Path, required=True)
    create.add_argument("--output", type=Path, required=True)
    identify = commands.add_parser("id")
    identify.add_argument("--manifest", type=Path, required=True)
    prime = commands.add_parser("prime")
    prime.add_argument("--manifest", type=Path, required=True)
    prime.add_argument("--source", type=Path, required=True)
    prime.add_argument("--objects", type=Path, required=True)
    missing = commands.add_parser("missing")
    missing.add_argument("--manifest", type=Path, required=True)
    missing.add_argument("--objects", type=Path, required=True)
    materialize_parser = commands.add_parser("materialize")
    materialize_parser.add_argument("--manifest", type=Path, required=True)
    materialize_parser.add_argument("--objects", type=Path, required=True)
    materialize_parser.add_argument("--destination", type=Path, required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("--manifest", type=Path, required=True)
    verify.add_argument("--root", type=Path, required=True)
    return parser


def main() -> None:
    args = _parser().parse_args()
    if args.command == "create":
        manifest = create_manifest(args.source, args.output)
        print(manifest["model_set"])
    elif args.command == "id":
        print(load_manifest(args.manifest)["model_set"])
    elif args.command == "prime":
        print(prime_objects(load_manifest(args.manifest), args.source, args.objects))
    elif args.command == "missing":
        for item in missing_objects(load_manifest(args.manifest), args.objects):
            print(f"{item['sha256']}\t{item['size']}\t{item['path']}")
    elif args.command == "materialize":
        materialize(load_manifest(args.manifest), args.objects, args.destination)
    elif args.command == "verify":
        verify_model_set(load_manifest(args.manifest), args.root)


if __name__ == "__main__":
    main()
