from __future__ import annotations

import io
import json
import sqlite3
import time
import zipfile
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

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
from echo_document_extractor.worker import _all_remote_model_families_failed, _job_inputs

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
