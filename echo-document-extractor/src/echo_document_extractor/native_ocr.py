"""Optional existing OCR service for an isolated native-document worker."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import time
import zipfile
from pathlib import Path

import httpx


class StorageAdmissionFailure(RuntimeError):
    pass


async def extract(path: Path, key: str, manifest: dict) -> tuple[str, str] | None:
    base = os.environ.get("ECHO_NATIVE_OCR_BASE_URL", "").rstrip("/")
    if not base:
        return None
    token = os.environ["ECHO_NATIVE_OCR_TOKEN"]
    headers = {"Authorization": f"Bearer {token}", "Idempotency-Key": key}
    async with httpx.AsyncClient(timeout=120) as client:
        data = {}
        if manifest.get("ocr"):
            data["manifest"] = json.dumps(
                {"schema_version": 2, "inputs": [path.name], "ocr": manifest["ocr"]}
            )
        with path.open("rb") as source:
            response = await client.post(
                f"{base}/v1/jobs",
                headers=headers,
                files={"files": (path.name, source, "application/octet-stream")},
                data=data,
            )
        if response.status_code == 507:
            raise StorageAdmissionFailure("embedded OCR submission rejected: HTTP 507")
        response.raise_for_status()
        identifier = response.json()["id"]
        deadline = time.monotonic() + 3600
        while time.monotonic() < deadline:
            response = await client.get(f"{base}/v1/jobs/{identifier}", headers=headers)
            response.raise_for_status()
            state = response.json()
            if state["state"] in {"failed", "cancelled"}:
                raise RuntimeError(f"embedded OCR {state['state']}")
            if state["state"] == "completed":
                chunks = bytearray()
                async with client.stream(
                    "GET", f"{base}/v1/jobs/{identifier}/result", headers=headers
                ) as result:
                    result.raise_for_status()
                    async for part in result.aiter_bytes():
                        chunks.extend(part)
                        if len(chunks) > 250 * 1024**2:
                            raise ValueError("embedded OCR result limit")
                with zipfile.ZipFile(io.BytesIO(chunks)) as archive:
                    entry = archive.getinfo("document.html")
                    if entry.file_size > 20 * 1024**2:
                        raise ValueError("embedded OCR HTML limit")
                    content = archive.read(entry)
                    manifest_entry = archive.getinfo("manifest.json")
                    if manifest_entry.file_size > 1024**2:
                        raise ValueError("embedded OCR manifest limit")
                    manifest = json.loads(archive.read(manifest_entry))
                    if manifest["file_hashes"].get("document.html") != hashlib.sha256(content).hexdigest():
                        raise ValueError("embedded OCR checksum mismatch")
                    return content.decode("utf-8"), state["quality_status"]
            await asyncio.sleep(5)
    raise TimeoutError("embedded OCR timed out")
