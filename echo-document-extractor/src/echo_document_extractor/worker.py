from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import sys
import threading
import time
import uuid
from pathlib import Path

from .adapters import GatewayAdapter, GemmaAdapter, NuExtract3Adapter
from .dependencies import DependencyChecker
from .job_queue import Job, JobQueue
from .metrics import ServiceMetrics
from .models import Evidence
from .ocr import PaddleEvidenceProvider
from .package_archive import create_package_zip
from .pipeline import ExtractionCancelled, Extractor, InputManifest
from .service_config import RuntimeConfig
from .storage import StoragePressureError, count_pages, directory_size, ensure_capacity, remove_job_directory


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
    ) -> None:
        self.queue = queue
        self.job = job
        self.owner = owner
        self.interval = interval
        self.lease = lease
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
        self.adapters = [
            NuExtract3Adapter(config.extraction.nu_extract, config.extraction.endpoint_concurrency),
            GemmaAdapter(config.extraction.gemma, config.extraction.endpoint_concurrency),
        ]
        self.paddle_semaphore = asyncio.Semaphore(1)
        self.active_tasks: set[asyncio.Task[None]] = set()
        self.progress: dict[str, float] = {}
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
            self._reap_tasks()
            self.queue.recover_expired(
                settings.infrastructure_retries,
                settings.retry_backoff_seconds,
            )
            if time.monotonic() - last_cleanup >= 60:
                self.cleanup_expired()
                last_cleanup = time.monotonic()
            statuses = await self.dependencies.check_all(include_gemma=False)
            self.dependencies_json = json.dumps(
                [status.__dict__ for status in statuses], separators=(",", ":")
            )
            for dependency in statuses:
                self.metrics.dependency_up.labels(dependency=dependency.name).set(dependency.healthy)
            self._start_jobs(native_only=not all(item.healthy for item in statuses))
            self._update_runtime_state()
            if self.active_tasks:
                await asyncio.wait(
                    self.active_tasks,
                    timeout=settings.poll_seconds,
                    return_when=asyncio.FIRST_COMPLETED,
                )
            else:
                await asyncio.sleep(settings.poll_seconds)

    def _reap_tasks(self) -> None:
        completed = {task for task in self.active_tasks if task.done()}
        self.active_tasks.difference_update(completed)
        for task in completed:
            task.result()

    def _start_jobs(self, native_only: bool = False) -> None:
        settings = self.service.worker
        while len(self.active_tasks) < settings.max_active_jobs:
            job = self.queue.claim(
                self.owner,
                settings.lease_seconds,
                settings.max_active_jobs,
                native_only=native_only,
            )
            if not job:
                return
            self.progress[job.id] = 0
            self.active_tasks.add(asyncio.create_task(self.process(job), name=f"job-{job.id}"))

    def _update_runtime_state(self) -> None:
        active_jobs = len(self.active_tasks)
        self.queue.update_worker(self.owner, True, active_jobs, self.dependencies_json)
        self.metrics.worker_active.set(active_jobs)
        progress = sum(self.progress.values()) / len(self.progress) if self.progress else 0
        self.metrics.page_progress.set(progress)
        self.metrics.update_queue(self.queue.counts())

    async def process(self, job: Job) -> None:
        settings = self.service.worker
        started = time.monotonic()
        heartbeat = LeaseHeartbeat(
            self.queue,
            job,
            self.owner,
            settings.heartbeat_seconds,
            settings.lease_seconds,
        )
        try:
            with heartbeat:
                quality = await self._extract(job)
                if heartbeat.lost:
                    raise InfrastructureFailure("job heartbeat lease was lost")
            self.metrics.jobs.labels(state="completed", quality=quality).inc()
            self.metrics.job_duration.labels(state="completed", quality=quality).observe(
                time.monotonic() - started
            )
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
            self.progress.pop(job.id, None)

    async def _extract(self, job: Job) -> str:
        root = Path(job.spool_path)
        work = root / "work"
        package = root / "package"
        result_path = root / "result.zip"
        _reset_work_directories(root, work, package)
        inputs, manifest = _job_inputs(root)
        metadata = json.loads(manifest.read_text()).get("metadata", {}) if manifest else {}
        if metadata.get("attachment_native"):
            return await self._extract_native(job, inputs, work, package, result_path)
        statuses = await self.dependencies.check_all(
            include_gemma=manifest is None or manifest_uses_legacy_gemma(manifest)
        )
        if not all(dependency.healthy for dependency in statuses):
            raise InfrastructureFailure("required OCR router is unavailable")

        async def page_boundary(processed: int, _: int | None) -> None:
            self.metrics.pages.inc()
            self.progress[job.id] = processed / job.total_pages
            if self.queue.update_progress(job.id, self.owner, processed):
                raise ExtractionCancelled("job cancelled at page boundary")
            statuses = await self.dependencies.check_all(
                include_gemma=manifest is None or manifest_uses_legacy_gemma(manifest)
            )
            if not all(dependency.healthy for dependency in statuses):
                raise InfrastructureFailure("required router became unavailable")

        adapters = self._adapters_for_manifest(manifest)
        extractor = Extractor(
            self.config.extraction,
            adapters=adapters,
            artifact_dir=work,
            page_callback=page_boundary,
            metrics=self.metrics,
            ocr=self.ocr,
            paddle_semaphore=self.paddle_semaphore,
        )
        result = await extractor.extract(inputs, manifest)
        paddle_failure = next(
            (item for item in result.evidence if item.source == "paddle" and not item.valid),
            None,
        )
        if paddle_failure:
            reason = next(iter(paddle_failure.rejection_reasons), "Paddle inference failed")
            raise InfrastructureFailure(reason)
        remote_families = {"nuextract3", adapters[-1].name}
        if _all_remote_model_families_failed(result.evidence, remote_families) and (
            job.attempts <= self.service.worker.infrastructure_retries
        ):
            raise InfrastructureFailure("all remote model families failed")
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

    async def _extract_native(
        self, job: Job, inputs: list[Path], work: Path, package: Path, result_path: Path
    ) -> str:
        from lxml import html

        from .documents import load

        if len(inputs) != 1:
            raise ValueError("native document jobs require exactly one attachment")
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "echo_document_extractor.documents",
            str(inputs[0]),
            str(package),
            env={
                key: value
                for key, value in os.environ.items()
                if key in {"PATH", "PYTHONPATH", "LANG", "LC_ALL", "HOME", "TMPDIR"}
            },
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, errors = await asyncio.wait_for(process.communicate(), timeout=180)
        except BaseException:
            process.kill()
            await process.wait()
            raise
        if process.returncode:
            raise ValueError(f"native extraction failed: {errors.decode(errors='replace')[-500:]}")
        document = load(package)
        manifest_path = Path(job.spool_path) / "manifest.json"
        metadata = json.loads(manifest_path.read_text()).get("metadata", {})
        processed_pages = 0
        for index, embedded in enumerate(document.images):
            source_path = package / embedded["path"]
            try:
                source_path, page_offset = _inspection_page(source_path, work, metadata)
                pages = count_pages(source_path)
            except ValueError as error:
                document.warnings.append(f"{embedded['member']}: {embedded['locator']}: {error}")
                continue
            if processed_pages + pages > self.service.limits.max_pages:
                document.warnings.append("embedded OCR page limit; inspect a specific original page")
                continue
            processed_pages += pages
            if self.queue.update_progress(job.id, self.owner, index):
                raise ExtractionCancelled("native document job cancelled")
            markup, status = await self._native_image(job, source_path, work, index)
            if status != "accepted":
                document.warnings.append(f'{embedded["member"]}: {embedded["locator"]}: OCR {status}')
            root = html.fromstring(markup)
            pages = root.xpath("//section") or [root]
            for number, page in enumerate(pages, 1):
                document.add(
                    embedded["member"],
                    f"{embedded['locator']}; page {number + page_offset}",
                    "\n".join(page.itertext()),
                    html.tostring(page, encoding="unicode"),
                )
        document.images.clear()
        document.write(package)
        create_package_zip(package, result_path, native=True)
        ensure_capacity(
            self.service.spool_dir, self.service.limits.max_spool_bytes, self.service.limits.min_free_bytes
        )
        quality = "degraded" if document.warnings else "accepted"
        self.queue.complete(job.id, self.owner, quality, result_path, result_path.stat().st_size)
        return quality

    async def _native_image(self, job: Job, source: Path, work: Path, index: int) -> tuple[str, str]:
        from .native_ocr import extract

        manifest = json.loads((Path(job.spool_path) / "manifest.json").read_text())
        import httpx
        try:
            remote = await extract(source, f"native-{job.id}-{index}", manifest)
        except httpx.TransportError as error:
            raise InfrastructureFailure("embedded OCR transport unavailable") from error
        except httpx.HTTPStatusError as error:
            if error.response.status_code in {429, 502, 503, 504}:
                raise InfrastructureFailure("embedded OCR service busy") from error
            raise
        if remote is not None:
            return remote
        statuses = await self.dependencies.check_all(include_gemma=True)
        if not all(item.healthy for item in statuses):
            raise InfrastructureFailure("embedded image OCR dependencies unavailable")
        extractor = Extractor(self.config.extraction, adapters=self._adapters_for_manifest(
            Path(job.spool_path) / "manifest.json"), artifact_dir=work / f"image-{index}",
            metrics=self.metrics, ocr=self.ocr, paddle_semaphore=self.paddle_semaphore)
        result = await extractor.extract([source], None)
        return result.canonical_html, result.status.value

    def _adapters_for_manifest(self, manifest: Path | None):
        if manifest is None:
            return self.adapters
        parsed = InputManifest.model_validate(json.loads(manifest.read_text(encoding="utf-8")))
        if parsed.ocr is None:
            return self.adapters
        ocr = parsed.ocr
        return [
            NuExtract3Adapter(self.config.extraction.nu_extract, self.config.extraction.endpoint_concurrency),
            GatewayAdapter(
                ocr.gateway_url,
                ocr.grant,
                ocr.engine_id,
                ocr.engine_name,
                ocr.model_name,
                ocr.request_profile,
                ocr.instance_id,
            ),
        ]

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


def _job_inputs(root: Path) -> tuple[list[Path], Path | None]:
    inputs_dir = root / "inputs"
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        names = sorted(path.name for path in inputs_dir.iterdir() if path.is_file())
        return [inputs_dir / name for name in names], None
    manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
    names = manifest_data["inputs"]
    runtime_manifest = inputs_dir / ".manifest.json"
    runtime_manifest.write_text(json.dumps(manifest_data), encoding="utf-8")
    return [inputs_dir / name for name in names], runtime_manifest


def _all_remote_model_families_failed(
    evidence: list[Evidence], sources: set[str] | None = None
) -> bool:
    for source in sources or {"nuextract3", "gemma"}:
        responses = [item for item in evidence if item.source == source]
        if not responses or any(
            not any(reason.startswith("request_error") for reason in item.rejection_reasons)
            for item in responses
        ):
            return False
    return True


def manifest_uses_legacy_gemma(manifest: Path) -> bool:
    parsed = InputManifest.model_validate(json.loads(manifest.read_text(encoding="utf-8")))
    return parsed.ocr is None


def _is_infrastructure(error: Exception) -> bool:
    return isinstance(error, (InfrastructureFailure, OSError, StoragePressureError, TimeoutError))


def run_worker(config_path: str | Path) -> None:
    asyncio.run(Worker(RuntimeConfig.from_yaml(config_path)).run())


def _inspection_page(path: Path, work: Path, metadata: dict) -> tuple[Path, int]:
    import re
    from contextlib import closing

    import pypdfium2 as pdfium

    locator = metadata.get("inspection_locator") or ""
    match = re.fullmatch(r"page\s+(\d+)", locator, re.IGNORECASE)
    if not match or path.suffix.lower() != ".pdf":
        return path, 0
    number = int(match.group(1))
    target = work / f"inspection-{path.stem}-{number}.pdf"
    with closing(pdfium.PdfDocument(str(path))) as source, closing(pdfium.PdfDocument.new()) as selected:
        if not 1 <= number <= len(source):
            raise ValueError("requested page is outside the original PDF")
        selected.import_pages(source, pages=[number - 1])
        selected.save(str(target))
    return target, number - 1
