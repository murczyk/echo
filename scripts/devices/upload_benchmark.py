#!/usr/bin/env python3
"""Upload files/audio over real Echo TUS and measure sync/async finalization."""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
from http.cookies import SimpleCookie
import io
import json
import math
import mimetypes
import os
from pathlib import Path
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave


def checked_location(location, base):
    parsed, origin = urllib.parse.urlsplit(location), urllib.parse.urlsplit(base)
    if location.startswith("//") or (parsed.scheme or parsed.netloc) and (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc):
        raise ValueError("Upload Location must belong to the authenticated API origin")
    if not parsed.path.startswith("/") or parsed.fragment:
        raise ValueError("Invalid upload Location")
    return urllib.parse.urlunsplit(("", "", parsed.path, parsed.query, ""))


def terminal_result(snapshot):
    if snapshot["status"] == "failed":
        raise RuntimeError(f"Finalization failed: {snapshot.get('error')}")
    if snapshot["status"] == "completed":
        if not isinstance(snapshot.get("result"), dict):
            raise ValueError("Completed job has no publication receipt")
        return snapshot["result"]
    if snapshot["status"] not in ("queued", "processing", "retry_wait", "outcome_unknown"):
        raise ValueError("Unknown finalization status")
    return None


def distribution(values):
    values = sorted(values)
    return {"mean": sum(values) / len(values), **{f"p{p}": values[max(0, math.ceil(len(values) * p / 100) - 1)]
                                              for p in (50, 95, 99)}, "max": values[-1]}


def summarize(rows, elapsed):
    succeeded = [row for row in rows if row["ok"]]
    result = dict(attempted=len(rows), succeeded=len(succeeded), failed=len(rows) - len(succeeded),
                  elapsed_seconds=elapsed, bytes=sum(row["bytes"] for row in succeeded),
                  operations_per_second=len(succeeded) / elapsed,
                  mib_per_second=sum(row["bytes"] for row in succeeded) / 1048576 / elapsed)
    for field in ("upload_seconds", "ack_seconds", "publication_seconds", "server_job_seconds", "verification_seconds", "total_seconds"):
        values = [row[field] for row in succeeded if field in row]
        if values:
            result[field] = distribution(values)
    result["errors"] = [row for row in rows if not row["ok"]]
    observed = [row["ack_seconds"] for row in rows if "ack_seconds" in row]
    if observed:
        result["ack_seconds_including_rejections"] = distribution(observed)
    return result


class HttpFailure(RuntimeError):
    def __init__(self, method, path, status, body):
        super().__init__(f"{method} {path}: HTTP {status}: {body[:600].decode(errors='replace')}")
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


class Client:
    def __init__(self, base, cookie="", timeout=180):
        self.base, self.cookie, self.timeout = base.rstrip("/"), cookie, timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path, value=None, method="POST", headers=None, expected=(200,)):
        path = checked_location(path, self.base)
        headers = {**(headers or {}), **({"Cookie": self.cookie} if self.cookie else {})}
        if isinstance(value, dict):
            value = json.dumps(value).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=value, method=method, headers=headers)
        try:
            response = self.opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body, status = response.read(), response.status
            headers = {key.lower(): value for key, value in response.headers.items()}
        if status not in expected:
            raise HttpFailure(method, path, status, body)
        result = json.loads(body) if body and "json" in headers.get("content-type", "") else body
        return status, result, headers

    def login(self, credentials):
        _, _, headers = self.request("/api/user/test-api-login", credentials)
        cookie = SimpleCookie()
        cookie.load(headers.get("set-cookie", ""))
        if "id" not in cookie:
            raise RuntimeError("Login did not issue a session cookie")
        self.cookie = "id=" + cookie["id"].value


def payload(kind, size, seed):
    if kind == "file":
        return hashlib.shake_256(seed).digest(size)
    if size < 46 or (size - 44) % 2:
        raise ValueError("WAV size must be at least 46 bytes and have whole 16-bit samples")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8000)
        wav.writeframes(hashlib.shake_256(seed).digest(size - 44))
    return output.getvalue()


def prepare_upload(client, device, kind, data, digest, name, suffix=".bin"):
    if kind == "file":
        _, sync, _ = client.request("/api/device/files/sync", {"device_id": device, "files": [{
            "absolute_path": f"C:\\benchmark\\{name}{suffix}", "mime_type": mimetypes.guess_type("source" + suffix)[0] or "application/octet-stream", "extension": suffix.lstrip("."),
            "file_metadata_created_at": None, "file_metadata_modified_at": datetime.now(timezone.utc).isoformat(),
            "source_file_state": None}]})
        file = sync["results"][0]["file"]
        path = f"/api/device/files/{device}/{file['file_id']}/revisions/{file['revision']}/content-uploads"
        metadata = {"Upload-Metadata": "sha256 " + base64.b64encode(bytes.fromhex(digest)).decode()}
    else:
        path, metadata, file = f"/api/device/audio/{device}/uploads", {}, None
    _, _, headers = client.request(path, headers={"Tus-Resumable": "1.0.0", "Upload-Length": str(len(data)), **metadata}, expected=(201,))
    return checked_location(headers["location"], client.base), file


def transfer(client, location, data, chunk_bytes):
    for offset in range(0, len(data), chunk_bytes):
        chunk = data[offset:offset + chunk_bytes]
        _, _, headers = client.request(location, chunk, "PATCH", {"Tus-Resumable": "1.0.0", "Upload-Offset": str(offset),
                                                                 "Content-Type": "application/offset+octet-stream"}, (204,))
        if int(headers["upload-offset"]) != offset + len(chunk):
            raise RuntimeError("TUS PATCH acknowledged an incorrect offset")
    _, _, headers = client.request(location, method="HEAD", headers={"Tus-Resumable": "1.0.0"}, expected=(204,))
    if int(headers["upload-offset"]) != len(data):
        raise RuntimeError("TUS upload is incomplete")


def finalize(client, device, kind, mode, location, name, timeout, row, suffix=".wav"):
    body = {"async_finalization": True} if mode == "async" else {}
    path = location + "/complete"
    if kind == "audio":
        path = "/api/device/audio/receive"
        body.update(device_id=device, upload_url=location, name=f"{name}{suffix}", recording_started_at="2026-10-01T10:00:00Z")
    begin = time.monotonic()
    try:
        status, result, _ = client.request(path, body, headers={"Tus-Resumable": "1.0.0"},
                                         expected=(202,) if mode == "async" else ((200,) if kind == "file" else (201,)))
        row["ack_http_status"] = status
    except HttpFailure as error:
        row["ack_http_status"] = error.status
        raise
    finally:
        row["ack_seconds"] = time.monotonic() - begin
    if mode == "async":
        if result["status"] != "queued":
            raise ValueError("202 response is not queued")
        row["job_id"] = str(uuid.UUID(result["job_id"]))
        deadline = begin + timeout
        while time.monotonic() < deadline:
            _, snapshot, headers = client.request(f"/api/device/upload-finalization-jobs/{row['job_id']}", method="GET")
            result = terminal_result(snapshot)
            if result is not None:
                row["server_job_seconds"] = (datetime.fromisoformat(snapshot["finished_at"]) - datetime.fromisoformat(snapshot["created_at"])).total_seconds()
                break
            time.sleep(min(max(0.05, float(headers.get("retry-after", snapshot.get("retry_after_seconds") or 1))),
                           max(0, deadline - time.monotonic())))
        else:
            raise TimeoutError("Job did not reach completed before deadline")
    row["publication_seconds"] = time.monotonic() - begin
    return result


def verify(client, device, kind, file, result, digest, row):
    begin = time.monotonic()
    if kind == "file":
        path = f"/api/device/files/{device}/{file['file_id']}/revisions/{file['revision']}/content"
        _, content, _ = client.request(path, method="GET")
        if hashlib.sha256(content).hexdigest() != digest:
            raise RuntimeError("Published file download SHA-256 mismatch")
        row.update(file_id=file["file_id"], revision=file["revision"], verification="download_sha256")
    else:
        audio = result["audio"]
        _, details, _ = client.request("/api/device/audio/detail", {"device_id": device, "audio_id": audio["id"]})
        if details["audio"]["id"] != audio["id"]:
            raise RuntimeError("Audio publication is not visible")
        row.update(audio_id=audio["id"], verification="audio_detail")
    row["verification_seconds"] = time.monotonic() - begin


def operation(args, cookie, device, ordinal):
    name = f"{args.run_id}-{ordinal}"
    size = args.sizes[ordinal % len(args.sizes)]
    row = dict(ordinal=ordinal, kind=args.kind, mode=args.mode, bytes=size, device_id=device, ok=False)
    started = time.monotonic()
    try:
        if shutil.disk_usage(args.output.parent).free < args.min_free_gib * 1024 ** 3:
            raise RuntimeError("Benchmark disk headroom floor reached")
        data = args.input.read_bytes() if args.input else payload(args.kind, size, name.encode())
        row["bytes"] = len(data)
        digest = hashlib.sha256(data).hexdigest()
        row["sha256"] = digest
        client = Client(args.base_url, cookie, args.timeout)
        suffix = args.input.suffix if args.input else (".wav" if args.kind == "audio" else ".bin")
        location, file = prepare_upload(client, device, args.kind, data, digest, name, suffix)
        row.update(upload_url=location, name=name, suffix=suffix)
        row["upload_id"] = location.rsplit("/", 1)[-1].split(".", 1)[0]
        begin = time.monotonic()
        transfer(client, location, data, args.chunk_bytes)
        row["upload_seconds"] = time.monotonic() - begin
        del data
        result = finalize(client, device, args.kind, args.mode, location, name, args.timeout, row, suffix)
        verify(client, device, args.kind, file, result, digest, row)
        row["ok"] = True
    except Exception as error:
        row["error"] = f"{type(error).__name__}: {error}"
    row["total_seconds"] = time.monotonic() - started
    return row


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--credentials", type=Path, required=True, help="Private JSON containing user/password")
    parser.add_argument("--kind", choices=("file", "audio"), required=True)
    parser.add_argument("--mode", choices=("sync", "async"), required=True)
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--sizes", type=lambda value: [int(item) for item in value.split(",")], default=[32768])
    parser.add_argument("--input", type=Path, help="Upload an actual local file instead of generated data")
    parser.add_argument("--chunk-bytes", type=int, default=1048576)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--min-free-gib", type=float, default=2)
    parser.add_argument("--output", type=Path, required=True, help="New JSONL result path; never overwritten")
    args = parser.parse_args()
    if min(args.count, args.concurrency, args.chunk_bytes, args.timeout) <= 0 or min(args.sizes) < 0:
        parser.error("Counts, concurrency, chunk and timeout must be positive; sizes non-negative")
    args.run_id = uuid.uuid4().hex
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists() or args.output.with_suffix(".summary.json").exists():
        parser.error("Output already exists")
    client = Client(args.base_url, timeout=args.timeout)
    client.login(json.loads(args.credentials.read_text()))
    _, device, _ = client.request("/api/device/create", {"name": f"benchmark-{args.run_id}"})
    rows, begin = [], time.monotonic()
    with args.output.open("x") as output, ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures = [executor.submit(operation, args, client.cookie, device["id"], ordinal) for ordinal in range(args.count)]
        for future in as_completed(futures):
            row = future.result()
            rows.append(row)
            output.write(json.dumps(row) + "\n")
            output.flush()
            if len(rows) % 50 == 0 or not row["ok"]:
                print(json.dumps({"finished": len(rows), "failed": sum(not entry["ok"] for entry in rows)}), flush=True)
    summary = summarize(rows, time.monotonic() - begin)
    summary.update(kind=args.kind, mode=args.mode, concurrency=args.concurrency, sizes=args.sizes,
                   run_id=args.run_id, device_id=device["id"], timestamp=datetime.now(timezone.utc).isoformat(),
                   throughput_scope="closed-loop upload + finalization + polling + verification; excludes login/device creation")
    args.output.with_suffix(".summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary), flush=True)
    raise SystemExit(1 if summary["failed"] else 0)


if __name__ == "__main__":
    main()
