#!/usr/bin/env bash
set -euxo pipefail

storage_dir="${1:?missing storage dir}"
wd_fasttext_models="${2:?missing fasttext models dir}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$repo_root"
echo "Setting up Python environment..."
PYTHON_BIN=""
# check if wdintel-rs/wdintel-py/.venv doesn't exist and create it
if ! test -d "wdintel-rs/wdintel-py/.venv"; then
    echo "Creating wdintel-rs/wdintel-py/.venv"
    # try python3.11, then python3, then python
    for PY in python3.11 python3 python; do
      if command -v $PY >/dev/null 2>&1; then
        echo "Using $PY to create venv"
        $PY -m venv wdintel-rs/wdintel-py/.venv
        PYTHON_BIN="$PY"
        break
      fi
    done
fi
source wdintel-rs/wdintel-py/.venv/bin/activate
PYTHON_BIN="${PYTHON_BIN:-$PWD/wdintel-rs/wdintel-py/.venv/bin/python3}"

# Check if requirements are already installed by comparing timestamps
REQUIREMENTS_FILE="wdintel-rs/wdintel-py/requirements.txt"
INSTALLED_MARKER="wdintel-rs/wdintel-py/.venv/.requirements_installed"

if [ ! -f "$INSTALLED_MARKER" ] || [ "$REQUIREMENTS_FILE" -nt "$INSTALLED_MARKER" ]; then
    echo "Installing Python dependencies..."
    # Keep packaging tooling current so requirements install does not depend
    # on whatever bootstrap modules happened to be bundled with the
    # selected Python.
    "$PYTHON_BIN" -m ensurepip --upgrade
    "$PYTHON_BIN" -m pip install --upgrade pip setuptools wheel
    "$PYTHON_BIN" -m pip install -r "$REQUIREMENTS_FILE"
    touch "$INSTALLED_MARKER"
else
    echo "Python dependencies already up to date, skipping installation"
fi

# Check if spacy model is already downloaded
if ! python3 -c "import spacy; spacy.load('ru_core_news_md')" 2>/dev/null; then
    echo "Downloading spacy model..."
    python3 -m spacy download ru_core_news_md
else
    echo "Spacy model already downloaded, skipping"
fi

FLASK="$PWD/wdintel-rs/wdintel-py/.venv/bin/flask"

pids="$(lsof -tiTCP:5000 -sTCP:LISTEN || true)"
if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
fi

cd "$repo_root/wdintel-rs/wdintel-py"
WD_CALLSIGNS_SPM="$storage_dir/wiki.model" WD_CALLSIGNS="$storage_dir/callsigns20230512.pt" WD_FASTTEXT_MODELS="$wd_fasttext_models" "$FLASK" --app service --debug run
