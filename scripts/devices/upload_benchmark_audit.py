#!/usr/bin/env python3
"""Read-only DB/S3 integrity and cleanup audit after upload benchmarks.

Requires cryptography and boto3 (available in the repository's test-storage venv).
"""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import time
import tomllib

import upload_benchmark_stand as stand
from upload_benchmark import Client, distribution


def decrypt_strongbox(data, key, context):
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
    if data[:4] != bytes.fromhex("b1b8f583"):
        raise ValueError("Unsupported strong-box envelope")
    fields, cursor = [], 4
    for _ in range(3):
        marker = data[cursor]
        cursor += 1
        if not 0x40 <= marker <= 0x5b:
            raise ValueError("Expected a definite CBOR byte string")
        size = marker & 31
        if size >= 24:
            width = 1 << (size - 24)
            size = int.from_bytes(data[cursor:cursor + width], "big")
            cursor += width
        fields.append(data[cursor:cursor + size])
        cursor += size
    kid, nonce, ciphertext = fields
    if cursor != len(data) or len(nonce) != 12 or kid != hmac.digest(key, b"key_id\x01", "sha256")[:16]:
        raise ValueError("Malformed strong-box envelope or wrong key")
    return ChaCha20Poly1305(key).decrypt(nonce, ciphertext, context.encode() + kid + nonce)


def database(root, state):
    query = lambda sql: stand.shared.sql(root, state, sql, state["files_db"])
    objects = json.loads(query("SELECT coalesce(json_agg(x),'[]'::json) FROM ("
        "SELECT 'file' kind,file_id::text id,revision,object_key,source_size_bytes bytes,encode(source_sha256,'hex') sha256,is_encrypted "
        "FROM file_content UNION ALL SELECT 'audio',id::text,0,storage_key,source_size_bytes,encode(source_sha256,'hex'),true "
        "FROM device_audio) x;"))
    jobs = json.loads(query("SELECT coalesce(json_agg(x),'[]'::json) FROM ("
        "SELECT j.id,j.kind,j.status,j.attempt_count,j.source_release_state,j.quota_released_at,"
        "extract(epoch from j.finished_at-j.created_at)::float8 total_seconds,"
        "extract(epoch from a.created_at-j.created_at)::float8 before_winning_attempt_seconds,"
        "extract(epoch from j.finished_at-a.created_at)::float8 winning_attempt_seconds,"
        "extract(epoch from a.write_acknowledged_at-a.write_intent_at)::float8 write_seconds,"
        "extract(epoch from a.verified_at-a.write_acknowledged_at)::float8 readback_seconds "
        ",extract(epoch from j.source_released_at-j.finished_at)::float8 source_release_seconds "
        "FROM device_upload_finalization_job j LEFT JOIN device_upload_finalization_attempt a ON a.id=j.winning_attempt_id) x;"))
    cleanup = json.loads(query("SELECT json_build_object("
        "'active_jobs',(SELECT count(*) FROM device_upload_finalization_job WHERE status NOT IN ('completed','failed')),"
        "'unreleased_sources',(SELECT count(*) FROM device_upload_finalization_job WHERE source_release_state<>'released'),"
        "'unreleased_quotas',(SELECT count(*) FROM device_upload_finalization_job WHERE quota_released_at IS NULL),"
        "'reserved_jobs',(SELECT coalesce(sum(reserved_jobs),0) FROM device_upload_finalization_budget),"
        "'reserved_bytes',(SELECT coalesce(sum(reserved_source_bytes),0) FROM device_upload_finalization_budget),"
        "'unresolved_writes',(SELECT coalesce(sum(unresolved_writes),0) FROM device_upload_finalization_budget),"
        "'held_write_credits',(SELECT count(*) FROM device_upload_finalization_attempt WHERE write_credit_held),"
        "'unremoved_file_spools',(SELECT count(*) FROM file_content_upload WHERE spool_removed_at IS NULL),"
        "'unconsumed_audio',(SELECT count(*) FROM device_audio_ingest WHERE source_consumed_at IS NULL));"))
    return objects, jobs, cleanup


def main():
    import boto3
    from botocore.config import Config
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--results", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Audit output already exists")
    root, state = stand.load(args.root)
    for key in ("main_db", "files_db"):
        marker = stand.shared.sql(root, state, f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{state[key]}';")
        stand.shared.require(marker == f"echo-{stand.PROFILE}:{state['run']}", "Database ownership mismatch")
    rows = []
    for directory in args.results:
        for summary in directory.glob("*.summary.json"):
            path = summary.with_name(summary.name.replace(".summary.json", ".jsonl"))
            rows.extend(json.loads(line) for line in path.read_text().splitlines())
    failed_samples = sum(not row["ok"] for row in rows)
    rows = [row for row in rows if row["ok"]]
    stand.shared.require(rows, "No successful benchmark samples to audit")
    objects, jobs, cleanup = database(root, state)
    audio_root = root / "storage/device-audio-tus"
    cleanup["audio_pins"] = len(list(audio_root.glob("*/file_upload_tus/pins/*.json")))
    cleanup["audio_lock_proofs"] = sum(path.stat().st_size > 0 for path in audio_root.glob("*/file_upload_tus/locks/*") if path.is_file())
    cleanup["file_spool_data_files"] = len(list((root / "storage/device-file-content-spool").glob("*.data")))
    index = {(obj["kind"], obj["id"], obj["revision"]): obj for obj in objects}
    config = tomllib.loads((root / "config-a.toml").read_text())["s3_config"]
    key = base64.b64decode(config["strongbox_key"])
    s3 = boto3.client("s3", endpoint_url=config["s3_endpoint"], region_name="us-east-1",
                      aws_access_key_id=config["s3_access_key_id"], aws_secret_access_key=config["s3_secret_access_key"],
                      config=Config(signature_version="s3v4", s3={"addressing_style": "path"}, retries={"max_attempts": 0}))

    def verify(row):
        identity = (row["kind"], row.get("file_id", row.get("audio_id")), row.get("revision", 0))
        obj = index[identity]
        stand.shared.require((obj["bytes"], obj["sha256"]) == (row["bytes"], row["sha256"]), "Publication metadata mismatch")
        response = s3.get_object(Bucket=state["bucket"], Key=obj["object_key"])
        with response["Body"] as stream:
            data = stream.read()
        if obj["is_encrypted"]:
            data = decrypt_strongbox(data, key, f"{state['bucket']}/{obj['object_key']}")
        stand.shared.require(len(data) == row["bytes"] and hashlib.sha256(data).hexdigest() == row["sha256"], "S3 plaintext integrity mismatch")
        return {"kind": row["kind"], "bytes": len(data), "encrypted": obj["is_encrypted"]}

    begin = time.monotonic()
    with ThreadPoolExecutor(max_workers=2) as executor:
        verified = list(executor.map(verify, rows))
    multipart = []
    for page in s3.get_paginator("list_multipart_uploads").paginate(Bucket=state["bucket"]):
        multipart.extend(page.get("Uploads", []))
    client = Client(f"http://127.0.0.1:{state['api_a_port']}")
    client.login(json.loads((root / "credentials.json").read_text()))
    playback, seen = [], set()
    for row in rows:
        identity = (row["mode"], row["bytes"])
        if row["kind"] != "audio" or identity in seen:
            continue
        seen.add(identity)
        started = time.monotonic()
        _, content, headers = client.request(f"/api/device/audio/{row['device_id']}/{row['audio_id']}/content", method="GET")
        decoded = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "null", "-"], input=content, capture_output=True)
        stand.shared.require(bool(content) and decoded.returncode == 0, "Published audio playback cannot be decoded")
        playback.append(dict(mode=row["mode"], source_bytes=row["bytes"], playback_bytes=len(content),
                             seconds=time.monotonic() - started, content_type=headers.get("content-type")))
    phases = {}
    for kind in ("file", "audio"):
        selected = [job for job in jobs if job["kind"] == kind and job["status"] == "completed"]
        phases[kind] = {field: distribution([job[field] for job in selected if job[field] is not None])
                        for field in ("before_winning_attempt_seconds", "winning_attempt_seconds", "write_seconds", "readback_seconds", "total_seconds", "source_release_seconds") if selected}
    result = dict(verified_objects=len(verified), failed_benchmark_samples=failed_samples,
                  verified_plaintext_bytes=sum(item["bytes"] for item in verified),
                  encrypted_objects=sum(item["encrypted"] for item in verified), unfinished_multipart_uploads=len(multipart),
                  cleanup=cleanup, async_jobs=len(jobs), retried_jobs=sum(job["attempt_count"] > 1 for job in jobs),
                  failed_jobs=sum(job["status"] == "failed" for job in jobs), async_phases=phases,
                  playback=playback, elapsed_seconds=time.monotonic() - begin)
    args.output.with_name(args.output.stem + "-jobs.json").write_text(json.dumps(jobs, indent=2) + "\n")
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result), flush=True)
    stand.shared.require(not multipart and not any(cleanup.values()) and not result["failed_jobs"], "Cleanup audit failed")


if __name__ == "__main__":
    main()
