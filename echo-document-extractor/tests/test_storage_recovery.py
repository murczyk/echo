from __future__ import annotations

import json
import os
import runpy
import sqlite3
import uuid
from pathlib import Path

import pytest

from echo_document_extractor.job_queue import JobQueue

pytestmark = pytest.mark.live
ROOT = Path(__file__).resolve().parents[2]
SQL = ROOT / "wdintel-rs/src/devices/documents/recover_upstream_storage_pressure.sql"


@pytest.fixture
def recovery(tmp_path: Path):
    database = os.environ.get("TEST_RECOVERY_DB")
    if not database or not database.startswith("wd_files_test_"):
        pytest.skip("requires a dedicated migrated test database and root peer access")
    pytest.importorskip("psycopg")
    script = runpy.run_path(str(ROOT / "echo-document-extractor/bin/recover-storage-pressure.py"))
    pg = script["connect"](database)
    for table in ("file_document", "file_document_job", "file_content"):
        pg.execute(f"create temporary table {table} (like public.{table} including all)")
    pg.commit()
    queue = JobQueue(tmp_path / "jobs.sqlite3")
    native = sqlite3.connect(queue.path, isolation_level=None)
    native.row_factory = sqlite3.Row
    checkpoint = tmp_path / "checkpoint"
    checkpoint.mkdir()
    try:
        yield script, pg, native, queue, checkpoint
    finally:
        native.close()
        pg.close()


def failed_pair(recovery, kind: str) -> dict:
    script, pg, _, queue, checkpoint = recovery
    identifier, file, generation = (str(uuid.uuid4()) for _ in range(3))
    root = checkpoint / identifier
    (root / "inputs").mkdir(parents=True)
    source = root / "inputs" / "source.txt"
    source.write_text("source")
    manifest = {"inputs": [source.name]}
    if kind == "grant":
        manifest["ocr"] = {"grant": "expired"}
    (root / "manifest.json").write_text(json.dumps(manifest))
    queue.submit(identifier, identifier, "digest", root, 6, 1)
    queue.claim("worker", 300)
    error = script["UPSTREAM_ERROR"] if kind != "unrelated" else "HTTP 400"
    queue.fail(identifier, "worker", error, False, 3, (1, 2, 3))
    if kind == "cancelled":
        with queue.connect() as connection:
            connection.execute("update jobs set cancel_requested=1 where id=?", (identifier,))
    if kind == "missing":
        source.unlink()
    job_id = str(uuid.uuid4())
    document_generation = str(uuid.uuid4()) if kind == "stale" else generation
    published = str(uuid.uuid4())
    pg.execute(
        """insert into file_document(file_id,revision,device_id,generation,
        published_generation,state) values(%s,1,%s,%s,%s,'failed')""",
        (file, str(uuid.uuid4()), document_generation, published),
    )
    pg.execute(
        """insert into file_document_job(id,file_id,revision,generation,kind,
        state,attempts,payload,last_error,lease,lease_until)
        values(%s,%s,1,%s,'extract','failed',5,%s::jsonb,%s,%s,
            case when %s then now()+interval '1 hour' else null end)""",
        (
            job_id,
            file,
            generation,
            json.dumps({"extractorJobId": identifier}),
            error,
            str(uuid.uuid4()) if kind == "leased" else None,
            kind == "leased",
        ),
    )
    pg.execute(
        """insert into file_content(file_id,revision,upload_id,object_key,
        source_size_bytes,source_sha256,is_encrypted,created_at)
        values(%s,1,%s,%s,6,%s,false,now())""",
        (file, str(uuid.uuid4()), identifier, bytes(32)),
    )
    pg.commit()
    return {"id": job_id, "extractor_id": identifier, "generation": generation, "published": published}


def test_recovery_selection_and_queue_capacity_3743(recovery) -> None:
    script, pg, native, queue, checkpoint = recovery
    eligible = failed_pair(recovery, "eligible")
    protected = [
        failed_pair(recovery, kind)
        for kind in ("stale", "leased", "cancelled", "missing", "grant", "unrelated")
    ]
    plan = script["prepare"](pg, native, checkpoint)
    pg.commit()
    assert len(plan["candidates"]) == 1
    before = {row["extractor_id"]: queue.get(row["extractor_id"]) for row in protected}
    for index in range(25):
        queue.submit(f"filler-{index}", f"filler-{index}", "digest", checkpoint, 1, 1)
    assert script["recover_batch"](pg, native, checkpoint, SQL.read_text(), plan, 20)["recovered"] == 0
    queue.cancel("filler-0")
    result = script["recover_batch"](pg, native, checkpoint, SQL.read_text(), plan, 20)
    assert result["recovered"] == 1 and result["active"] == 25
    for row in protected:
        assert queue.get(row["extractor_id"]) == before[row["extractor_id"]]
    current = pg.execute(
        "select to_jsonb(j) as job,to_jsonb(d) as document from "
        "file_document_job j join file_document d using(file_id,revision) where j.id=%s",
        (eligible["id"],),
    ).fetchone()
    assert current["job"]["generation"] == eligible["generation"]
    assert current["job"]["payload"]["extractorJobId"] == eligible["extractor_id"]
    assert current["document"]["published_generation"] == eligible["published"]


def test_recovery_reconciles_partial_commit_without_overwriting_progress_3743(recovery) -> None:
    script, pg, native, queue, checkpoint = recovery
    eligible = failed_pair(recovery, "eligible")
    plan = script["prepare"](pg, native, checkpoint)
    pg.commit()
    result = script["recover_batch"](pg, native, checkpoint, SQL.read_text(), plan, 10)
    path = Path(result["checkpoint"])
    batch = json.loads(path.read_text())
    batch["state"] = "prepared"
    script["save"](path, batch)
    pg.execute("update file_document_job set state='failed' where id=%s", (eligible["id"],))
    pg.execute("update file_document set state='failed'")
    pg.commit()
    running = queue.claim("worker", 300)
    queue.complete(running.id, "worker", "accepted", checkpoint / "result.zip", 1)
    completed = queue.get(running.id)
    script["reconcile"](pg, native, checkpoint, SQL.read_text())
    assert queue.get(running.id) == completed
    assert (
        pg.execute("select state from file_document_job where id=%s", (eligible["id"],)).fetchone()["state"]
        == "queued"
    )
    pg.commit()
    pg.execute("update file_document_job set state='completed' where id=%s", (eligible["id"],))
    pg.commit()
    batch["state"] = "prepared"
    script["save"](path, batch)
    script["reconcile"](pg, native, checkpoint, SQL.read_text())
    assert queue.get(running.id) == completed
    assert (
        pg.execute("select state from file_document_job where id=%s", (eligible["id"],)).fetchone()["state"]
        == "completed"
    )
