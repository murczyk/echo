#!/usr/bin/env bash
set -euo pipefail
export PYTHONPATH=/opt/echo-document-extractor/python
export PYTHONNOUSERSITE=1
export HOME=/var/lib/echo-document-extractor
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
export PADDLE_PDX_CACHE_HOME=/var/lib/echo-document-extractor/paddlex-cache
export ECHO_DOCUMENT_EXTRACTOR_CONFIG=/etc/echo-document-extractor/config.yaml
cd "$HOME"
unshare --net /usr/sbin/runuser --user echo-document-extractor \
  --preserve-environment -- /usr/bin/python3 - <<'PY'
import os
import paddle
from PIL import Image, ImageDraw
from echo_document_extractor.ocr import PaddleEvidenceProvider
from echo_document_extractor.service_config import RuntimeConfig

config = RuntimeConfig.from_yaml(os.environ["ECHO_DOCUMENT_EXTRACTOR_CONFIG"]).extraction
assert config.enable_paddle
assert paddle.is_compiled_with_cuda()
assert config.paddle.device.startswith("gpu:")
provider = PaddleEvidenceProvider(True, config.paddle_languages, config.paddle)
assert paddle.device.get_device() == config.paddle.device
image = Image.new("RGB", (256, 192), "white")
draw = ImageDraw.Draw(image)
draw.rectangle((8, 8, 248, 184), outline="black", width=2)
draw.line((8, 64, 248, 64), fill="black", width=2)
draw.line((128, 8, 128, 184), fill="black", width=2)
draw.text((16, 24), "Echo OCR 123", fill="black")
provider.extract_all(image, "offline-check")
print(f"offline Paddle initialization and inference passed on {paddle.device.get_device()}")
PY
