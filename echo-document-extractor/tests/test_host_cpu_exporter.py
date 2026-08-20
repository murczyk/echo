from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

EXPORTER_PATH = Path(__file__).resolve().parents[1] / "bin" / "host-cpu-exporter.py"


def load_exporter():
    spec = importlib.util.spec_from_file_location("host_cpu_exporter", EXPORTER_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STAT = """cpu  400 20 80 500 10 2 4 1 9 3
cpu0 100 5 20 125 2 1 1 0 2 1
cpu2 300 15 60 375 8 1 3 1 7 2
"""


def test_aggregate_cpu_seconds_ignore_per_cpu_lines() -> None:
    exporter = load_exporter()

    seconds = exporter.parse_aggregate_cpu_seconds(STAT, ticks=100)

    assert seconds == {
        "user": 4.0,
        "nice": 0.2,
        "system": 0.8,
        "idle": 5.0,
        "iowait": 0.1,
        "irq": 0.02,
        "softirq": 0.04,
        "steal": 0.01,
    }
    body = exporter.render_metrics(seconds)
    assert 'echo_host_cpu_seconds_total{mode="user"} 4.0' in body
    assert "cpu2" not in body


def test_missing_aggregate_cpu_line_fails() -> None:
    exporter = load_exporter()

    with pytest.raises(ValueError, match="missing aggregate cpu line"):
        exporter.parse_aggregate_cpu_seconds("cpu0 1 0 0 1 0 0 0 0\n", ticks=100)
