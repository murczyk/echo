from __future__ import annotations

import os

from .api import create_app
from .service_config import RuntimeConfig

app = create_app(RuntimeConfig.from_yaml(os.environ["ECHO_DOCUMENT_EXTRACTOR_CONFIG"]), start_metrics=True)
