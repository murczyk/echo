from __future__ import annotations

import asyncio
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

import httpx

from .config import EndpointConfig, ExtractionConfig


@dataclass(frozen=True)
class DependencyStatus:
    name: str
    healthy: bool
    expected_model: str
    served_models: tuple[str, ...] = ()
    error: str | None = None


class DependencyChecker:
    def __init__(self, config: ExtractionConfig) -> None:
        self.endpoints = (("nuextract", config.nu_extract), ("ocr-gemma", config.gemma))

    async def check_all(self, include_gemma: bool = True) -> list[DependencyStatus]:
        endpoints = self.endpoints if include_gemma else (self.endpoints[0],)
        return list(await asyncio.gather(*(self._check(name, endpoint) for name, endpoint in endpoints)))

    async def _check(self, name: str, endpoint: EndpointConfig) -> DependencyStatus:
        token = __import__("os").environ.get(endpoint.token_env)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            async with httpx.AsyncClient(timeout=min(endpoint.timeout_seconds, 10.0)) as client:
                health = await client.get(_health_url(endpoint.url), headers=headers)
                health.raise_for_status()
                response = await client.get(f"{endpoint.url}/models", headers=headers)
                response.raise_for_status()
            payload = response.json()
            served = tuple(
                str(item.get("id"))
                for item in payload.get("data", [])
                if isinstance(item, dict) and item.get("id")
            )
            if endpoint.model_id not in served:
                return DependencyStatus(
                    name,
                    False,
                    endpoint.model_id,
                    served,
                    "expected model is not served",
                )
            return DependencyStatus(name, True, endpoint.model_id, served)
        except Exception as error:
            return DependencyStatus(
                name,
                False,
                endpoint.model_id,
                error=f"{type(error).__name__}: {str(error)[:160]}",
            )


def _health_url(base_url: str) -> str:
    value = urlsplit(base_url)
    path = value.path.removesuffix("/v1").rstrip("/") + "/health"
    return urlunsplit((value.scheme, value.netloc, path, "", ""))
