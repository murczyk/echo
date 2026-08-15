#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/host_guard.sh"

REVISION=4d7ae4984b7db7de8f8457170b3f1a419ee76d52
SNAPSHOT=/srv/echo-gemma-ocr/cache/huggingface/hub/models--google--gemma-4-26B-A4B-it/snapshots/$REVISION

python3 - "$SNAPSHOT" <<'PY'
import hashlib
import json
import pathlib
import subprocess
import sys

snapshot = pathlib.Path(sys.argv[1])
container = json.loads(subprocess.check_output([
    "sudo", "docker", "inspect", "echo-gemma-ocr-vllm"
]))[0]
container_environment = dict(item.split("=", 1) for item in container["Config"]["Env"] if "=" in item)

def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

files = [
    "config.json",
    "processor_config.json",
    "chat_template.jinja",
    "tokenizer_config.json",
    "model-00001-of-00002.safetensors",
    "model-00002-of-00002.safetensors",
]
manifest = {
    "hostname": subprocess.check_output(["hostname"], text=True).strip(),
    "machine_id": pathlib.Path("/etc/machine-id").read_text().strip(),
    "gpu": subprocess.check_output([
        "nvidia-smi", "--query-gpu=uuid,name,driver_version", "--format=csv,noheader"
    ], text=True).strip(),
    "container_image": container["Config"]["Image"],
    "container_image_id": container["Image"],
    "container_created": container["Created"],
    "container_started": container["State"]["StartedAt"],
    "container_command": container["Config"]["Cmd"],
    "vllm_version": subprocess.check_output([
        "sudo", "docker", "exec", "echo-gemma-ocr-vllm", "python", "-c",
        "import vllm; print(vllm.__version__)",
    ], text=True).strip(),
    "model_id": "google/gemma-4-26B-A4B-it",
    "model_revision": "4d7ae4984b7db7de8f8457170b3f1a419ee76d52",
    "vision_budget": int(container_environment["VISION_BUDGET"]),
    "precision_args": container_environment["PRECISION_ARGS"],
    "file_sha256": {name: sha256(snapshot / name) for name in files},
}
print(json.dumps(manifest, ensure_ascii=False, indent=2))
PY
