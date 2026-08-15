from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

JobState = Literal["queued", "running", "retry_wait", "completed", "failed", "cancelled"]
TERMINAL_STATES = ("completed", "failed", "cancelled")
ACTIVE_STATES = ("queued", "running", "retry_wait")


class QueueFullError(RuntimeError):
    pass


class IdempotencyConflictError(RuntimeError):
    pass


@dataclass(frozen=True)
class Job:
    id: str
    idempotency_key: str
    request_digest: str
    state: JobState
    quality_status: str | None
    attempts: int
    created_at: float
    updated_at: float
    started_at: float | None
    completed_at: float | None
    retry_at: float | None
    heartbeat_at: float | None
    lease_owner: str | None
    lease_expires_at: float | None
    cancel_requested: bool
    total_pages: int
    processed_pages: int
    input_bytes: int
    result_bytes: int
    error_summary: str | None
    spool_path: str
    result_path: str | None


class JobQueue:
    def __init__(self, path: Path, max_depth: int = 25) -> None:
        self.path = path
        self.max_depth = max_depth
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        return connection

    def initialize(self) -> None:
        for attempt in range(30):
            try:
                self._initialize_database()
                return
            except sqlite3.OperationalError as error:
                if "locked" not in str(error).lower() or attempt == 29:
                    raise
                time.sleep(0.1)

    def _initialize_database(self) -> None:
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=FULL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    request_digest TEXT NOT NULL,
                    state TEXT NOT NULL CHECK (state IN
                        ('queued', 'running', 'retry_wait', 'completed', 'failed', 'cancelled')),
                    quality_status TEXT CHECK (quality_status IS NULL OR quality_status IN
                        ('accepted', 'degraded', 'failed')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    started_at REAL,
                    completed_at REAL,
                    retry_at REAL,
                    heartbeat_at REAL,
                    lease_owner TEXT,
                    lease_expires_at REAL,
                    cancel_requested INTEGER NOT NULL DEFAULT 0,
                    total_pages INTEGER NOT NULL,
                    processed_pages INTEGER NOT NULL DEFAULT 0,
                    input_bytes INTEGER NOT NULL,
                    result_bytes INTEGER NOT NULL DEFAULT 0,
                    error_summary TEXT,
                    spool_path TEXT NOT NULL,
                    result_path TEXT
                );
                CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(state, retry_at, created_at);
                CREATE INDEX IF NOT EXISTS jobs_retention_idx ON jobs(state, completed_at);
                CREATE TABLE IF NOT EXISTS workers (
                    owner TEXT PRIMARY KEY,
                    started_at REAL NOT NULL,
                    heartbeat_at REAL NOT NULL,
                    paddle_ready INTEGER NOT NULL,
                    active INTEGER NOT NULL,
                    dependencies_json TEXT NOT NULL
                );
                """
            )

    @contextmanager
    def transaction(self):
        connection = self.connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def submit(
        self,
        job_id: str,
        idempotency_key: str,
        request_digest: str,
        spool_path: Path,
        input_bytes: int,
        total_pages: int,
    ) -> tuple[Job, bool]:
        now = time.time()
        with self.transaction() as connection:
            existing = connection.execute(
                "SELECT * FROM jobs WHERE idempotency_key = ?", (idempotency_key,)
            ).fetchone()
            if existing:
                if existing["request_digest"] != request_digest:
                    raise IdempotencyConflictError("idempotency key belongs to a different request")
                return _job(existing), False
            depth = connection.execute(
                "SELECT COUNT(*) FROM jobs WHERE state IN ('queued', 'running', 'retry_wait')"
            ).fetchone()[0]
            if depth >= self.max_depth:
                raise QueueFullError("job queue is full")
            connection.execute(
                """INSERT INTO jobs (
                    id, idempotency_key, request_digest, state, created_at, updated_at,
                    total_pages, input_bytes, spool_path
                ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)""",
                (
                    job_id,
                    idempotency_key,
                    request_digest,
                    now,
                    now,
                    total_pages,
                    input_bytes,
                    str(spool_path),
                ),
            )
            return _job(connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()), True

    def get(self, job_id: str) -> Job | None:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return _job(row) if row else None

    def claim(self, owner: str, lease_seconds: int) -> Job | None:
        now = time.time()
        with self.transaction() as connection:
            if connection.execute("SELECT 1 FROM jobs WHERE state = 'running' LIMIT 1").fetchone():
                return None
            row = connection.execute(
                """SELECT * FROM jobs
                WHERE state = 'queued' OR (state = 'retry_wait' AND retry_at <= ?)
                ORDER BY created_at LIMIT 1""",
                (now,),
            ).fetchone()
            if not row:
                return None
            connection.execute(
                """UPDATE jobs SET state = 'running', attempts = attempts + 1,
                    started_at = COALESCE(started_at, ?), updated_at = ?, heartbeat_at = ?,
                    lease_owner = ?, lease_expires_at = ?, retry_at = NULL, processed_pages = 0
                WHERE id = ?""",
                (now, now, now, owner, now + lease_seconds, row["id"]),
            )
            return _job(connection.execute("SELECT * FROM jobs WHERE id = ?", (row["id"],)).fetchone())

    def heartbeat(self, job_id: str, owner: str, lease_seconds: int) -> bool:
        now = time.time()
        with self.connect() as connection:
            cursor = connection.execute(
                """UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
                WHERE id = ? AND state = 'running' AND lease_owner = ?""",
                (now, now + lease_seconds, now, job_id, owner),
            )
        return cursor.rowcount == 1

    def update_progress(self, job_id: str, owner: str, processed_pages: int) -> bool:
        now = time.time()
        with self.connect() as connection:
            cursor = connection.execute(
                """UPDATE jobs SET processed_pages = ?, updated_at = ?
                WHERE id = ? AND state = 'running' AND lease_owner = ?""",
                (processed_pages, now, job_id, owner),
            )
            row = connection.execute("SELECT cancel_requested FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if cursor.rowcount != 1:
            raise RuntimeError("job lease was lost")
        return bool(row[0])

    def complete(
        self,
        job_id: str,
        owner: str,
        quality_status: str,
        result_path: Path,
        result_bytes: int,
    ) -> None:
        now = time.time()
        with self.connect() as connection:
            cursor = connection.execute(
                """UPDATE jobs SET state = 'completed', quality_status = ?, result_path = ?,
                    result_bytes = ?, completed_at = ?, updated_at = ?, lease_owner = NULL,
                    lease_expires_at = NULL, heartbeat_at = NULL, error_summary = NULL
                WHERE id = ? AND state = 'running' AND lease_owner = ?
                    AND cancel_requested = 0""",
                (quality_status, str(result_path), result_bytes, now, now, job_id, owner),
            )
        if cursor.rowcount != 1:
            raise RuntimeError("job lease was lost before completion")

    def fail(
        self,
        job_id: str,
        owner: str,
        summary: str,
        infrastructure: bool,
        retries: int,
        backoff: tuple[int, ...],
    ) -> Job:
        now = time.time()
        with self.transaction() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row or row["state"] != "running" or row["lease_owner"] != owner:
                raise RuntimeError("job lease was lost before failure update")
            retry = infrastructure and row["attempts"] <= retries and not row["cancel_requested"]
            state = "retry_wait" if retry else "cancelled" if row["cancel_requested"] else "failed"
            retry_at = now + backoff[row["attempts"] - 1] if retry else None
            quality = None if retry or state == "cancelled" else "failed"
            completed_at = None if retry else now
            connection.execute(
                """UPDATE jobs SET state = ?, quality_status = ?, retry_at = ?, completed_at = ?,
                    updated_at = ?, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                    error_summary = ? WHERE id = ?""",
                (state, quality, retry_at, completed_at, now, summary[:500], job_id),
            )
            return _job(connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())

    def cancel(self, job_id: str) -> Job | None:
        now = time.time()
        with self.transaction() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                return None
            if row["state"] in ("queued", "retry_wait"):
                connection.execute(
                    """UPDATE jobs SET state = 'cancelled', cancel_requested = 1,
                    completed_at = ?, updated_at = ? WHERE id = ?""",
                    (now, now, job_id),
                )
            elif row["state"] == "running":
                connection.execute(
                    "UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?",
                    (now, job_id),
                )
            return _job(connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())

    def recover_expired(self, retries: int, backoff: tuple[int, ...]) -> int:
        now = time.time()
        recovered = 0
        with self.transaction() as connection:
            rows = connection.execute(
                "SELECT * FROM jobs WHERE state = 'running' AND lease_expires_at < ?", (now,)
            ).fetchall()
            for row in rows:
                if row["cancel_requested"]:
                    state, retry_at, completed_at, quality = "cancelled", None, now, None
                elif row["attempts"] <= retries:
                    state, completed_at, quality = "retry_wait", None, None
                    retry_at = now + backoff[row["attempts"] - 1]
                else:
                    state, retry_at, completed_at, quality = "failed", None, now, "failed"
                connection.execute(
                    """UPDATE jobs SET state = ?, quality_status = ?, retry_at = ?, completed_at = ?,
                    updated_at = ?, lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                    error_summary = 'worker lease expired' WHERE id = ?""",
                    (state, quality, retry_at, completed_at, now, row["id"]),
                )
                recovered += 1
        return recovered

    def terminal_before(self, timestamp: float) -> list[Job]:
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT * FROM jobs WHERE state IN ('completed', 'failed', 'cancelled')
                AND completed_at < ? ORDER BY completed_at""",
                (timestamp,),
            ).fetchall()
        return [_job(row) for row in rows]

    def delete_terminal(self, job_id: str) -> bool:
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM jobs WHERE id = ? AND state IN ('completed', 'failed', 'cancelled')",
                (job_id,),
            )
        return cursor.rowcount == 1

    def counts(self) -> dict[str, int]:
        result = {state: 0 for state in (*ACTIVE_STATES, *TERMINAL_STATES)}
        with self.connect() as connection:
            for row in connection.execute("SELECT state, COUNT(*) AS count FROM jobs GROUP BY state"):
                result[row["state"]] = row["count"]
        return result

    def spool_bytes(self) -> int:
        with self.connect() as connection:
            value = connection.execute(
                "SELECT COALESCE(SUM(input_bytes + result_bytes), 0) FROM jobs"
            ).fetchone()[0]
        return int(value)

    def update_worker(
        self,
        owner: str,
        paddle_ready: bool,
        active: bool,
        dependencies_json: str,
    ) -> None:
        now = time.time()
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO workers (
                    owner, started_at, heartbeat_at, paddle_ready, active, dependencies_json
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(owner) DO UPDATE SET
                    heartbeat_at = excluded.heartbeat_at,
                    paddle_ready = excluded.paddle_ready,
                    active = excluded.active,
                    dependencies_json = excluded.dependencies_json""",
                (owner, now, now, paddle_ready, active, dependencies_json),
            )

    def workers(self, active_after: float) -> list[dict[str, object]]:
        with self.connect() as connection:
            connection.execute("DELETE FROM workers WHERE heartbeat_at < ?", (active_after,))
            rows = connection.execute(
                """SELECT started_at, heartbeat_at, paddle_ready, active, dependencies_json
                FROM workers ORDER BY started_at"""
            ).fetchall()
        return [
            {
                "started_at": row["started_at"],
                "heartbeat_at": row["heartbeat_at"],
                "paddle_ready": bool(row["paddle_ready"]),
                "active": bool(row["active"]),
                "dependencies": row["dependencies_json"],
            }
            for row in rows
        ]


def _job(row: sqlite3.Row) -> Job:
    values = dict(row)
    values["cancel_requested"] = bool(values["cancel_requested"])
    return Job(**values)
