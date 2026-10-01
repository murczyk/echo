"""Script input and output files exchanged with the runner."""

import json
from pathlib import Path

INPUT_FILE = "inputs.json"
RESULT_FILE = "result.json"
MAX_LOG_LINES = 200

_inputs = {}
_result = {"records": [], "operations": [], "summary": None, "logs": []}


def load(directory):
    global _inputs
    path = Path(directory) / INPUT_FILE
    _inputs = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    reset()


def reset():
    _result.update(records=[], operations=[], summary=None, logs=[])


def inputs():
    return _inputs


def result():
    return _result


def log(*values):
    """Adds a line to the result the agent sees (print() output is also kept)."""
    if len(_result["logs"]) < MAX_LOG_LINES:
        _result["logs"].append(" ".join(str(value) for value in values))


def write(directory):
    path = Path(directory) / RESULT_FILE
    path.write_text(json.dumps(_result, ensure_ascii=False), encoding="utf-8")
