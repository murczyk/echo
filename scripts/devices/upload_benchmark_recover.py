#!/usr/bin/env python3
"""Retry already uploaded sources after benchmark rejections, keeping original metrics."""

import argparse
import json
import os
from pathlib import Path
import time
import uuid

import upload_benchmark_stand as stand
from upload_benchmark import Client, finalize, summarize, verify


def finish_pending_audio(client, location, row):
    status, _, headers = client.request(location, b"", method="PATCH", headers={
        "Tus-Resumable": "1.0.0", "Upload-Offset": str(row["bytes"]),
        "Content-Type": "application/offset+octet-stream"}, expected=(204, 404))
    row["tus_completion_http_status"] = status
    if status == 204:
        stand.shared.require(int(headers["upload-offset"]) == row["bytes"], "TUS completion changed the offset")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--results", required=True, action="append", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--mode", choices=("sync", "async"), help="Explicitly change mode for rejected, unaccepted sources")
    args = parser.parse_args()
    root, state = stand.load(args.root)
    client = Client(f"http://127.0.0.1:{state['api_a_port']}")
    client.login(json.loads((root / "credentials.json").read_text()))
    rows, skipped, started = [], 0, time.monotonic()
    with args.output.open("x") as output:
        for directory in args.results:
            for path in sorted(directory.glob("*.summary.json")):
                summary = json.loads(path.read_text())
                for previous in summary["errors"]:
                    if "upload_id" not in previous:
                        skipped += 1
                        continue
                    row = {key: value for key, value in previous.items() if key not in ("error", "ok")}
                    for key in tuple(row):
                        if key.endswith("_seconds"):
                            row.pop(key)
                    row.update(ok=False, recovery=True, original_error=previous["error"])
                    if args.mode:
                        row.update(original_mode=row["mode"], mode=args.mode)
                    attempt_started = time.monotonic()
                    try:
                        upload = str(uuid.UUID(row["upload_id"]))
                        device, kind = row["device_id"], row["kind"]
                        name = row.get("name") or f"{summary['run_id']}-{row['ordinal']}"
                        if kind == "file":
                            location = f"/api/device/file-content-uploads/{upload}"
                            file = json.loads(stand.shared.sql(root, state,
                                f"SELECT json_build_object('file_id',file_id,'revision',revision) FROM file_content_upload WHERE id='{upload}';",
                                state["files_db"]))
                        else:
                            location, file = f"/api/device/audio/{device}/uploads/{upload}.{row['bytes']}", None
                        _, _, headers = client.request(location, method="HEAD", headers={"Tus-Resumable": "1.0.0"}, expected=(204,))
                        stand.shared.require(int(headers["upload-offset"]) == row["bytes"], "Source was not fully uploaded")
                        if kind == "audio" and "upload_seconds" not in previous and "job_id" not in previous:
                            finish_pending_audio(client, location, row)
                        result = finalize(client, device, kind, row["mode"], location, name, 300, row, row.get("suffix", ".wav"))
                        verify(client, device, kind, file, result, row["sha256"], row)
                        row["ok"] = True
                    except Exception as error:
                        row["error"] = f"{type(error).__name__}: {error}"
                    row["total_seconds"] = time.monotonic() - attempt_started
                    rows.append(row)
                    output.write(json.dumps(row) + "\n")
                    output.flush()
                    if len(rows) % 50 == 0:
                        print(f"Recovered {len(rows)} sources; failures={sum(not item['ok'] for item in rows)}", flush=True)
    result = summarize(rows, time.monotonic() - started)
    result["skipped_before_transfer"] = skipped
    result["scope"] = "sequential finalization retry; original transfer and metrics remain unchanged"
    args.output.with_suffix(".summary.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ("attempted", "succeeded", "failed", "elapsed_seconds")}), flush=True)
    raise SystemExit(1 if result["failed"] else 0)


if __name__ == "__main__":
    main()
