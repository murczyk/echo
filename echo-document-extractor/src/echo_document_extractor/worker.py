from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import threading
import time
import uuid
from pathlib import Path

from .dependencies import DependencyChecker
from .job_queue import Job, JobQueue
from .metrics import ServiceMetrics
from .ocr import PaddleEvidenceProvider
from .package_archive import create_package_zip
from .pipeline import ExtractionCancelled, Extractor
from .service_config import RuntimeConfig
from .storage import StoragePressureError, directory_size, ensure_capacity, remove_job_directory


class InfrastructureFailure(RuntimeError):
    pass


class LeaseHeartbeat:
    def __init__(
        self,
        queue: JobQueue,
        job: Job,
        owner: str,
        interval: int,
        lease: int,
        dependencies_json: str,
    ) -> None:
        self.queue = queue
        self.job = job
        self.owner = owner
        self.interval = interval
        self.lease = lease
        self.dependencies_json = dependencies_json
        self.stop_event = threading.Event()
        self.lost = False
        self.thread = threading.Thread(target=self._run, name="job-heartbeat", daemon=True)

    def __enter__(self) -> LeaseHeartbeat:
        self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stop_event.set()
        self.thread.join(timeout=self.interval + 1)

    def _run(self) -> None:
        while not self.stop_event.wait(self.interval):
            try:
                if not self.queue.heartbeat(self.job.id, self.owner, self.lease):
                    self.lost = True
                    return
                self.queue.update_worker(self.owner, True, True, self.dependencies_json)
            except Exception:
                self.lost = True
                return


class Worker:
    def __init__(self, config: RuntimeConfig, start_metrics: bool = True) -> None:
        self.config = config
        self.service = config.service
        self.queue = JobQueue(self.service.database_path, self.service.limits.max_queue_depth)
        self.dependencies = DependencyChecker(config.extraction)
        self.metrics = ServiceMetrics("worker")
        self.owner = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4()}"
        self.dependencies_json = "[]"
        self.ocr = PaddleEvidenceProvider(
            config.extraction.enable_paddle,
            config.extraction.paddle_languages,
            config.extraction.paddle,
        )
        if start_metrics:
            self.metrics.start(self.service.worker_metrics_host, self.service.worker_metrics_port)

    async def run(self) -> None:
        settings = self.service.worker
        self.queue.recover_expired(
            settings.infrastructure_retries,
            settings.retry_backoff_seconds,
        )
        last_cleanup = 0.0
        while True:
            self.queue.recover_expired(
                settings.infrastructure_retries,
                settings.retry_backoff_seconds,
            )
            if time.monotonic() - last_cleanup >= 60:
                self.cleanup_expired()
                last_cleanup = time.monotonic()
            statuses = await self.dependencies.check_all()
            self.dependencies_json = json.dumps(
                [status.__dict__ for status in statuses], separators=(",", ":")
            )
            for dependency in statuses:
                self.metrics.dependency_up.labels(dependency=dependency.name).set(dependency.healthy)
            self.queue.update_worker(self.owner, True, False, self.dependencies_json)
            if not all(dependency.healthy for dependency in statuses):
                self.metrics.update_queue(self.queue.counts())
                await asyncio.sleep(settings.poll_seconds)
                continue
            job = self.queue.claim(self.owner, settings.lease_seconds)
            if not job:
                self.metrics.worker_active.set(0)
                self.metrics.update_queue(self.queue.counts())
                await asyncio.sleep(settings.poll_seconds)
                continue
            self.queue.update_worker(self.owner, True, True, self.dependencies_json)
            await self.process(job)

    async def process(self, job: Job) -> None:
        settings = self.service.worker
        self.metrics.worker_active.set(1)
        self.metrics.page_progress.set(0)
        started = time.monotonic()
        heartbeat = LeaseHeartbeat(
            self.queue,
            job,
            self.owner,
            settings.heartbeat_seconds,
            settings.lease_seconds,
            self.dependencies_json,
        )
        try:
            with heartbeat:
                quality = await self._extract(job)
                if heartbeat.lost:
                    raise InfrastructureFailure("job heartbeat lease was lost")
            completed = self.queue.get(job.id)
            self.metrics.jobs.labels(state="completed", quality=quality).inc()
            self.metrics.job_duration.labels(state="completed", quality=quality).observe(
                time.monotonic() - started
            )
            if completed:
                self.metrics.page_progress.set(1)
        except ExtractionCancelled as error:
            try:
                self.queue.fail(
                    job.id,
                    self.owner,
                    str(error),
                    False,
                    settings.infrastructure_retries,
                    settings.retry_backoff_seconds,
                )
            except RuntimeError:
                pass
            else:
                self.metrics.jobs.labels(state="cancelled", quality="none").inc()
                self.metrics.job_duration.labels(state="cancelled", quality="none").observe(
                    time.monotonic() - started
                )
        except Exception as error:
            try:
                result = self.queue.fail(
                    job.id,
                    self.owner,
                    f"{type(error).__name__}: {str(error)[:420]}",
                    _is_infrastructure(error),
                    settings.infrastructure_retries,
                    settings.retry_backoff_seconds,
                )
            except RuntimeError:
                pass
            else:
                if result.state == "retry_wait":
                    self.metrics.retries.labels(reason=type(error).__name__).inc()
                else:
                    quality = result.quality_status or "none"
                    self.metrics.jobs.labels(state=result.state, quality=quality).inc()
                    self.metrics.job_duration.labels(state=result.state, quality=quality).observe(
                        time.monotonic() - started
                    )
        finally:
            self.queue.update_worker(self.owner, True, False, self.dependencies_json)
            self.metrics.worker_active.set(0)
            self.metrics.update_queue(self.queue.counts())

    async def _extract(self, job: Job) -> str:
        root = Path(job.spool_path)
        inputs_dir = root / "inputs"
        work = root / "work"
        package = root / "package"
        result_path = root / "result.zip"
        _reset_work_directories(root, work, package)
        manifest_path = root / "manifest.json"
        if manifest_path.is_file():
            manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
            names = manifest_data["inputs"]
            manifest: Path | None = manifest_path
        else:
            names = sorted(path.name for path in inputs_dir.iterdir() if path.is_file())
            manifest = None
        inputs = [inputs_dir / name for name in names]

        async def page_boundary(processed: int, _: int | None) -> None:
            self.metrics.pages.inc()
            self.metrics.page_progress.set(processed / job.total_pages)
            if self.queue.update_progress(job.id, self.owner, processed):
                raise ExtractionCancelled("job cancelled at page boundary")
            statuses = await self.dependencies.check_all()
            if not all(dependency.healthy for dependency in statuses):
                raise InfrastructureFailure("required router became unavailable")

        extractor = Extractor(
            self.config.extraction,
            artifact_dir=work,
            page_callback=page_boundary,
            metrics=self.metrics,
            ocr=self.ocr,
        )
        result = await extractor.extract(inputs, manifest)
        paddle_failure = next(
            (item for item in result.evidence if item.source == "paddle" and not item.valid),
            None,
        )
        if paddle_failure:
            reason = next(iter(paddle_failure.rejection_reasons), "Paddle inference failed")
            raise InfrastructureFailure(reason)
        if any("request_error" in item.rejection_reasons for item in result.evidence):
            raise InfrastructureFailure("one or more model requests failed")
        package.mkdir(mode=0o700)
        result.write_package(package)
        create_package_zip(package, result_path)
        ensure_capacity(
            self.service.spool_dir,
            self.service.limits.max_spool_bytes,
            self.service.limits.min_free_bytes,
        )
        self.queue.complete(
            job.id,
            self.owner,
            result.status.value,
            result_path,
            result_path.stat().st_size,
        )
        return result.status.value

    def cleanup_expired(self) -> None:
        cutoff = time.time() - self.service.limits.retention_seconds
        for job in self.queue.terminal_before(cutoff):
            if self.queue.delete_terminal(job.id):
                remove_job_directory(self.service.spool_dir, job.id)
                self.metrics.cleanup.labels(status="removed").inc()
        used = directory_size(self.service.spool_dir)
        free = shutil.disk_usage(self.service.spool_dir).free
        self.metrics.spool_bytes.set(used)
        self.metrics.spool_free_bytes.set(free)


def _reset_work_directories(root: Path, work: Path, package: Path) -> None:
    for target in (work, package):
        if target.parent.resolve() != root.resolve():
            raise ValueError("unsafe work directory")
        shutil.rmtree(target, ignore_errors=True)
    (root / "result.zip").unlink(missing_ok=True)
    work.mkdir(mode=0o700)


def _is_infrastructure(error: Exception) -> bool:
    return isinstance(error, (InfrastructureFailure, OSError, StoragePressureError, TimeoutError))


def run_worker(config_path: str | Path) -> None:
    asyncio.run(Worker(RuntimeConfig.from_yaml(config_path)).run())
