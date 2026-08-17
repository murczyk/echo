from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class EndpointConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str
    model_id: str = Field(min_length=1)
    revision: str = Field(min_length=7)
    token_env: str
    timeout_seconds: float = Field(default=180.0, gt=0)
    max_tokens: int = Field(default=10_000, gt=0)
    prompt_version: str = "semantic-html-v1"
    dtype: str | None = None
    kv_cache_dtype: str | None = None
    vision_budget: int | None = Field(default=None, gt=0)
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    seed: int = 0
    extra_body: dict[str, object] = Field(default_factory=dict)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        if not value.startswith(("http://", "https://")):
            raise ValueError("endpoint URL must use http or https")
        parsed = urlsplit(value)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("endpoint URL must not contain credentials, query parameters, or fragments")
        return value.rstrip("/")

    @field_validator("token_env")
    @classmethod
    def validate_token_env(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Z_][A-Z0-9_]*", value):
            raise ValueError("token_env must name an environment variable")
        return value

    @field_validator("extra_body")
    @classmethod
    def reject_embedded_secrets(cls, value: dict[str, object]) -> dict[str, object]:
        sensitive = re.compile(
            r"(?:token|access[_-]?token|bearer[_-]?token|api[_-]?key|authorization|password|secret)",
            re.IGNORECASE,
        )

        def visit(item: object) -> bool:
            if isinstance(item, dict):
                return any(sensitive.fullmatch(str(key)) or visit(nested) for key, nested in item.items())
            if isinstance(item, list):
                return any(visit(nested) for nested in item)
            return False

        if visit(value):
            raise ValueError("endpoint secrets must be supplied only through token_env")
        return value


class PaddleRuntimeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device: str = Field(default="cpu", pattern=r"^(?:cpu|gpu:\d+)$")
    require_local_models: bool = False
    model_root: Path | None = None
    ocr_common: dict[str, object] = Field(default_factory=dict)
    ocr_languages: dict[str, dict[str, object]] = Field(default_factory=dict)
    structure_config: Path | None = None

    @model_validator(mode="after")
    def validate_local_models(self) -> PaddleRuntimeConfig:
        if not self.require_local_models:
            return self
        if self.model_root is None or self.structure_config is None:
            raise ValueError("production Paddle requires model_root and structure_config")
        root = self.model_root.resolve()
        paths = [self.structure_config]
        for values in (self.ocr_common, *self.ocr_languages.values()):
            paths.extend(Path(str(value)) for key, value in values.items() if key.endswith("_model_dir"))
        if not paths or not self.ocr_languages:
            raise ValueError("production Paddle requires explicit OCR model directories")
        for path in paths:
            resolved = path.resolve()
            if resolved != root and root not in resolved.parents:
                raise ValueError("Paddle model paths must remain below model_root")
            if not resolved.exists():
                raise ValueError(f"Paddle model path does not exist: {path}")
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        return self


class ExtractionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hardware_profile: Literal["split_gpu", "single_spark"] = "split_gpu"
    nu_extract: EndpointConfig
    gemma: EndpointConfig
    pdf_dpi: int = Field(default=300, ge=72, le=600)
    max_raster_long_edge: int = Field(default=4096, ge=256)
    crop_padding: float = Field(default=0.03, ge=0.0, le=0.25)
    crop_upscale: float = Field(default=2.0, ge=1.0, le=4.0)
    endpoint_concurrency: int = Field(default=1, ge=1, le=1)
    enable_paddle: bool = True
    paddle_languages: tuple[Literal["ru", "uk", "en"], ...] = ("ru", "uk", "en")
    paddle: PaddleRuntimeConfig = Field(default_factory=PaddleRuntimeConfig)
    preserve_raw_responses: bool = False

    @model_validator(mode="after")
    def validate_profile(self) -> ExtractionConfig:
        if len(set(self.paddle_languages)) != len(self.paddle_languages):
            raise ValueError("paddle_languages must be unique")
        if self.hardware_profile == "single_spark" and self.endpoint_concurrency != 1:
            raise ValueError("single_spark is a serial benchmarking profile")
        return self

    @classmethod
    def from_yaml(cls, path: str | Path) -> ExtractionConfig:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("configuration must be a YAML object")
        return cls.model_validate(data)
