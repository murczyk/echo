from __future__ import annotations

import os

import uvicorn

from .api import create_app
from .service_config import RuntimeConfig
from .worker import run_worker


def api() -> None:
    config = RuntimeConfig.from_yaml(os.environ["ECHO_DOCUMENT_EXTRACTOR_CONFIG"])
    uvicorn.run(
        create_app(config, start_metrics=True),
        host=config.service.listen_host,
        port=config.service.api_port,
        proxy_headers=False,
        server_header=False,
        access_log=False,
    )


def worker() -> None:
    run_worker(os.environ["ECHO_DOCUMENT_EXTRACTOR_CONFIG"])
