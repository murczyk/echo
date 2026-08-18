from __future__ import annotations

import asyncio
import base64
import html as std_html
import os
import re
import time
from typing import Literal, Protocol

import httpx
from lxml import etree, html
from pydantic import BaseModel, ConfigDict, Field

from .config import EndpointConfig
from .models import BBox, CandidateEvidence, Evidence, SourceTransform
from .sanitize import has_fatal_sanitization_reason, sanitize_candidate

NUEXTRACT_PROMPT = """Transcribe the complete crop in reading order as Markdown with HTML tables.
Preserve every paragraph, list type, table section, empty cell, rowspan, colspan,
spelling, punctuation, capitalization, number, coordinate, and mixed Cyrillic/alphanumeric token.
Represent visible non-text imagery as <figure data-image="present"><figcaption>literal
visual description</figcaption></figure>. Never emit img or invent an image URL. Never
translate, correct, summarize, infer facts beyond visible content, add, or repeat content.
Use [unreadable] only for genuinely illegible source text. Return the transcription only."""

GEMMA_END_MARKER = "<!-- ECHO_EXTRACTION_END -->"
GEMMA_PROMPT = f"""Transcribe the complete crop as bounded semantic HTML using only article,
section, h1-h6, p, ul, ol, li, table, caption, thead, tbody, tr, th, td, br,
and figure. Styles may preserve only alignment, bold, italic, font color, and
fill color. Represent a visible image with data-image=\"present\" and never invent
an image URL. Preserve empty cells and exact text. Never translate, correct,
summarize, infer, add, or repeat content. End exactly with {GEMMA_END_MARKER}"""


class ModelUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt_tokens: int = Field(default=0, ge=0)
    completion_tokens: int = Field(default=0, ge=0)
    total_tokens: int = Field(default=0, ge=0)


class ModelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str
    unit_id: str
    page_id: str
    raster_sha256: str
    crop_bbox: BBox
    source_transform: SourceTransform = Field(default_factory=SourceTransform)
    profile: Literal["split_gpu", "single_spark"]
    prompt_version: str
    image_png: bytes = Field(exclude=True)
    retry: bool = False


class ModelResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str
    adapter: str
    format: Literal["html", "markdown"]
    content: str = ""
    termination: str | None = None
    usage: ModelUsage = Field(default_factory=ModelUsage)
    latency_ms: int = Field(default=0, ge=0)
    error: str | None = None
    request_metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


class ModelAdapter(Protocol):
    name: str

    async def extract(self, request: ModelRequest) -> ModelResponse: ...


class GatewayAdapter:
    format: Literal["html"] = "html"

    def __init__(
        self,
        gateway_url: str,
        grant: str,
        engine_id: str,
        engine_name: str,
        model_name: str,
        request_profile: Literal["openai_vision", "ocr_gemma"],
        instance_id: str,
    ) -> None:
        self.name = "semantic"
        self.gateway_url = gateway_url.rstrip("/")
        self.grant = grant
        self.engine_id = engine_id
        self.engine_name = engine_name
        self.model_name = model_name
        self.request_profile = request_profile
        self.instance_id = instance_id

    async def extract(self, request: ModelRequest) -> ModelResponse:
        started = time.monotonic()
        data = {
            "grant": self.grant,
            "request_id": request.request_id,
            "page_id": request.page_id,
            "unit_id": request.unit_id,
            "prompt_version": request.prompt_version,
            "retry": str(request.retry).lower(),
        }
        files = {"image": ("crop.png", request.image_png, "image/png")}
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                response = await client.post(
                    f"{self.gateway_url}/internal/ocr/infer",
                    data=data,
                    files=files,
                )
                response.raise_for_status()
            payload = response.json()
            return ModelResponse(
                request_id=request.request_id,
                adapter=self.name,
                format=self.format,
                content=str(payload.get("content", "")),
                termination=payload.get("finishReason"),
                usage=ModelUsage(
                    prompt_tokens=int(payload.get("promptTokens", 0)),
                    completion_tokens=int(payload.get("completionTokens", 0)),
                    total_tokens=int(payload.get("totalTokens", 0)),
                ),
                latency_ms=round((time.monotonic() - started) * 1000),
                request_metadata={
                    "engine_id": self.engine_id,
                    "engine_name": self.engine_name,
                    "model_id": self.model_name,
                    "request_profile": self.request_profile,
                    "instance_id": self.instance_id,
                    "preferred_tiebreaker": True,
                    "prompt_version": request.prompt_version,
                    "retry": request.retry,
                },
            )
        except Exception as error:
            return ModelResponse(
                request_id=request.request_id,
                adapter=self.name,
                format=self.format,
                latency_ms=round((time.monotonic() - started) * 1000),
                error=f"{type(error).__name__}: {str(error)[:160]}",
                request_metadata={
                    "engine_id": self.engine_id,
                    "engine_name": self.engine_name,
                    "model_id": self.model_name,
                    "request_profile": self.request_profile,
                    "instance_id": self.instance_id,
                    "prompt_version": request.prompt_version,
                    "retry": request.retry,
                },
            )


class OpenAICompatibleAdapter:
    format: Literal["html", "markdown"] = "html"
    prompt = GEMMA_PROMPT

    def __init__(self, name: str, config: EndpointConfig, concurrency: int = 1) -> None:
        self.name = name
        self.config = config
        self._semaphore = asyncio.Semaphore(concurrency)

    def _request_body(self, request: ModelRequest) -> dict[str, object]:
        url = f"data:image/png;base64,{base64.b64encode(request.image_png).decode()}"
        payload: dict[str, object] = {
            "model": self.config.model_id,
            "temperature": 0.2 if self.name in {"nuextract3", "numarkdown"} else 0.0,
            "seed": 0,
            "max_tokens": self.config.max_tokens,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": self.prompt},
                        {"type": "image_url", "image_url": {"url": url}},
                    ],
                }
            ],
        }
        payload.update(self.config.extra_body)
        return payload

    async def extract(self, request: ModelRequest) -> ModelResponse:
        started = time.monotonic()
        token = os.environ.get(self.config.token_env)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            async with self._semaphore, httpx.AsyncClient(timeout=self.config.timeout_seconds) as client:
                response = await client.post(
                    f"{self.config.url}/chat/completions",
                    headers=headers,
                    json=self._request_body(request),
                )
                response.raise_for_status()
            payload = response.json()
            choice = payload["choices"][0]
            content = choice["message"]["content"]
            if not isinstance(content, str):
                raise ValueError("response content is not a string")
            usage = payload.get("usage", {})
            return ModelResponse(
                request_id=request.request_id,
                adapter=self.name,
                format=self.format,
                content=content,
                termination=choice.get("finish_reason"),
                usage=ModelUsage(
                    prompt_tokens=int(usage.get("prompt_tokens", 0)),
                    completion_tokens=int(usage.get("completion_tokens", 0)),
                    total_tokens=int(usage.get("total_tokens", 0)),
                ),
                latency_ms=round((time.monotonic() - started) * 1000),
                request_metadata=self._redacted_metadata(request),
            )
        except Exception as error:
            return ModelResponse(
                request_id=request.request_id,
                adapter=self.name,
                format=self.format,
                latency_ms=round((time.monotonic() - started) * 1000),
                error=f"{type(error).__name__}: {str(error)[:160]}",
                request_metadata=self._redacted_metadata(request),
            )

    def _redacted_metadata(self, request: ModelRequest) -> dict[str, str | int | float | bool | None]:
        return {
            "model_id": self.config.model_id,
            "revision": self.config.revision,
            "prompt_version": request.prompt_version,
            "profile": request.profile,
            "retry": request.retry,
            "image_bytes": len(request.image_png),
            "dtype": self.config.dtype,
            "kv_cache_dtype": self.config.kv_cache_dtype,
            "vision_budget": self.config.vision_budget,
            "temperature": self.config.temperature,
            "seed": self.config.seed,
        }


class NuExtract3Adapter(OpenAICompatibleAdapter):
    format: Literal["markdown"] = "markdown"
    prompt = NUEXTRACT_PROMPT

    def __init__(self, config: EndpointConfig, concurrency: int = 1) -> None:
        super().__init__("nuextract3", config, concurrency)

    def _request_body(self, request: ModelRequest) -> dict[str, object]:
        payload = super()._request_body(request)
        payload["temperature"] = 0.2
        payload["seed"] = 0
        extra = dict(payload.get("chat_template_kwargs", {}))
        extra.update({"mode": "markdown", "enable_thinking": False})
        payload["chat_template_kwargs"] = extra
        return payload


class GemmaAdapter(OpenAICompatibleAdapter):
    format: Literal["html"] = "html"
    prompt = GEMMA_PROMPT

    def __init__(self, config: EndpointConfig, concurrency: int = 1) -> None:
        super().__init__("gemma", config, concurrency)

    def _request_body(self, request: ModelRequest) -> dict[str, object]:
        payload = super()._request_body(request)
        payload["temperature"] = 0
        payload["seed"] = 0
        payload["stop"] = [GEMMA_END_MARKER]
        payload["include_stop_str_in_output"] = True
        if self.config.vision_budget:
            processor = dict(payload.get("mm_processor_kwargs", {}))
            processor["max_pixels"] = self.config.vision_budget * self.config.vision_budget
            payload["mm_processor_kwargs"] = processor
        return payload


class NuMarkdownAdapter(NuExtract3Adapter):
    """Experimental adapter; intentionally excluded from the default ensemble."""

    def __init__(self, config: EndpointConfig, concurrency: int = 1) -> None:
        super().__init__(config, concurrency)
        self.name = "numarkdown"


def response_to_evidence(response: ModelResponse, request: ModelRequest) -> Evidence:
    reasons = []
    content = response.content
    if response.error:
        reasons.append("request_error")
    if response.adapter == "gemma" or response.request_metadata.get("request_profile") == "ocr_gemma":
        stripped = content.rstrip()
        if not stripped.endswith(GEMMA_END_MARKER):
            reasons.append("missing_end_marker")
        else:
            content = stripped[: -len(GEMMA_END_MARKER)].rstrip()
    if response.termination not in {"stop", None}:
        reasons.append(f"finish_reason:{response.termination}")
    if response.format == "markdown":
        content = markdown_to_html(content)
    sanitized, sanitize_reasons = sanitize_candidate(content)
    text = _text_content(sanitized)
    if not text.strip():
        reasons.append("empty_content")
    valid = not reasons and not has_fatal_sanitization_reason(sanitize_reasons)
    reasons.extend(sanitize_reasons)
    return CandidateEvidence(
        id=f"{response.adapter}-{request.request_id}",
        kind="candidate",
        source=response.adapter,
        page_id=request.page_id,
        unit_id=request.unit_id,
        html=sanitized,
        text=text,
        bbox=request.crop_bbox,
        confidence=0.9 if valid else 0.0,
        transform=request.source_transform,
        valid=valid,
        rejection_reasons=sorted(set(reasons)),
        metadata={
            **response.request_metadata,
            "latency_ms": response.latency_ms,
            "termination": response.termination,
            "retry": request.retry,
            "prompt_tokens": response.usage.prompt_tokens,
            "completion_tokens": response.usage.completion_tokens,
        },
    )


def markdown_to_html(value: str) -> str:
    """Convert conservative Markdown blocks while preserving embedded HTML tables."""
    value = re.sub(r"^```(?:markdown|md|html)?\s*|\s*```$", "", value.strip(), flags=re.IGNORECASE)
    blocks = re.split(r"\n\s*\n", value)
    root = html.Element("article")
    for block in blocks:
        stripped = block.strip()
        if not stripped:
            continue
        if stripped.casefold().startswith("<figure"):
            figures = _normalized_figures(stripped)
            if figures is not None:
                root.extend(figures)
                continue
        if stripped.casefold().startswith(("<table", "<article", "<section")):
            try:
                fragments = html.fragments_fromstring(stripped)
            except (ValueError, etree.ParserError):
                fragments = []
            for fragment in fragments:
                if not isinstance(fragment, str):
                    root.append(fragment)
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)$", stripped, re.DOTALL)
        if heading:
            element = html.Element(f"h{len(heading.group(1))}")
            element.text = heading.group(2).strip()
            root.append(element)
            continue
        lines = stripped.splitlines()
        if all(re.match(r"^\s*[-*+]\s+", line) for line in lines):
            listing = html.Element("ul")
            for line in lines:
                item = etree.SubElement(listing, "li")
                item.text = re.sub(r"^\s*[-*+]\s+", "", line)
            root.append(listing)
            continue
        if all(re.match(r"^\s*\d+[.)]\s+", line) for line in lines):
            listing = html.Element("ol")
            for line in lines:
                item = etree.SubElement(listing, "li")
                item.text = re.sub(r"^\s*\d+[.)]\s+", "", line)
            root.append(listing)
            continue
        paragraph = html.Element("p")
        paragraph.text = std_html.unescape(stripped)
        root.append(paragraph)
    return html.tostring(root, encoding="unicode", method="html")


def _normalized_figures(value: str) -> list[html.HtmlElement] | None:
    try:
        fragments = html.fragments_fromstring(value)
    except (ValueError, etree.ParserError):
        return None
    figures = []
    for fragment in fragments:
        if isinstance(fragment, str):
            if fragment.strip():
                return None
            continue
        if fragment.tag.casefold() != "figure" or (fragment.tail and fragment.tail.strip()):
            return None
        figure = html.Element("figure", {"data-image": "present"})
        caption = _figure_caption(fragment)
        if caption:
            etree.SubElement(figure, "figcaption").text = caption
        figures.append(figure)
    return figures or None


def _figure_caption(figure: html.HtmlElement) -> str:
    captions = figure.xpath("./figcaption")
    if captions:
        return " ".join(" ".join(captions[0].itertext()).split())
    for image in figure.xpath(".//img[@alt]"):
        caption = " ".join(image.get("alt", "").split())
        if caption:
            return caption
    return ""


def _text_content(markup: str) -> str:
    try:
        root = html.fromstring(markup)
    except (ValueError, etree.ParserError):
        return ""
    return " ".join(part.strip() for part in root.itertext() if part.strip())
