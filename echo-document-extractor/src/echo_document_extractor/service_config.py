from __future__ import annotations

import os
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .config import ExtractionConfig

MULTIPART_OVERHEAD_BYTES = 2 * 1024 * 1024


class ServiceLimits(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_input_bytes: int = Field(default=250 * 1024 * 1024, gt=0)
    max_pages: int = Field(default=200, ge=1, le=200)
    max_queue_depth: int = Field(default=25, ge=1)
    max_spool_bytes: int = Field(default=70 * 1024**3, gt=0)
    min_free_bytes: int = Field(default=20 * 1024**3, gt=0)
    retention_seconds: int = Field(default=7 * 24 * 60 * 60, ge=60)


class WorkerSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    poll_seconds: float = Field(default=2.0, ge=0.1)
    lease_seconds: int = Field(default=300, ge=30)
    heartbeat_seconds: int = Field(default=30, ge=5)
    infrastructure_retries: int = Field(default=3, ge=0, le=10)
    retry_backoff_seconds: tuple[int, ...] = (30, 120, 600)

    @model_validator(mode="after")
    def validate_heartbeat(self) -> WorkerSettings:
        if self.heartbeat_seconds * 2 >= self.lease_seconds:
            raise ValueError("worker heartbeat must be less than half the lease")
        if len(self.retry_backoff_seconds) < self.infrastructure_retries:
            raise ValueError("retry_backoff_seconds must cover every infrastructure retry")
        return self


class ServiceSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    listen_host: str = "100.93.77.92"
    api_port: int = Field(default=8000, ge=1, le=65535)
    api_metrics_host: str = "127.0.0.1"
    api_metrics_port: int = Field(default=29000, ge=1, le=65535)
    worker_metrics_host: str = "127.0.0.1"
    worker_metrics_port: int = Field(default=29001, ge=1, le=65535)
    state_dir: Path = Path("/var/lib/echo-document-extractor")
    spool_dir: Path = Path("/var/lib/echo-document-extractor/spool")
    database_path: Path = Path("/var/lib/echo-document-extractor/jobs.sqlite3")
    bearer_token_env: str = "ECHO_DOCUMENT_EXTRACTOR_TOKEN"
    limits: ServiceLimits = Field(default_factory=ServiceLimits)
    worker: WorkerSettings = Field(default_factory=WorkerSettings)

    @field_validator("bearer_token_env")
    @classmethod
    def validate_token_env(cls, value: str) -> str:
        if not value.isidentifier() or value.upper() != value:
            raise ValueError("bearer_token_env must be an uppercase environment variable")
        return value

    def bearer_token(self) -> str:
        value = os.environ.get(self.bearer_token_env, "")
        if len(value) < 32:
            raise RuntimeError(f"{self.bearer_token_env} must contain at least 32 characters")
        return value


class RuntimeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    service: ServiceSettings = Field(default_factory=ServiceSettings)
    extraction: ExtractionConfig

    @classmethod
    def from_yaml(cls, path: str | Path) -> RuntimeConfig:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("runtime configuration must be a YAML object")
        return cls.model_validate(data)
