from __future__ import annotations

import hashlib
import json
import os
import shutil
import zipfile
from pathlib import Path, PurePosixPath

from .validation import validate_package


def create_package_zip(package_dir: Path, destination: Path) -> None:
    errors = validate_package(package_dir)
    if errors:
        raise ValueError("invalid canonical package: " + "; ".join(errors[:5]))
    temporary = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for source in sorted(path for path in package_dir.rglob("*") if path.is_file()):
                relative = source.relative_to(package_dir).as_posix()
                info = zipfile.ZipInfo(relative, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100600 << 16
                with source.open("rb") as input_file, archive.open(info, "w") as output_file:
                    shutil.copyfileobj(input_file, output_file, length=1024 * 1024)
        os.chmod(temporary, 0o600)
        validate_package_zip(temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def validate_package_zip(path: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("ZIP contains duplicate members")
        for name in names:
            value = PurePosixPath(name)
            if value.is_absolute() or any(part in {"", ".", ".."} for part in value.parts):
                raise ValueError("ZIP contains an unsafe member")
            if archive.getinfo(name).is_dir():
                raise ValueError("ZIP contains unexpected directory members")
        required = {"manifest.json", "quality.json", "provenance.json", "document.html", "document.md"}
        if not required.issubset(names):
            raise ValueError("ZIP does not contain a canonical package")
        manifest = json.loads(archive.read("manifest.json"))
        for relative, expected in manifest.get("file_hashes", {}).items():
            if relative not in names:
                raise ValueError(f"ZIP is missing package member: {relative}")
            digest = hashlib.sha256()
            with archive.open(relative) as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
            if digest.hexdigest() != expected:
                raise ValueError(f"ZIP member checksum mismatch: {relative}")
