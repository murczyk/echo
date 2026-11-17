from __future__ import annotations

import hashlib
import hmac
import json
import os
import shutil
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.datastructures import UploadFile

from .dependencies import DependencyChecker
from .job_queue import IdempotencyConflictError, Job, JobQueue, QueueFullError
from .metrics import ServiceMetrics
from .service_config import ADMISSION_RETRY_SECONDS, MULTIPART_OVERHEAD_BYTES, RuntimeConfig, ServiceSettings
from .storage import (
    SpoolStorage,
    StoragePressureError,
    count_pages,
    parse_manifest,
    remove_job_directory,
    request_digest,
    safe_upload_name,
)


class RequestSizeLimitMiddleware:
    def __init__(self, app: object, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: dict[str, object], receive: object, send: object) -> None:
        if scope.get("type") != "http" or scope.get("path") != "/v1/jobs":
            await self.app(scope, receive, send)  # type: ignore[operator]
            return
        headers = dict(scope.get("headers", []))
        try:
            declared = int(headers.get(b"content-length", b"0"))
        except ValueError:
            declared = self.max_bytes + 1
        if declared > self.max_bytes:
            await _payload_too_large()(scope, receive, send)
            return
        received = 0
        response_started = False

        async def limited_receive() -> dict[str, object]:
            nonlocal received
            message = await receive()  # type: ignore[operator]
            received += len(message.get("body", b""))
            if received > self.max_bytes:
                raise _RequestTooLarge
            return message

        async def tracked_send(message: dict[str, object]) -> None:
            nonlocal response_started
            response_started |= message.get("type") == "http.response.start"
            await send(message)  # type: ignore[operator]

        try:
            await self.app(scope, limited_receive, tracked_send)  # type: ignore[operator]
        except _RequestTooLarge:
            if response_started:
                raise
            await _payload_too_large()(scope, receive, send)


class _RequestTooLarge(Exception):
    pass


def _payload_too_large() -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
        content={"detail": "request body exceeds upload limit"},
    )


def create_app(config: RuntimeConfig, start_metrics: bool = False) -> FastAPI:
    service = config.service
    queue = JobQueue(service.database_path, service.limits.max_queue_depth)
    metrics = ServiceMetrics("api")
    dependencies = DependencyChecker(config.extraction)
    token = service.bearer_token()
    storage = SpoolStorage(service.spool_dir)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        service.spool_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if start_metrics:
            metrics.start(service.api_metrics_host, service.api_metrics_port)
        yield

    app = FastAPI(title="Echo Document Extractor", version="1", lifespan=lifespan)
    app.add_middleware(
        RequestSizeLimitMiddleware,
        max_bytes=service.limits.max_input_bytes + MULTIPART_OVERHEAD_BYTES,
    )
    app.state.queue = queue
    app.state.metrics = metrics
    app.state.config = config

    async def authenticate(authorization: str | None = Header(default=None)) -> None:
        scheme, _, candidate = (authorization or "").partition(" ")
        if scheme.casefold() != "bearer" or not hmac.compare_digest(candidate, token):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid bearer token")

    @app.middleware("http")
    async def record_request(request: Request, call_next):
        started = time.monotonic()
        response_status = 500
        try:
            response = await call_next(request)
            response_status = response.status_code
            return response
        finally:
            route = request.scope.get("route")
            route_name = getattr(route, "path", "unmatched")
            metrics.api_requests.labels(
                method=request.method, route=route_name, status=str(response_status)
            ).inc()
            metrics.api_duration.labels(method=request.method, route=route_name).observe(
                time.monotonic() - started
            )

    @app.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "live"}

    @app.get("/health/ready")
    async def ready() -> JSONResponse:
        try:
            queue.counts()
            await storage.ensure_capacity(
                service.limits.max_spool_bytes,
                service.limits.min_free_bytes,
            )
        except Exception as error:
            return JSONResponse(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                content={"status": "not_ready", "error": str(error)[:160]},
            )
        return JSONResponse({"status": "ready"})

    @app.get("/v1/capacity", dependencies=[Depends(authenticate)])
    async def capacity() -> JSONResponse:
        available = queue.capacity()
        headers = {"Cache-Control": "no-store"}
        if not available["available"]:
            headers["Retry-After"] = str(ADMISSION_RETRY_SECONDS)
        return JSONResponse(available, headers=headers)

    @app.post(
        "/v1/jobs", status_code=status.HTTP_202_ACCEPTED, dependencies=[Depends(authenticate)],
        openapi_extra={"requestBody": {"required": True, "content": {"multipart/form-data": {"schema": {
            "type": "object", "required": ["files"], "properties": {
                "files": {"type": "array", "items": {"type": "string", "format": "binary"}},
                "manifest": {"type": "string"},
            },
        }}}}},
    )
    async def submit_job(
        request: Request,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> JSONResponse:
        if not idempotency_key or len(idempotency_key) > 200:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key is required")
        try:
            queue.ensure_submission_capacity(idempotency_key)
        except QueueFullError as error:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, str(error),
                headers={"Retry-After": str(ADMISSION_RETRY_SECONDS)},
            ) from error
        async with request.form() as form:
            files = form.getlist("files")
            manifest = form.get("manifest")
            if not files or any(not isinstance(file, UploadFile) for file in files):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "at least one file is required")
            if manifest is not None and not isinstance(manifest, str):
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "manifest must be text")
            return await _submit_files(
                service, storage, queue, metrics, files, manifest, idempotency_key
            )

    @app.get("/v1/jobs/{job_id}", dependencies=[Depends(authenticate)])
    async def get_job(job_id: str) -> dict[str, object]:
        job = queue.get(job_id)
        if not job:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")
        return _job_payload(job)

    @app.get("/v1/jobs/{job_id}/result", dependencies=[Depends(authenticate)])
    async def get_result(job_id: str) -> FileResponse:
        job = queue.get(job_id)
        if not job:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")
        if job.state != "completed" or not job.result_path:
            raise HTTPException(status.HTTP_409_CONFLICT, "job result is not available")
        result = Path(job.result_path)
        if not result.is_file():
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "job result is missing")
        return FileResponse(result, media_type="application/zip", filename=f"{job.id}.zip")

    @app.delete("/v1/jobs/{job_id}", dependencies=[Depends(authenticate)])
    async def delete_job(job_id: str) -> Response:
        job = queue.get(job_id)
        if not job:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")
        if job.state in {"completed", "failed", "cancelled"}:
            if not queue.delete_terminal(job_id):
                raise HTTPException(status.HTTP_409_CONFLICT, "job state changed")
            remove_job_directory(service.spool_dir, job_id)
            metrics.update_queue(queue.counts())
            return Response(status_code=status.HTTP_204_NO_CONTENT)
        cancelled = queue.cancel(job_id)
        metrics.update_queue(queue.counts())
        return JSONResponse(status_code=202, content=_job_payload(cancelled))

    @app.get("/v1/status", dependencies=[Depends(authenticate)])
    async def service_status() -> dict[str, object]:
        dependency_statuses = await dependencies.check_all()
        for dependency in dependency_statuses:
            metrics.dependency_up.labels(dependency=dependency.name).set(dependency.healthy)
        used, free = await storage.usage(max_age=10.0)
        metrics.spool_bytes.set(used)
        metrics.spool_free_bytes.set(free)
        counts = queue.counts()
        workers = queue.workers(time.time() - service.worker.lease_seconds * 2)
        for worker in workers:
            worker["dependencies"] = json.loads(str(worker["dependencies"]))
        metrics.update_queue(counts)
        return {
            "queue": counts,
            "worker": {
                "instances": workers,
                "max_active_jobs": service.worker.max_active_jobs,
            },
            "paddle": {
                "required": config.extraction.enable_paddle,
                "ready": bool(workers) and all(worker["paddle_ready"] for worker in workers),
                "device": config.extraction.paddle.device,
            },
            "spool": {"bytes": used, "free_bytes": free},
            "routers": [dependency.__dict__ for dependency in dependency_statuses],
        }

    return app


async def _store_uploads(
    uploads: list[UploadFile], incoming: Path, max_bytes: int
) -> tuple[list[str], list[str], int]:
    inputs = incoming / "inputs"
    inputs.mkdir(mode=0o700)
    names: list[str] = []
    digests: list[str] = []
    total = 0
    for upload in uploads:
        name = safe_upload_name(upload.filename)
        if name in names:
            raise ValueError("upload filenames must be unique")
        digest = hashlib.sha256()
        target = inputs / name
        with target.open("xb") as output:
            os.chmod(target, 0o600)
            while chunk := await upload.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError("submission exceeds the 250 MiB input limit")
                digest.update(chunk)
                output.write(chunk)
        await upload.close()
        names.append(name)
        digests.append(digest.hexdigest())
    return names, digests, total


def _job_payload(job: Job | None) -> dict[str, object]:
    if job is None:
        raise RuntimeError("job disappeared")
    progress = job.processed_pages / job.total_pages if job.total_pages else 0.0
    return {
        "id": job.id,
        "state": job.state,
        "attempts": job.attempts,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "started_at": job.started_at,
        "completed_at": job.completed_at,
        "retry_at": job.retry_at,
        "heartbeat_at": job.heartbeat_at,
        "cancel_requested": job.cancel_requested,
        "page_progress": {
            "processed": job.processed_pages,
            "total": job.total_pages,
            "ratio": progress,
        },
        "quality_status": job.quality_status,
        "error_summary": job.error_summary,
    }


async def _submit_files(
    service: ServiceSettings,
    storage: SpoolStorage,
    queue: JobQueue,
    metrics: ServiceMetrics,
    files: list[UploadFile],
    manifest: str | None,
    idempotency_key: str,
) -> JSONResponse:
    try:
        await storage.ensure_capacity(
            service.limits.max_spool_bytes,
            service.limits.min_free_bytes,
        )
    except StoragePressureError as error:
        raise HTTPException(status.HTTP_507_INSUFFICIENT_STORAGE, str(error)) from error
    incoming = service.spool_dir / f".incoming-{uuid.uuid4()}"
    incoming.mkdir(mode=0o700)
    try:
        names, digests, total_bytes = await _store_uploads(
            files, incoming, service.limits.max_input_bytes
        )
        parsed_manifest = parse_manifest(manifest, names)
        if parsed_manifest:
            (incoming / "manifest.json").write_text(
                json.dumps(parsed_manifest, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        native = bool(parsed_manifest and parsed_manifest.get("metadata", {}).get("attachment_native"))
        total_pages = (
            len(names) if native else sum(count_pages(incoming / "inputs" / name) for name in names)
        )
        if total_pages > service.limits.max_pages or len(names) > service.limits.max_pages:
            raise ValueError("submission exceeds the 200 page/file limit")
        await storage.ensure_capacity(
            service.limits.max_spool_bytes,
            service.limits.min_free_bytes,
        )
        digest = request_digest(list(zip(names, digests, strict=True)), parsed_manifest)
        job_id = str(uuid.uuid4())
        final_dir = service.spool_dir / job_id
        os.replace(incoming, final_dir)
        try:
            job, created = queue.submit(
                job_id,
                idempotency_key,
                digest,
                final_dir,
                total_bytes,
                total_pages,
            )
        except Exception:
            remove_job_directory(service.spool_dir, job_id)
            raise
        if not created:
            remove_job_directory(service.spool_dir, job_id)
        metrics.update_queue(queue.counts())
        return JSONResponse(status_code=202, content=_job_payload(job))
    except IdempotencyConflictError as error:
        raise HTTPException(status.HTTP_409_CONFLICT, str(error)) from error
    except QueueFullError as error:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, str(error),
            headers={"Retry-After": str(ADMISSION_RETRY_SECONDS)},
        ) from error
    except StoragePressureError as error:
        raise HTTPException(status.HTTP_507_INSUFFICIENT_STORAGE, str(error)) from error
    except ValueError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(error)) from error
    finally:
        shutil.rmtree(incoming, ignore_errors=True)
