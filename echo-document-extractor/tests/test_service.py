from __future__ import annotations

import asyncio
import hashlib
import io
import json
import sqlite3
import threading
import time
import zipfile
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from echo_document_extractor import storage
from echo_document_extractor.adapters import GEMMA_END_MARKER, GemmaAdapter, ModelRequest
from echo_document_extractor.api import create_app
from echo_document_extractor.config import EndpointConfig, ExtractionConfig, PaddleRuntimeConfig
from echo_document_extractor.dependencies import DependencyChecker
from echo_document_extractor.job_queue import IdempotencyConflictError, JobQueue, QueueFullError
from echo_document_extractor.models import Evidence
from echo_document_extractor.ocr import (
    PaddleEvidenceProvider,
    _create_ocr_pipeline,
    _ocr_pipeline_key,
)
from echo_document_extractor.package_archive import validate_package_zip
from echo_document_extractor.pipeline import _resolve_inputs
from echo_document_extractor.service_config import RuntimeConfig, ServiceLimits, ServiceSettings
from echo_document_extractor.storage import StoragePressureError, ensure_capacity, parse_manifest
from echo_document_extractor.worker import Worker, _all_remote_model_families_failed, _job_inputs

TOKEN = "a" * 48


def test_cpu_ocr_preserves_source_coordinates_and_disables_mkldnn() -> None:
    options: dict[str, object] = {}

    def factory(**values: object) -> object:
        options.update(values)
        return object()

    _create_ocr_pipeline(factory, "ru", PaddleRuntimeConfig())
    assert options["enable_mkldnn"] is False
    assert options["use_doc_orientation_classify"] is True
    assert options["use_doc_unwarping"] is False
    assert options["use_textline_orientation"] is True


def test_structure_table_recognition_can_be_skipped_for_detected_grid() -> None:
    class Structure:
        options: dict[str, object] = {}

        def predict(self, _array: object, **options: object) -> list[object]:
            self.options = options
            return []

    provider = PaddleEvidenceProvider(enabled=False)
    provider.enabled = True
    provider._structure = Structure()

    provider.extract_all(
        Image.new("RGB", (20, 20), "white"),
        "p1",
        use_table_recognition=False,
    )

    assert provider._structure.options == {"use_table_recognition": False}


def test_identical_language_recognition_models_share_one_pipeline() -> None:
    runtime = PaddleRuntimeConfig(
        ocr_common={"text_detection_model_dir": "/models/detection"},
        ocr_languages={
            "ru": {"text_recognition_model_dir": "/models/eslav"},
            "uk": {"text_recognition_model_dir": "/models/eslav"},
            "en": {"text_recognition_model_dir": "/models/en"},
        },
    )

    assert _ocr_pipeline_key("ru", runtime) == _ocr_pipeline_key("uk", runtime)
    assert _ocr_pipeline_key("ru", runtime) != _ocr_pipeline_key("en", runtime)


def runtime_config(tmp_path: Path, **limits: int) -> RuntimeConfig:
    endpoint = EndpointConfig(
        url="http://router.test/v1",
        model_id="expected/model",
        revision="revision",
        token_env="ROUTER_TOKEN",
    )
    service_limits = ServiceLimits(
        max_input_bytes=limits.get("max_input_bytes", 1024 * 1024),
        max_pages=limits.get("max_pages", 200),
        max_queue_depth=limits.get("max_queue_depth", 25),
        max_spool_bytes=limits.get("max_spool_bytes", 1024**3),
        min_free_bytes=limits.get("min_free_bytes", 1),
        retention_seconds=60,
    )
    service = ServiceSettings(
        state_dir=tmp_path,
        spool_dir=tmp_path / "spool",
        database_path=tmp_path / "jobs.sqlite3",
        limits=service_limits,
    )
    return RuntimeConfig(
        service=service,
        extraction=ExtractionConfig(
            nu_extract=endpoint,
            gemma=endpoint,
            enable_paddle=False,
        ),
    )


def png_bytes(color: str = "white") -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (32, 24), color).save(output, "PNG")
    return output.getvalue()


def auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}", "Idempotency-Key": "key-1"}


def test_api_authentication_idempotency_and_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ECHO_DOCUMENT_EXTRACTOR_TOKEN", TOKEN)
    app = create_app(runtime_config(tmp_path))
    with TestClient(app) as client:
        assert client.get("/health/live").status_code == 200
        assert client.get("/v1/status").status_code == 401
        first = client.post(
            "/v1/jobs",
            headers=auth(),
            files=[("files", ("page.png", png_bytes(), "image/png"))],
        )
        assert first.status_code == 202
        job_id = first.json()["id"]
        duplicate = client.post(
            "/v1/jobs",
            headers=auth(),
            files=[("files", ("page.png", png_bytes(), "image/png"))],
        )
        assert duplicate.status_code == 202
        assert duplicate.json()["id"] == job_id
        conflict = client.post(
            "/v1/jobs",
            headers=auth(),
            files=[("files", ("page.png", png_bytes("black"), "image/png"))],
        )
        assert conflict.status_code == 409
        cancelled = client.delete(f"/v1/jobs/{job_id}", headers={"Authorization": f"Bearer {TOKEN}"})
        assert cancelled.status_code == 202
        assert cancelled.json()["state"] == "cancelled"
        deleted = client.delete(f"/v1/jobs/{job_id}", headers={"Authorization": f"Bearer {TOKEN}"})
        assert deleted.status_code == 204


async def test_slow_spool_scan_does_not_block_live_or_duplicate_status_scans(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ECHO_DOCUMENT_EXTRACTOR_TOKEN", TOKEN)
    started = threading.Event()
    release = threading.Event()
    scans = 0

    def slow_scan(_path: Path) -> int:
        nonlocal scans
        scans += 1
        started.set()
        assert release.wait(5)
        return 0

    async def healthy_dependencies(_self: DependencyChecker) -> list:
        return []

    monkeypatch.setattr(storage, "directory_size", slow_scan)
    monkeypatch.setattr(DependencyChecker, "check_all", healthy_dependencies)
    app = create_app(runtime_config(tmp_path))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        first = asyncio.create_task(client.get("/v1/status", headers=auth()))
        second = None
        try:
            assert await asyncio.to_thread(started.wait, 2)
            second = asyncio.create_task(client.get("/v1/status", headers=auth()))
            live = await asyncio.wait_for(client.get("/health/live"), timeout=1)
            assert live.status_code == 200
            assert not first.done()
        finally:
            release.set()
            responses = await asyncio.gather(first, *([second] if second else []))
        assert all(response.status_code == 200 for response in responses)
        assert scans == 1


async def test_admission_rechecks_capacity_after_cached_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ECHO_DOCUMENT_EXTRACTOR_TOKEN", TOKEN)

    async def healthy_dependencies(_self: DependencyChecker) -> list:
        return []

    monkeypatch.setattr(DependencyChecker, "check_all", healthy_dependencies)
    config = runtime_config(tmp_path, max_spool_bytes=1024)
    app = create_app(config)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        assert (await client.get("/v1/status", headers=auth())).json()["spool"]["bytes"] == 0
        retained = config.service.spool_dir / "retained-result"
        retained.write_bytes(b"x" * 2048)
        assert (await client.get("/health/ready")).status_code == 503
        response = await client.post(
            "/v1/jobs", headers=auth(), files=[("files", ("page.png", png_bytes(), "image/png"))]
        )
        assert response.status_code == 507
        assert retained.stat().st_size == 2048
        assert app.state.queue.counts().get("queued", 0) == 0


def test_api_rejects_limits_malformed_files_and_traversal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ECHO_DOCUMENT_EXTRACTOR_TOKEN", TOKEN)
    app = create_app(runtime_config(tmp_path, max_input_bytes=10))
    with TestClient(app) as client:
        body_limited = client.post(
            "/v1/jobs",
            headers={**auth(), "Content-Length": str(2 * 1024 * 1024 + 11)},
            files=[("files", ("page.png", b"x", "image/png"))],
        )
        assert body_limited.status_code == 413
        oversized = client.post(
            "/v1/jobs",
            headers=auth(),
            files=[("files", ("page.png", png_bytes(), "image/png"))],
        )
        assert oversized.status_code == 422
        traversal = client.post(
            "/v1/jobs",
            headers={**auth(), "Idempotency-Key": "key-2"},
            files=[("files", ("../page.png", b"x", "image/png"))],
        )
        assert traversal.status_code == 422
        malformed = client.post(
            "/v1/jobs",
            headers={**auth(), "Idempotency-Key": "key-3"},
            files=[("files", ("bad.pdf", b"not a pdf", "application/pdf"))],
        )
        assert malformed.status_code == 422


def test_api_rejects_images_over_the_pixel_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ECHO_DOCUMENT_EXTRACTOR_TOKEN", TOKEN)
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 100)
    app = create_app(runtime_config(tmp_path))
    with TestClient(app) as client:
        response = client.post(
            "/v1/jobs", headers=auth(), files=[("files", ("page.png", png_bytes(), "image/png"))]
        )
        assert response.status_code == 422
        assert "pixel limit" in response.json()["detail"]
        assert app.state.queue.counts().get("queued", 0) == 0


def test_manifest_requires_exact_safe_order() -> None:
    value = json.dumps({"inputs": ["a.png", "b.png"], "metadata": {"source": "test"}})
    assert parse_manifest(value, ["a.png", "b.png"])["metadata"] == {"source": "test"}
    with pytest.raises(ValueError, match="exactly match"):
        parse_manifest(value, ["b.png", "a.png"])
    with pytest.raises(ValueError, match="InputManifest"):
        parse_manifest(json.dumps({"inputs": ["../a.png"]}), ["../a.png"])


def test_worker_resolves_manifest_inputs_from_upload_directory(tmp_path: Path) -> None:
    inputs_dir = tmp_path / "inputs"
    inputs_dir.mkdir()
    first = inputs_dir / "a.png"
    second = inputs_dir / "b.png"
    first.write_bytes(png_bytes())
    second.write_bytes(png_bytes("black"))
    (tmp_path / "manifest.json").write_text(
        json.dumps({"inputs": [first.name, second.name]}), encoding="utf-8"
    )

    inputs, manifest = _job_inputs(tmp_path)

    assert inputs == [first, second]
    assert manifest is not None
    assert manifest.parent == inputs_dir
    assert _resolve_inputs(inputs, manifest)[0] == inputs


def test_queue_depth_lease_recovery_retry_and_idempotency(tmp_path: Path) -> None:
    queue = JobQueue(tmp_path / "jobs.sqlite3", max_depth=1)
    first, created = queue.submit("00000000-0000-0000-0000-000000000001", "key", "digest", tmp_path, 1, 1)
    assert created
    same, created = queue.submit("00000000-0000-0000-0000-000000000002", "key", "digest", tmp_path, 1, 1)
    assert not created and same.id == first.id
    with pytest.raises(IdempotencyConflictError):
        queue.submit("00000000-0000-0000-0000-000000000003", "key", "other", tmp_path, 1, 1)
    with pytest.raises(QueueFullError):
        queue.submit("00000000-0000-0000-0000-000000000004", "other", "digest", tmp_path, 1, 1)
    running = queue.claim("worker", 30)
    assert running and running.state == "running" and running.attempts == 1
    with queue.connect() as connection:
        connection.execute("UPDATE jobs SET lease_expires_at = ? WHERE id = ?", (time.time() - 1, running.id))
    assert queue.recover_expired(3, (0, 0, 0)) == 1
    recovered = queue.get(running.id)
    assert recovered and recovered.state == "retry_wait" and recovered.error_summary == "worker lease expired"


def test_queue_initialization_retries_database_lock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    initialize_database = JobQueue._initialize_database
    attempts = 0

    def initialize_after_lock(queue: JobQueue) -> None:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise sqlite3.OperationalError("database is locked")
        initialize_database(queue)

    monkeypatch.setattr(JobQueue, "_initialize_database", initialize_after_lock)
    monkeypatch.setattr(time, "sleep", lambda _: None)
    JobQueue(tmp_path / "jobs.sqlite3")
    assert attempts == 3


def test_running_cancellation_is_observed_at_progress_boundary(tmp_path: Path) -> None:
    queue = JobQueue(tmp_path / "jobs.sqlite3")
    submitted, _ = queue.submit("00000000-0000-0000-0000-000000000001", "key", "digest", tmp_path, 1, 2)
    running = queue.claim("worker", 30)
    assert running and running.id == submitted.id
    cancelled = queue.cancel(running.id)
    assert cancelled and cancelled.state == "running" and cancelled.cancel_requested
    with pytest.raises(RuntimeError, match="lease was lost"):
        queue.complete(running.id, "worker", "accepted", tmp_path / "result.zip", 1)
    assert queue.update_progress(running.id, "worker", 1)
    final = queue.fail(running.id, "worker", "cancelled", False, 3, (1, 2, 3))
    assert final.state == "cancelled"


def test_queue_claims_up_to_configured_active_job_limit(tmp_path: Path) -> None:
    queue = JobQueue(tmp_path / "jobs.sqlite3")
    for index in range(3):
        queue.submit(
            f"00000000-0000-0000-0000-00000000000{index + 1}",
            f"key-{index}",
            f"digest-{index}",
            tmp_path,
            1,
            1,
        )

    assert queue.claim("worker", 30, max_active_jobs=2) is not None
    assert queue.claim("worker", 30, max_active_jobs=2) is not None
    assert queue.claim("worker", 30, max_active_jobs=2) is None


async def test_native_storage_admission_preserves_job_and_retry_budget_3743(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    worker = Worker(runtime_config(tmp_path), start_metrics=False)
    root = worker.service.spool_dir / "native-job"
    (root / "inputs").mkdir(parents=True)
    source = root / "inputs" / "page.png"
    source.write_bytes(png_bytes())
    manifest = {"inputs": [source.name], "metadata": {"attachment_native": True}}
    (root / "manifest.json").write_text(json.dumps(manifest))
    job, _ = worker.queue.submit("native-job", "local-key", "digest", root, source.stat().st_size, 1)
    html = b"<html><body><section>Recovered OCR text</section></body></html>"
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w") as archive:
        archive.writestr("document.html", html)
        archive.writestr("manifest.json", json.dumps({
            "file_hashes": {"document.html": hashlib.sha256(html).hexdigest()}
        }))
    keys = []

    def upstream(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            keys.append(request.headers["Idempotency-Key"])
            assert source.read_bytes() in request.content
            if len(keys) <= 6:
                return httpx.Response(507)
            return httpx.Response(202, json={"id": "upstream-job"})
        if request.url.path.endswith("/result"):
            return httpx.Response(200, content=result.getvalue())
        return httpx.Response(200, json={"state": "completed", "quality_status": "accepted"})

    client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client(
        transport=httpx.MockTransport(upstream), **kwargs
    ))
    monkeypatch.setenv("ECHO_NATIVE_OCR_BASE_URL", "http://upstream.test")
    monkeypatch.setenv("ECHO_NATIVE_OCR_TOKEN", TOKEN)
    for _ in range(6):
        running = worker.queue.claim(worker.owner, 300)
        assert running and running.id == job.id and running.attempts == 1
        before = time.time()
        await worker.process(running)
        deferred = worker.queue.get(job.id)
        assert deferred.state == "retry_wait" and deferred.attempts == 0
        assert deferred.retry_at >= before + 60
        assert deferred.lease_owner is None and deferred.lease_expires_at is None
        assert deferred.idempotency_key == job.idempotency_key
        assert source.is_file() and (root / "manifest.json").read_text() == json.dumps(manifest)
        with worker.queue.connect() as connection:
            connection.execute("UPDATE jobs SET retry_at = 0 WHERE id = ?", (job.id,))
    await worker.process(worker.queue.claim(worker.owner, 300))
    completed = worker.queue.get(job.id)
    assert completed.state == "completed" and completed.attempts == 1
    validate_package_zip(Path(completed.result_path))
    with zipfile.ZipFile(completed.result_path) as archive:
        assert b"Recovered OCR text" in archive.read("document.html")
    assert keys == ["native-native-job-0"] * 7
    assert worker.metrics.storage_deferrals._value.get() == 6


@pytest.mark.parametrize("loss", ["owner", "expired", "cancel"])
def test_storage_deferral_respects_lease_and_cancellation(tmp_path: Path, loss: str) -> None:
    queue = JobQueue(tmp_path / "jobs.sqlite3")
    job, _ = queue.submit("job", "key", "digest", tmp_path, 1, 1)
    queue.claim("worker", 300)
    if loss == "cancel":
        queue.cancel(job.id)
        deferred = queue.defer_storage(job.id, "worker", "HTTP 507", 60)
        assert deferred.state == "cancelled" and deferred.retry_at is None
        assert deferred.attempts == 0 and deferred.lease_owner is None
    else:
        if loss == "expired":
            with queue.connect() as connection:
                connection.execute("UPDATE jobs SET lease_expires_at = 0 WHERE id = ?", (job.id,))
        before = queue.get(job.id)
        with pytest.raises(RuntimeError, match="lease was lost"):
            queue.defer_storage(job.id, "other" if loss == "owner" else "worker", "HTTP 507", 60)
        assert queue.get(job.id) == before


@pytest.mark.parametrize("method,status", [("POST", 400), ("POST", 503), ("GET", 507)])
async def test_unrelated_upstream_errors_keep_existing_retry_behavior(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, method: str, status: int
) -> None:
    worker = Worker(runtime_config(tmp_path), start_metrics=False)
    source = tmp_path / "page.png"
    source.write_bytes(png_bytes())
    (tmp_path / "manifest.json").write_text("{}")
    job, _ = worker.queue.submit("job", "key", "digest", tmp_path, 1, 1)
    client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client(
        transport=httpx.MockTransport(lambda request: httpx.Response(
            status if request.method == method else 202, json={"id": "upstream"}
        )), **kwargs
    ))
    monkeypatch.setenv("ECHO_NATIVE_OCR_BASE_URL", "http://upstream.test")
    monkeypatch.setenv("ECHO_NATIVE_OCR_TOKEN", TOKEN)

    async def extract(running):
        return (await worker._native_image(running, source, tmp_path, 0))[1]

    monkeypatch.setattr(worker, "_extract", extract)
    await worker.process(worker.queue.claim(worker.owner, 300))
    failed = worker.queue.get(job.id)
    assert failed.attempts == 1
    assert failed.state == ("retry_wait" if status == 503 else "failed")
    assert worker.metrics.storage_deferrals._value.get() == 0


def test_gemma_request_stops_at_bounded_end_marker() -> None:
    endpoint = EndpointConfig(
        url="http://router.test/v1",
        model_id="expected/model",
        revision="revision",
        token_env="ROUTER_TOKEN",
        max_tokens=6000,
    )
    request = ModelRequest(
        request_id="request",
        unit_id="unit",
        page_id="p1",
        raster_sha256="0" * 64,
        crop_bbox=(0, 0, 1, 1),
        profile="split_gpu",
        prompt_version="semantic-html-v2",
        image_png=b"png",
    )

    payload = GemmaAdapter(endpoint)._request_body(request)

    assert payload["stop"] == [GEMMA_END_MARKER]
    assert payload["include_stop_str_in_output"] is True
    assert payload["max_tokens"] == 6000


def test_remote_failure_retries_only_when_both_model_families_failed() -> None:
    nu_failure = Evidence(
        id="nu",
        source="nuextract3",
        valid=False,
        rejection_reasons=["request_error"],
    )
    gemma_failure = Evidence(
        id="gemma",
        source="gemma",
        valid=False,
        rejection_reasons=["request_error:TimeoutError"],
    )
    gemma_response = Evidence(id="gemma-ok", source="gemma", valid=True)

    assert _all_remote_model_families_failed([nu_failure, gemma_failure])
    assert not _all_remote_model_families_failed([nu_failure, gemma_response])


def test_storage_pressure_never_removes_existing_jobs(tmp_path: Path) -> None:
    spool = tmp_path / "spool"
    spool.mkdir()
    retained = spool / "retained"
    retained.write_bytes(b"12345")
    with pytest.raises(StoragePressureError, match="capacity"):
        ensure_capacity(spool, 5, 1)
    assert retained.read_bytes() == b"12345"


@pytest.mark.asyncio
async def test_dependency_check_requires_exact_model(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    config = runtime_config(tmp_path).extraction

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def get(self, url: str, headers: dict[str, str]):
            if url.endswith("/health"):
                return httpx.Response(200, request=httpx.Request("GET", url))
            return httpx.Response(
                200,
                json={"data": [{"id": "wrong/model"}]},
                request=httpx.Request("GET", url),
            )

    monkeypatch.setattr(httpx, "AsyncClient", lambda **_: FakeClient())
    statuses = await DependencyChecker(config).check_all()
    assert not any(item.healthy for item in statuses)
    assert all(item.error == "expected model is not served" for item in statuses)


def test_zip_validation_rejects_traversal_and_accepts_canonical_members(tmp_path: Path) -> None:
    unsafe = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(unsafe, "w") as archive:
        archive.writestr("../escape", b"x")
    with pytest.raises(ValueError, match="unsafe"):
        validate_package_zip(unsafe)


def test_native_attachment_job_runs_without_ocr_dependency_and_packages_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    from echo_document_extractor.worker import Worker

    monkeypatch.setenv("ECHO_DOCUMENT_EXTRACTOR_TOKEN", TOKEN)
    config = runtime_config(tmp_path)
    app = create_app(config)
    with TestClient(app) as client:
        ordinary = client.post(
            "/v1/jobs", headers=auth(), files=[("files", ("scan.png", png_bytes(), "image/png"))]
        )
        assert ordinary.status_code == 202
        response = client.post(
            "/v1/jobs",
            headers={**auth(), "Idempotency-Key": "native-1"},
            files=[("files", ("order.txt", "Позиція Береза".encode(), "text/plain"))],
            data={
                "manifest": json.dumps(
                    {"schema_version": 1, "inputs": ["order.txt"], "metadata": {"attachment_native": True}}
                )
            },
        )
        assert response.status_code == 202
        worker = Worker(config, start_metrics=False)
        job = worker.queue.claim(worker.owner, 30, native_only=True)
        assert job is not None and job.id == response.json()["id"]
        asyncio.run(worker.process(job))
        state = client.get(f"/v1/jobs/{job.id}", headers=auth()).json()
        assert state["state"] == "completed", state
        content = client.get(f"/v1/jobs/{job.id}/result", headers=auth())
        with zipfile.ZipFile(io.BytesIO(content.content)) as archive:
            payload = json.loads(archive.read("document.json"))
            assert payload["sections"][0]["text"] == "Позиція Береза"
        assert client.get(f"/v1/jobs/{ordinary.json()['id']}", headers=auth()).json()["state"] == "queued"


def test_capacity_is_authenticated_and_does_not_touch_spool(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ECHO_DOCUMENT_EXTRACTOR_TOKEN", TOKEN)
    app = create_app(runtime_config(tmp_path, max_queue_depth=1))
    with TestClient(app) as client:
        def forbidden(*_args: object, **_kwargs: object) -> None:
            raise AssertionError("capacity must not inspect the spool or dependencies")

        monkeypatch.setattr("echo_document_extractor.storage.SpoolStorage.usage", forbidden)
        monkeypatch.setattr("echo_document_extractor.storage.directory_size", forbidden)
        assert client.get("/v1/capacity").status_code == 401
        available = client.get("/v1/capacity", headers=auth())
        assert available.json() == {"limit": 1, "active": 0, "available": 1, "retry_after_seconds": 0}
        assert available.headers["cache-control"] == "no-store"
        app.state.queue.submit("one", "first", "digest", tmp_path, 1, 1)
        full = client.get("/v1/capacity", headers=auth())
        assert full.json() == {"limit": 1, "active": 1, "available": 0, "retry_after_seconds": 30}
        assert full.headers["retry-after"] == "30"
        running = app.state.queue.claim("worker", 30)
        assert client.get("/v1/capacity", headers=auth()).json()["active"] == 1
        app.state.queue.complete(running.id, "worker", "accepted", tmp_path / "result.zip", 1)
        assert client.get("/v1/capacity", headers=auth()).json()["available"] == 1


def test_full_queue_rejects_before_reading_body(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ECHO_DOCUMENT_EXTRACTOR_TOKEN", TOKEN)
    config = runtime_config(tmp_path, max_queue_depth=1)
    app = create_app(config)
    app.state.queue.submit("one", "first", "digest", tmp_path, 1, 1)

    def unread_body():
        raise AssertionError("full queue must not read the request body")
        yield b""

    with TestClient(app) as client:
        before = set(config.service.spool_dir.iterdir())
        response = client.post("/v1/jobs", headers=auth(), content=unread_body())
        assert response.status_code == 503
        assert response.headers["retry-after"] == "30"
        assert set(config.service.spool_dir.iterdir()) == before
        assert app.state.queue.capacity()["active"] == 1


def test_full_queue_preserves_idempotent_replay_and_conflict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ECHO_DOCUMENT_EXTRACTOR_TOKEN", TOKEN)
    app = create_app(runtime_config(tmp_path, max_queue_depth=1))
    with TestClient(app) as client:
        files = [("files", ("page.png", png_bytes(), "image/png"))]
        first = client.post("/v1/jobs", headers=auth(), files=files)
        assert first.status_code == 202
        replay = client.post("/v1/jobs", headers=auth(), files=files)
        assert replay.status_code == 202
        assert replay.json()["id"] == first.json()["id"]
        conflict = client.post(
            "/v1/jobs", headers=auth(),
            files=[("files", ("page.png", png_bytes("black"), "image/png"))],
        )
        assert conflict.status_code == 409
        assert app.state.queue.capacity()["active"] == 1


def test_capacity_race_still_respects_atomic_queue_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ECHO_DOCUMENT_EXTRACTOR_TOKEN", TOKEN)
    config = runtime_config(tmp_path, max_queue_depth=1)
    app = create_app(config)
    with TestClient(app) as client:
        def fill_after_probe(_key: str) -> None:
            app.state.queue.submit("winner", "other", "digest", tmp_path, 1, 1)

        monkeypatch.setattr(app.state.queue, "ensure_submission_capacity", fill_after_probe)
        response = client.post(
            "/v1/jobs", headers=auth(),
            files=[("files", ("page.png", png_bytes(), "image/png"))],
        )
        assert response.status_code == 503
        assert response.headers["retry-after"] == "30"
        assert app.state.queue.capacity()["active"] == 1
        assert not list(config.service.spool_dir.iterdir())


def test_api_keeps_idle_connections_longer_than_echo_pool(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from echo_document_extractor import runtime

    captured: dict[str, object] = {}
    monkeypatch.setenv("ECHO_DOCUMENT_EXTRACTOR_CONFIG", str(tmp_path / "config.yaml"))
    monkeypatch.setattr(runtime.RuntimeConfig, "from_yaml", lambda _path: runtime_config(tmp_path))
    monkeypatch.setattr(runtime, "create_app", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(runtime.uvicorn, "run", lambda _app, **kwargs: captured.update(kwargs))
    runtime.api()
    assert captured["timeout_keep_alive"] > 90


async def test_spool_usage_reuses_a_slow_scan_that_finished_while_waiting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    scans = 0

    def slow_scan(_path: Path) -> int:
        nonlocal scans
        scans += 1
        time.sleep(0.2)
        return 0

    monkeypatch.setattr(storage, "directory_size", slow_scan)
    spool = storage.SpoolStorage(tmp_path)
    first = asyncio.create_task(spool.usage(max_age=0.05))
    await asyncio.sleep(0.1)
    second = asyncio.create_task(spool.usage(max_age=0.05))
    await asyncio.gather(first, second)
    assert scans == 1
    await spool.usage()
    assert scans == 2
