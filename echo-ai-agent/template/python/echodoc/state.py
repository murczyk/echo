"""Script input and output files exchanged with the runner."""

import json
from pathlib import Path

INPUT_FILE = "inputs.json"
RESULT_FILE = "result.json"
OUTPUT_DIR = "out"
MAX_LOG_LINES = 200
DEFAULT_MAX_OUTPUTS = 4

# Mutated in place so `from echodoc import inputs, sources` stays valid.
inputs = {}
sources = []
work = {"dir": Path(".")}
_result = {"outputs": [], "logs": []}


def load(directory):
    work["dir"] = Path(directory)
    path = work["dir"] / INPUT_FILE
    loaded = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    inputs.clear()
    inputs.update(loaded)
    sources.clear()
    sources.extend(source for source in loaded.get("sources") or [] if isinstance(source, dict))
    reset()


def reset():
    _result.clear()
    _result.update(outputs=[], logs=[])


def result():
    return _result


def max_outputs():
    value = inputs.get("maxOutputs")
    return value if isinstance(value, int) and value > 0 else DEFAULT_MAX_OUTPUTS


def path(relative):
    return work["dir"] / relative


def log(*values):
    """Adds a line to the result the agent sees (print() output is also kept)."""
    if len(_result["logs"]) < MAX_LOG_LINES:
        _result["logs"].append(" ".join(str(value) for value in values))


def write(directory):
    target = Path(directory) / RESULT_FILE
    target.write_text(json.dumps(_result, ensure_ascii=False), encoding="utf-8")
