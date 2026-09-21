from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

CHECK = Path(__file__).resolve().parents[1] / "bin" / "verify-status.py"


@pytest.fixture
def ready_status() -> dict:
    return {
        "worker": {"instances": [{"paddle_ready": True}]},
        "paddle": {"required": True, "ready": True},
        "routers": [
            {
                "name": name,
                "healthy": True,
                "expected_model": engine,
                "served_models": [engine],
            }
            for name, engine in (
                ("nuextract", "numind/NuExtract3"),
                ("ocr-gemma", "echo/ocr-gemma-4-26B-A4B-it"),
            )
        ],
    }


def check_status(status: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CHECK)], input=json.dumps(status), text=True, capture_output=True
    )


def test_healthy_extractor_passes(ready_status: dict) -> None:
    assert check_status(ready_status).returncode == 0


def test_http_success_with_nuextract_outage_fails(ready_status: dict) -> None:
    ready_status["routers"][0].update(healthy=False, served_models=[])
    result = check_status(ready_status)
    assert result.returncode == 1
    assert "nuextract" in result.stderr


@pytest.mark.parametrize("failure", ["worker", "paddle", "routers", "missing_router", "wrong_model"])
def test_incomplete_readiness_fails(ready_status: dict, failure: str) -> None:
    if failure == "worker":
        ready_status["worker"]["instances"] = []
    elif failure == "paddle":
        ready_status["paddle"]["ready"] = False
    elif failure == "routers":
        ready_status["routers"] = []
    elif failure == "missing_router":
        ready_status["routers"].pop(0)
    else:
        ready_status["routers"][0]["served_models"] = ["unexpected"]
    assert check_status(ready_status).returncode == 1
