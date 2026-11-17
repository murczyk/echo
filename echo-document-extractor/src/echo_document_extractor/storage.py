from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import time
import uuid
from pathlib import Path, PurePosixPath

from .ingest import image_page_count
from .pipeline import InputManifest


class StoragePressureError(RuntimeError):
    pass


class SpoolStorage:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = asyncio.Lock()
        self._sample: tuple[int, int] | None = None
        self._measured_at = 0.0

    async def usage(self, max_age: float = 0.0) -> tuple[int, int]:
        earliest = time.monotonic() - max_age
        async with self._lock:
            if self._sample is None or self._measured_at < earliest:
                started = time.monotonic()
                sample = await asyncio.to_thread(self._measure)
                self._sample = sample
                self._measured_at = started
            return self._sample

    def _measure(self) -> tuple[int, int]:
        self.path.mkdir(mode=0o700, parents=True, exist_ok=True)
        return directory_size(self.path), shutil.disk_usage(self.path).free

    async def ensure_capacity(self, max_bytes: int, min_free_bytes: int) -> None:
        used, free = await self.usage()
        _check_capacity(used, free, max_bytes, min_free_bytes)


def safe_upload_name(value: str | None) -> str:
    if not value or value != PurePosixPath(value).name or "\\" in value or value in {".", ".."}:
        raise ValueError("upload filename must be a plain relative filename")
    return value


def parse_manifest(value: str | None, filenames: list[str]) -> dict[str, object] | None:
    if value is None:
        if len(filenames) > 1:
            raise ValueError("manifest is required for multiple files")
        return None
    try:
        parsed = InputManifest.model_validate(json.loads(value))
    except (json.JSONDecodeError, ValueError) as error:
        raise ValueError("manifest must be valid InputManifest JSON") from error
    if parsed.inputs != filenames:
        raise ValueError("manifest inputs must exactly match uploaded files in order")
    return parsed.model_dump(mode="json")


def count_pages(path: Path) -> int:
    if path.suffix.casefold() == ".pdf":
        try:
            import pypdfium2 as pdfium

            document = pdfium.PdfDocument(str(path))
            count = len(document)
            document.close()
        except Exception as error:
            raise ValueError(f"unreadable PDF: {path.name}") from error
        if count < 1:
            raise ValueError(f"PDF contains no pages: {path.name}")
        return count
    if path.suffix.casefold() not in {".png", ".jpg", ".jpeg"}:
        raise ValueError(f"unsupported input: {path.name}")
    return image_page_count(path)


def request_digest(files: list[tuple[str, str]], manifest: dict[str, object] | None) -> str:
    digest = hashlib.sha256()
    for name, file_digest in files:
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update(file_digest.encode())
        digest.update(b"\0")
    digest.update(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode())
    return digest.hexdigest()


def directory_size(path: Path) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except FileNotFoundError:
                continue
    return total


def ensure_capacity(spool_dir: Path, max_bytes: int, min_free_bytes: int) -> tuple[int, int]:
    spool_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    used = directory_size(spool_dir)
    free = shutil.disk_usage(spool_dir).free
    _check_capacity(used, free, max_bytes, min_free_bytes)
    return used, free


def _check_capacity(used: int, free: int, max_bytes: int, min_free_bytes: int) -> None:
    if used >= max_bytes:
        raise StoragePressureError("spool capacity limit reached")
    if free < min_free_bytes:
        raise StoragePressureError("spool filesystem free-space floor reached")


def remove_job_directory(spool_dir: Path, job_id: str) -> None:
    uuid.UUID(job_id)
    target = spool_dir / job_id
    if target.parent.resolve() != spool_dir.resolve():
        raise ValueError("unsafe job directory")
    shutil.rmtree(target, ignore_errors=True)
