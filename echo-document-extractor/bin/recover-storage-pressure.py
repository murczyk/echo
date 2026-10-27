#!/usr/bin/env python3
# /// script
# requires-python = ">=3.13"
# dependencies = ["psycopg[binary]==3.3.6"]
# ///
from __future__ import annotations

import argparse
import fcntl
import json
import os
import pwd
import sqlite3
import time
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

UPSTREAM_ERROR = "Server error '507 Insufficient Storage' for url 'http://100.93.77.92:8000/v1/jobs'"
ACTIVE = ("queued", "running", "retry_wait")


def save(path: Path, value: object) -> None:
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as output:
        json.dump(value, output, indent=2, default=str)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def connect(database: str):
    original = os.geteuid()
    try:
        os.seteuid(pwd.getpwnam("postgres").pw_uid)
        return psycopg.connect(dbname=database, user="postgres", client_encoding="UTF8", row_factory=dict_row)
    finally:
        os.seteuid(original)


def inputs_present(job: dict) -> bool:
    root = Path(job["spool_path"])
    try:
        manifest = json.loads((root / "manifest.json").read_text())
        inputs = manifest["inputs"]
        return (
            bool(inputs)
            and not manifest.get("ocr")
            and all(
                (root / "inputs" / name).is_file()
                and (root / "inputs" / name).resolve().is_relative_to(root.resolve())
                for name in inputs
            )
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False


def native_eligible(job: dict | None) -> bool:
    return bool(
        job
        and job["state"] == "failed"
        and not job["cancel_requested"]
        and job["lease_owner"] is None
        and job["lease_expires_at"] is None
        and job["result_path"] is None
        and UPSTREAM_ERROR in (job["error_summary"] or "")
        and inputs_present(job)
    )


def native_job(sqlite, identifier: str) -> dict | None:
    row = sqlite.execute("select * from jobs where id=?", (identifier,)).fetchone()
    return dict(row) if row else None


def document_rows(pg, requested: list[dict], lock: bool = False) -> list[dict]:
    query = """select to_jsonb(j) as job, to_jsonb(d) as document,
        j.payload->>'extractorJobId' as extractor_id
        from jsonb_to_recordset(%s::jsonb) as requested(id uuid, extractor_id text, generation uuid)
        join file_document_job j on j.id=requested.id
        join file_document d on d.file_id=j.file_id and d.revision=j.revision
            and d.generation=j.generation
        where j.kind='extract' and j.state='failed' and d.state='failed'
            and j.lease is null and j.lease_until is null
            and j.payload->>'extractorJobId'=requested.extractor_id
            and j.generation=requested.generation
            and exists(select 1 from file_content c
                where c.file_id=j.file_id and c.revision=j.revision)"""
    if lock:
        query += " for update of j,d"
    return pg.execute(query, (json.dumps(requested),)).fetchall()


def requeue_documents(pg, sql: str, rows: list[dict]) -> list[str]:
    requested = [request_identity(row) for row in rows]
    updated = pg.execute(sql.replace("$1", "%s"), (json.dumps(requested),)).fetchall()
    if len(updated) != len(rows):
        raise RuntimeError("recovery eligibility changed while rows were locked")
    return [str(row["id"]) for row in updated]


def prepare(pg, sqlite, checkpoint: Path) -> dict:
    native = {
        row["id"]: dict(row)
        for row in sqlite.execute("select * from jobs where state='failed'")
        if native_eligible(dict(row))
    }
    rows = pg.execute("""select j.id::text, j.generation::text, j.payload->>'extractorJobId' as extractor_id
        from file_document_job j join file_document d using(file_id,revision,generation)
        where j.kind='extract' and j.state='failed' and d.state='failed'
            and j.lease is null and j.lease_until is null
            and j.payload ? 'extractorJobId'""").fetchall()
    requested = [row for row in rows if row["extractor_id"] in native]
    rows = document_rows(pg, requested)
    rows.sort(key=lambda row: (native[row["extractor_id"]]["input_bytes"], row["job"]["id"]))
    plan = {"prepared_at": time.time(), "candidates": rows, "native": native}
    save(checkpoint / "plan.json", plan)
    return plan


def reconcile(pg, sqlite, checkpoint: Path, sql: str) -> None:
    for path in sorted(checkpoint.glob("batch-*.json")):
        batch = json.loads(path.read_text())
        if batch["state"] != "prepared":
            continue
        requested = []
        for row in batch["rows"]:
            current = native_job(sqlite, row["extractor_id"])
            before = batch["native"][row["extractor_id"]]
            if (
                current
                and not current["cancel_requested"]
                and current["idempotency_key"] == before["idempotency_key"]
                and current["request_digest"] == before["request_digest"]
                and current["updated_at"] != before["updated_at"]
            ):
                requested.append(request_identity(row))
        with pg.transaction():
            rows = document_rows(pg, requested, lock=True)
            batch["reconciled"] = requeue_documents(pg, sql, rows)
        batch["state"] = "reconciled"
        save(path, batch)


def recover_batch(pg, sqlite, checkpoint: Path, sql: str, plan: dict, limit: int) -> dict:
    depth = sqlite.execute(
        "select count(*) from jobs where state in ('queued','running','retry_wait')"
    ).fetchone()[0]
    limit = min(limit, 25 - depth)
    if limit <= 0:
        return {"recovered": 0, "active": depth}
    completed = set()
    for path in checkpoint.glob("batch-*.json"):
        batch = json.loads(path.read_text())
        completed.update(batch.get("recovered", []))
        completed.update(batch.get("reconciled", []))
    requested = [
        request_identity(row)
        for row in plan["candidates"]
        if row["job"]["id"] not in completed and native_eligible(native_job(sqlite, row["extractor_id"]))
    ]
    if not requested:
        return {"recovered": 0, "active": depth}
    path = checkpoint / f"batch-{time.time_ns()}.json"
    sqlite.execute("begin immediate")
    try:
        with pg.transaction():
            pg.execute("set local lock_timeout='5s'")
            pg.execute("set local statement_timeout='15s'")
            eligible = {row["job"]["id"] for row in document_rows(pg, requested)}
            requested = [row for row in requested if row["id"] in eligible][:limit]
            rows = document_rows(pg, requested, lock=True)
            rows = [row for row in rows if native_eligible(native_job(sqlite, row["extractor_id"]))]
            depth = sqlite.execute(
                "select count(*) from jobs where state in ('queued','running','retry_wait')"
            ).fetchone()[0]
            rows = rows[: max(0, min(limit, 25 - depth))]
            native = {row["extractor_id"]: native_job(sqlite, row["extractor_id"]) for row in rows}
            save(path, {"state": "prepared", "rows": rows, "native": native})
            now = time.time()
            for identifier in native:
                sqlite.execute(
                    """update jobs set state='queued',attempts=0,quality_status=null,
                    completed_at=null,retry_at=null,error_summary=null,updated_at=?
                    where id=?""",
                    (now, identifier),
                )
            recovered = requeue_documents(pg, sql, rows)
            sqlite.commit()
        save(path, {"state": "committed", "rows": rows, "native": native, "recovered": recovered})
    except BaseException:
        sqlite.rollback()
        raise
    return {"recovered": len(recovered), "active": depth + len(native), "checkpoint": str(path)}


def progress(pg, sqlite, checkpoint: Path, plan: dict) -> dict:
    ids = [row["job"]["id"] for row in plan["candidates"]]
    states = pg.execute(
        """select state,count(*) as count from file_document_job
        where id=any(%s::uuid[]) group by state""",
        (ids,),
    ).fetchall()
    states = {row["state"]: row["count"] for row in states}
    native_states = {}
    for row in plan["candidates"]:
        current = native_job(sqlite, row["extractor_id"])
        state = current["state"] if current else "missing"
        native_states[state] = native_states.get(state, 0) + 1
    result = {"time": time.time(), "selected": len(ids), "echo": states, "native": native_states}
    requested = [
        request_identity(row)
        for row in plan["candidates"]
        if native_eligible(native_job(sqlite, row["extractor_id"]))
    ]
    result["remaining_eligible"] = len(document_rows(pg, requested))
    save(checkpoint / "progress.json", result)
    return result


def request_identity(row: dict) -> dict:
    return {
        "id": row["job"]["id"],
        "extractor_id": row["extractor_id"],
        "generation": row["job"]["generation"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", default="/var/lib/echo-native-extractor/jobs.sqlite3")
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--recovery-sql", required=True, type=Path)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--batch", type=int, choices=range(1, 21))
    parser.add_argument("--drain", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    args.checkpoint.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (args.checkpoint / "recovery.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with connect("wd_files") as pg, sqlite3.connect(args.database, isolation_level=None) as sqlite:
            sqlite.row_factory = sqlite3.Row
            sql = args.recovery_sql.read_text()
            reconcile(pg, sqlite, args.checkpoint, sql)
            plan_path = args.checkpoint / "plan.json"
            if args.prepare:
                if plan_path.exists():
                    raise RuntimeError("plan already exists; preserve the original recovery selection")
                plan = prepare(pg, sqlite, args.checkpoint)
                pg.commit()
            else:
                plan = json.loads(plan_path.read_text())
            while True:
                if args.batch or args.drain:
                    print(
                        json.dumps(recover_batch(pg, sqlite, args.checkpoint, sql, plan, args.batch or 20)),
                        flush=True,
                    )
                result = progress(pg, sqlite, args.checkpoint, plan)
                pg.commit()
                print(json.dumps(result), flush=True)
                if not args.drain or (
                    result["remaining_eligible"] == 0
                    and not any(state in ACTIVE for state in result["native"])
                ):
                    break
                time.sleep(15)


if __name__ == "__main__":
    main()
