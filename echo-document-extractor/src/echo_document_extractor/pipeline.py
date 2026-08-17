from __future__ import annotations

import asyncio
import hashlib
import html as std_html
import inspect
import io
import itertools
import json
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Protocol, TypeVar

import yaml
from lxml import html
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .adapters import (
    GemmaAdapter,
    ModelAdapter,
    ModelRequest,
    ModelResponse,
    NuExtract3Adapter,
    response_to_evidence,
)
from .canonical import (
    asset_for_crop,
    blocks_from_html,
    canonical_round_trip_preserves,
    table_dimensions,
    unreadable_block,
)
from .config import TEXT_BBOX_MAX_OCR_LINES, ExtractionConfig
from .geometry import GeometryResult, detect_geometry
from .ingest import RasterPage, crop_with_transform, iter_ingest
from .matching import align_indices
from .matching import align_text_sequences as _align_text_sequences
from .matching import text_similarity as _text_similarity
from .models import (
    AssetRef,
    BBox,
    Block,
    CandidateEvidence,
    Cell,
    CellEvidence,
    Decision,
    Document,
    Evidence,
    ExtractionResult,
    PackageManifest,
    Page,
    QualityReport,
    RegionEvidence,
    RetryRecord,
    Status,
    Table,
    TableEvidence,
    TextBlock,
    safe_relative_path,
)
from .ocr import PaddleEvidenceProvider
from .postprocess import TextCorrection, normalize_document_unit_designations
from .reconcile import needs_retry, reconcile
from .render import render_html, render_markdown
from .sanitize import has_fatal_sanitization_reason, sanitize_candidate


class InputManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(default=1, ge=1, le=1)
    inputs: list[str] = Field(min_length=1)
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)

    @field_validator("inputs")
    @classmethod
    def safe_inputs(cls, values: list[str]) -> list[str]:
        return [safe_relative_path(value) for value in values]


@dataclass
class CandidateDocument:
    evidence: Evidence
    blocks: list[Block]


@dataclass
class ProcessedPage:
    page_id: str
    blocks: list[Block]
    evidence: list[Evidence]
    decisions: list[Decision]
    assets: dict[str, bytes | Path] = field(default_factory=dict)
    raw_artifacts: dict[str, bytes | Path] = field(default_factory=dict)
    failed: bool = False
    degraded_reasons: list[str] = field(default_factory=list)


T = TypeVar("T", TextBlock, Cell)
PageCallback = Callable[[int, int | None], Awaitable[None] | None]
SUPPORTING_EVIDENCE_MIN_COVERAGE = 0.5
UNSCOPED_UNIT_PAGE_COVERAGE = 0.8


class ExtractionMetrics(Protocol):
    def observe_paddle(self, duration: float, status: str) -> None: ...

    def observe_model(self, response: ModelResponse) -> None: ...

    def observe_model_error(self, adapter: str) -> None: ...


class ExtractionCancelled(RuntimeError):
    pass


class Extractor:
    def __init__(
        self,
        config: ExtractionConfig,
        adapters: list[ModelAdapter] | None = None,
        artifact_dir: Path | None = None,
        page_callback: PageCallback | None = None,
        metrics: ExtractionMetrics | None = None,
        ocr: PaddleEvidenceProvider | None = None,
        paddle_semaphore: asyncio.Semaphore | None = None,
    ) -> None:
        self.config = config
        self.adapters = adapters or [
            NuExtract3Adapter(config.nu_extract, config.endpoint_concurrency),
            GemmaAdapter(config.gemma, config.endpoint_concurrency),
        ]
        self.ocr = ocr or PaddleEvidenceProvider(
            config.enable_paddle,
            config.paddle_languages,
            config.paddle,
        )
        self.paddle_semaphore = paddle_semaphore
        self._request_artifacts: dict[str, bytes] = {}
        self._single_spark_queue = asyncio.Semaphore(1) if config.hardware_profile == "single_spark" else None
        self.artifact_dir = artifact_dir
        self.page_callback = page_callback
        self.metrics = metrics

    async def extract(
        self,
        inputs: list[str | Path],
        manifest: str | Path | dict[str, Any] | None = None,
    ) -> ExtractionResult:
        self._request_artifacts = {}
        ordered_inputs, input_names, metadata = _resolve_inputs(inputs, manifest)
        processed_by_hash: dict[str, ProcessedPage] = {}
        pages: list[Page] = []
        all_evidence: list[Evidence] = []
        decisions: list[Decision] = []
        assets: dict[str, bytes | Path] = {}
        raw_artifacts: dict[str, bytes | Path] = {}
        degraded_reasons: list[str] = []
        failed_pages = 0
        raster_pages = iter_ingest(ordered_inputs, self.config.pdf_dpi)
        index = 0
        while True:
            try:
                raster = next(raster_pages)
            except StopIteration:
                break
            except Exception as error:
                return self._failed_ingestion(input_names, str(error))
            page_id = f"p{index + 1}"
            try:
                original = processed_by_hash.get(raster.raster_sha256)
                if original is None:
                    original = self._spill_artifacts(await self._process_page(raster, page_id))
                    processed_by_hash[raster.raster_sha256] = original
                processed = original if original.page_id == page_id else _clone_processed(original, page_id)
                page_embedded = [item for item in processed.evidence if item.source == "embedded_pdf"]
                pages.append(
                    Page(
                        id=page_id,
                        source_name=raster.source_name,
                        source_sha256=raster.source_sha256,
                        raster_sha256=raster.raster_sha256,
                        instance=index,
                        width=raster.image.width,
                        height=raster.image.height,
                        rotation_degrees=raster.rotation_degrees,
                        blocks=processed.blocks,
                        embedded_pdf_evidence=page_embedded,
                    )
                )
                all_evidence.extend(processed.evidence)
                decisions.extend(processed.decisions)
                assets.update(processed.assets)
                raw_artifacts.update(processed.raw_artifacts)
                degraded_reasons.extend(processed.degraded_reasons)
                failed_pages += processed.failed
                if self.page_callback:
                    callback = self.page_callback(index + 1, None)
                    if inspect.isawaitable(callback):
                        await callback
            except BaseException:
                raster_pages.close()
                raise
            finally:
                raster.image.close()
            index += 1
        document_id = _document_id(pages)
        document = Document(id=document_id, pages=pages)
        document, corrections = normalize_document_unit_designations(document)
        _record_text_corrections(corrections, all_evidence, decisions)
        unresolved = sum(decision.unresolved for decision in decisions)
        hard_failures = sum(not decision.hard_checks_passed for decision in decisions)
        if any("request_error" in item.rejection_reasons for item in all_evidence):
            degraded_reasons.append("model request failure")
        if unresolved:
            degraded_reasons.append("unresolved decisions")
        if hard_failures:
            degraded_reasons.append("hard check failures")
        if failed_pages == len(pages):
            status = Status.FAILED
        elif degraded_reasons or unresolved or hard_failures:
            status = Status.DEGRADED
        else:
            status = Status.ACCEPTED
        quality = QualityReport(
            status=status,
            page_count=len(pages),
            accepted_units=sum(decision.hard_checks_passed for decision in decisions),
            unresolved_decisions=unresolved,
            unreadable_pages=failed_pages,
            hard_check_failures=hard_failures,
            degraded_reasons=sorted(set(degraded_reasons)),
        )
        result = ExtractionResult(
            document=document,
            status=status,
            evidence=all_evidence,
            decisions=decisions,
            canonical_html="",
            markdown="",
            quality=quality,
            manifest=PackageManifest(
                document_id=document_id,
                status=status,
                inputs=input_names,
                source_hashes=[_sha256_file(path) for path in ordered_inputs],
                raster_hashes=[page.raster_sha256 for page in pages],
                hardware_profile=self.config.hardware_profile,
                models=[
                    {
                        "id": endpoint.model_id,
                        "revision": endpoint.revision,
                        "prompt_version": endpoint.prompt_version,
                    }
                    for endpoint in (self.config.nu_extract, self.config.gemma)
                ],
                metadata=metadata,
            ),
            assets=assets,
            raw_artifacts=raw_artifacts,
        )
        result.canonical_html = render_html(result)
        if not canonical_round_trip_preserves(document, result.canonical_html):
            raise RuntimeError("canonical HTML round-trip lost IR relationships")
        result.markdown = render_markdown(result)
        return result

    def _spill_artifacts(self, page: ProcessedPage) -> ProcessedPage:
        if self.artifact_dir is None:
            return page
        page.assets = self._spill_mapping(page.assets)
        page.raw_artifacts = self._spill_mapping(page.raw_artifacts)
        return page

    def _spill_mapping(self, values: dict[str, bytes | Path]) -> dict[str, bytes | Path]:
        output: dict[str, bytes | Path] = {}
        for relative, content in values.items():
            if isinstance(content, Path):
                output[relative] = content
                continue
            target = self.artifact_dir.joinpath(*PurePosixPath(relative).parts)
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
            temporary.write_bytes(content)
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
            output[relative] = target
        return output

    async def _process_page(self, raster: RasterPage, page_id: str) -> ProcessedPage:
        geometry = detect_geometry(raster.image, page_id)
        paddle_started = time.monotonic()
        try:
            if self.paddle_semaphore is None:
                paddle = self.ocr.extract_all(
                    raster.image,
                    page_id,
                    use_table_recognition=not any(isinstance(block, Table) for block in geometry.blocks),
                )
            else:
                async with self.paddle_semaphore:
                    paddle = self.ocr.extract_all(
                        raster.image,
                        page_id,
                        use_table_recognition=not any(isinstance(block, Table) for block in geometry.blocks),
                    )
        except RuntimeError as error:
            paddle = None
            paddle_error = Evidence(
                id=f"paddle-error-{page_id}",
                source="paddle",
                page_id=page_id,
                valid=False,
                rejection_reasons=[str(error)[:160]],
            )
        if self.metrics:
            self.metrics.observe_paddle(
                time.monotonic() - paddle_started,
                "success" if paddle is not None else "error",
            )
        embedded = [_page_evidence(item, page_id) for item in raster.embedded_evidence]
        supporting = [*geometry.evidence, *embedded]
        visual_regions = list(geometry.visual_regions)
        degraded_reasons = []
        if paddle is not None:
            supporting.extend(paddle.evidence)
            visual_regions.extend(paddle.visual_regions)
            geometry.blocks = _merge_paddle_skeleton(geometry.blocks, paddle.evidence, page_id)
        elif self.config.enable_paddle:
            supporting.append(paddle_error)
            degraded_reasons.append("paddle inference unavailable")
        page_bbox: BBox = (0, 0, raster.image.width, raster.image.height)
        candidates = await self._request_candidates(raster, page_id, page_id, page_bbox, retry=False)
        evidence = [*supporting, *candidates]
        candidate_documents = _candidate_documents(candidates, page_id, page_bbox, geometry)
        if candidate_documents:
            blocks, unit_evidence, decisions = await self._reconcile_document_units(
                raster,
                page_id,
                candidate_documents,
                supporting,
                geometry.blocks,
                visual_regions,
            )
            evidence.extend(unit_evidence)
            column_split = _column_split_from_evidence(supporting, page_bbox)
            blocks, removed_unit_ids = _collapse_aggregate_text_blocks(
                blocks,
                page_bbox,
                column_split,
            )
            decisions = [decision for decision in decisions if decision.unit_id not in removed_unit_ids]
            if decisions and not any(decision.hard_checks_passed for decision in decisions):
                fallback = _strict_local_fallback(raster, page_id, page_bbox, supporting)
                if fallback is not None:
                    blocks, fallback_evidence, fallback_decisions, assets = fallback
                    evidence.append(fallback_evidence)
                    decisions.extend(fallback_decisions)
                    return ProcessedPage(
                        page_id,
                        blocks,
                        evidence,
                        decisions,
                        assets,
                        {**_page_artifact(page_id, raster), **self._crop_artifacts(page_id)},
                        degraded_reasons=[
                            *degraded_reasons,
                            "model candidates failed hard checks; used local evidence",
                            "original raster retained",
                        ],
                    )
                block, assets = unreadable_block(page_id, page_bbox, raster.png_bytes())
                decision_id = f"decision-{page_id}-unreadable"
                block = block.model_copy(update={"decision_id": decision_id})
                decisions.append(
                    Decision(
                        id=decision_id,
                        unit_id=block.id,
                        reason="no extraction unit passed hard checks",
                        unresolved=True,
                        hard_checks_passed=False,
                    )
                )
                return ProcessedPage(
                    page_id,
                    [block],
                    evidence,
                    decisions,
                    assets,
                    {**_page_artifact(page_id, raster), **self._crop_artifacts(page_id)},
                    failed=True,
                    degraded_reasons=[*degraded_reasons, "raster fallback"],
                )
            if len({candidate.evidence.source_family for candidate in candidate_documents}) < 2:
                degraded_reasons.append("missing independent model family")
        else:
            fallback = _fallback_candidate(page_id, supporting, page_bbox)
            if fallback:
                evidence.append(fallback)
                blocks = blocks_from_html(
                    fallback.html, page_id, page_bbox, f"decision-{page_id}-fallback", geometry.blocks
                )
                decisions = [
                    Decision(
                        id=f"decision-{page_id}-fallback",
                        unit_id=blocks[0].id,
                        selected_evidence_id=fallback.id,
                        reason="local OCR/PDF fallback",
                        unresolved=True,
                        hard_checks_passed=True,
                    )
                ]
                degraded_reasons.append("model extraction unavailable; used local evidence")
            else:
                block, assets = unreadable_block(page_id, page_bbox, raster.png_bytes())
                block = block.model_copy(update={"decision_id": f"decision-{page_id}-unreadable"})
                return ProcessedPage(
                    page_id,
                    [block],
                    evidence,
                    [
                        Decision(
                            id=f"decision-{page_id}-unreadable",
                            unit_id=block.id,
                            reason="no extraction source yielded readable content",
                            unresolved=True,
                            hard_checks_passed=False,
                        )
                    ],
                    assets,
                    {**_page_artifact(page_id, raster), **self._crop_artifacts(page_id)},
                    failed=True,
                    degraded_reasons=[*degraded_reasons, "raster fallback"],
                )
        blocks, visual_assets, visual_decisions, visual_evidence = _attach_visual_assets(
            raster.image,
            page_id,
            blocks,
            visual_regions,
        )
        blocks = _order_blocks(blocks, page_bbox, _column_split_from_evidence(supporting, page_bbox))
        evidence.extend(visual_evidence)
        decisions.extend(visual_decisions)
        return ProcessedPage(
            page_id,
            blocks,
            evidence,
            decisions,
            visual_assets,
            {**_page_artifact(page_id, raster), **self._crop_artifacts(page_id)},
            degraded_reasons=degraded_reasons,
        )

    async def _request_candidates(
        self,
        raster: RasterPage,
        page_id: str,
        unit_id: str,
        bbox: BBox,
        retry: bool,
    ) -> list[Evidence]:
        image, transform = crop_with_transform(
            raster.image,
            bbox,
            self.config.crop_padding if retry else 0.0,
            self.config.crop_upscale if retry else 1.0,
            self.config.max_raster_long_edge,
        )
        image_data = io.BytesIO()
        image.save(image_data, "PNG")
        image_png = image_data.getvalue()
        if retry:
            digest = hashlib.sha256(image_png).hexdigest()
            self._request_artifacts[f"raw/crops/{unit_id}-retry-{digest}.png"] = image_png
        request = ModelRequest(
            request_id=f"{unit_id}{'-retry' if retry else ''}",
            unit_id=unit_id,
            page_id=page_id,
            raster_sha256=raster.raster_sha256,
            crop_bbox=bbox,
            source_transform=transform,
            profile=self.config.hardware_profile,
            prompt_version="crop-conflict-v1" if retry else "semantic-html-v2",
            image_png=image_png,
            retry=retry,
        )
        values = await asyncio.gather(
            *(self._call_adapter(adapter, request, image) for adapter in self.adapters)
        )
        return values

    def _crop_artifacts(self, page_id: str) -> dict[str, bytes]:
        paths = [
            path for path in self._request_artifacts if PurePosixPath(path).name.startswith(f"{page_id}-")
        ]
        return {path: self._request_artifacts.pop(path) for path in paths}

    async def _call_adapter(
        self,
        adapter: ModelAdapter,
        request: ModelRequest,
        image: Image.Image,
    ) -> Evidence:
        adapter_config = getattr(adapter, "config", None)
        if adapter_config is not None:
            request = request.model_copy(update={"prompt_version": adapter_config.prompt_version})
        try:
            parameter_count = len(inspect.signature(adapter.extract).parameters)
            if self._single_spark_queue is None:
                value = await self._invoke_adapter(adapter, request, image, parameter_count)
            else:
                async with self._single_spark_queue:
                    value = await self._invoke_adapter(adapter, request, image, parameter_count)
        except Exception as error:
            if self.metrics:
                self.metrics.observe_model_error(adapter.name)
            return CandidateEvidence(
                id=f"{adapter.name}-{request.request_id}",
                source=adapter.name,
                page_id=request.page_id,
                unit_id=request.unit_id,
                bbox=request.crop_bbox,
                valid=False,
                rejection_reasons=[f"request_error:{type(error).__name__}"],
            )
        if isinstance(value, ModelResponse):
            if self.metrics:
                self.metrics.observe_model(value)
            if self.config.preserve_raw_responses:
                relative = f"raw/responses/{request.page_id}-{value.adapter}-{request.request_id}.json"
                self._request_artifacts[relative] = json.dumps(
                    value.model_dump(mode="json"),
                    ensure_ascii=False,
                    indent=2,
                ).encode()
            return response_to_evidence(value, request)
        if not isinstance(value, Evidence):
            return CandidateEvidence(
                id=f"{adapter.name}-{request.request_id}",
                source=adapter.name,
                page_id=request.page_id,
                unit_id=request.unit_id,
                bbox=request.crop_bbox,
                valid=False,
                rejection_reasons=["malformed_adapter_response"],
            )
        markup, reasons = sanitize_candidate(value.html) if value.html else ("", [])
        text = _markup_text(markup) if markup else value.text
        return CandidateEvidence(
            **value.model_dump(
                exclude={
                    "id",
                    "source",
                    "page_id",
                    "unit_id",
                    "bbox",
                    "html",
                    "text",
                    "valid",
                    "rejection_reasons",
                    "transform",
                }
            ),
            id=f"{adapter.name}-{request.request_id}",
            source=adapter.name,
            page_id=request.page_id,
            unit_id=request.unit_id,
            bbox=request.crop_bbox,
            html=markup,
            text=text,
            valid=value.valid and not has_fatal_sanitization_reason(reasons) and bool(text.strip()),
            rejection_reasons=sorted(set([*value.rejection_reasons, *reasons])),
            transform=request.source_transform,
        )

    @staticmethod
    async def _invoke_adapter(
        adapter: ModelAdapter,
        request: ModelRequest,
        image: Image.Image,
        parameter_count: int,
    ) -> ModelResponse | Evidence | object:
        if parameter_count == 1:
            return await adapter.extract(request)
        return await adapter.extract(image, request.unit_id)  # type: ignore[call-arg]

    async def _reconcile_document_units(
        self,
        raster: RasterPage,
        page_id: str,
        candidates: list[CandidateDocument],
        supporting: list[Evidence],
        geometry_blocks: list[Block],
        visual_regions: list[BBox],
    ) -> tuple[list[Block], list[Evidence], list[Decision]]:
        base = max(
            candidates,
            key=lambda item: (
                "malformed_table" not in item.evidence.rejection_reasons,
                len(item.blocks),
                sum(isinstance(block, Table) for block in item.blocks),
                item.evidence.source == "nuextract3",
            ),
        )
        alignments = {item.evidence.id: _align_blocks(base.blocks, item.blocks) for item in candidates}
        output: list[Block] = []
        evidence: list[Evidence] = []
        decisions: list[Decision] = []
        page_bbox: BBox = (0, 0, raster.image.width, raster.image.height)
        column_split = _column_split_from_evidence(supporting, page_bbox)
        for order, base_block in enumerate(base.blocks):
            aligned = [
                (item.evidence, alignments[item.evidence.id].get(order))
                for item in candidates
                if alignments[item.evidence.id].get(order) is not None
            ]
            if isinstance(base_block, Table):
                geometry_table = _matching_geometry_table(base_block, geometry_blocks)
                projected_base = (
                    _project_table_structure(
                        base_block,
                        geometry_table,
                        supporting,
                        visual_regions,
                    )
                    if geometry_table is not None
                    else None
                )
                authoritative_base = projected_base or (base_block if base_block.column_boundaries else None)
                if authoritative_base is not None:
                    aligned = [
                        (
                            parent,
                            authoritative_base
                            if block is base_block
                            else _project_table_values(block, authoritative_base, supporting),
                        )
                        for parent, block in aligned
                        if isinstance(block, Table)
                    ]
                    base_block = authoritative_base
                table, table_evidence, table_decisions = await self._reconcile_table(
                    raster,
                    page_id,
                    base_block,
                    aligned,
                    supporting,
                )
                output.append(table.model_copy(update={"reading_order": order}))
                evidence.extend(table_evidence)
                decisions.extend(table_decisions)
            else:
                text_values = [(parent, block) for parent, block in aligned if isinstance(block, TextBlock)]
                matched_bbox = _matching_text_bbox(base_block, supporting, column_split)
                base_block = base_block.model_copy(
                    update={
                        "bbox": matched_bbox
                        if matched_bbox is not None
                        else _expanded_text_bbox(base_block.bbox, supporting, column_split)
                    }
                )
                block, block_evidence, decision = await self._select_text_block(
                    raster,
                    page_id,
                    base_block,
                    text_values,
                    supporting,
                    allow_spatial_fallback=_spatial_fallback_allowed(
                        base_block.bbox,
                        page_bbox,
                        len(base.blocks),
                    ),
                )
                output.append(block.model_copy(update={"reading_order": order}))
                evidence.extend(block_evidence)
                decisions.append(decision)
        return output, evidence, decisions

    async def _select_text_block(
        self,
        raster: RasterPage,
        page_id: str,
        base: TextBlock,
        values: list[tuple[Evidence, TextBlock]],
        supporting: list[Evidence],
        allow_spatial_fallback: bool = True,
    ) -> tuple[TextBlock, list[Evidence], Decision]:
        unit_id = base.id
        candidates = [_evidence_for_text(parent, block, unit_id, base.bbox) for parent, block in values]
        by_id = {candidate.id: block for candidate, (_, block) in zip(candidates, values, strict=True)}
        selected, decision = reconcile(
            unit_id, candidates, _supporting_for_bbox(supporting, base.bbox), base.bbox
        )
        retry_record = None
        if (
            allow_spatial_fallback
            and _should_retry(candidates, len(self.adapters))
            and not _selected_is_grounded(selected, base.bbox, supporting)
        ):
            retry, retry_blocks = await self._retry_text(raster, page_id, unit_id, base)
            candidates.extend(retry)
            by_id.update(retry_blocks)
            selected, decision = reconcile(
                unit_id, candidates, _supporting_for_bbox(supporting, base.bbox), base.bbox
            )
            retry_record = RetryRecord(
                request_id=f"{unit_id}-retry",
                bbox=base.bbox,
                candidate_ids=[item.id for item in retry],
                reason="conflicting complete block candidates",
            )
            if _family_outputs_conflict(retry) and not _unique_cross_family_consensus(selected, candidates):
                decision.unresolved = True
                decision.reason += "; conflict persisted after retry"
        if selected is None and allow_spatial_fallback:
            local = _local_candidate(unit_id, base.bbox, supporting)
            if local:
                local_block = base.model_copy(
                    update={"paragraphs": local.text.splitlines(), "confidence": local.confidence}
                )
                candidates.append(local)
                by_id[local.id] = local_block
                selected, decision = reconcile(
                    unit_id,
                    candidates,
                    _supporting_for_bbox(supporting, base.bbox),
                    base.bbox,
                )
                decision.unresolved = True
                decision.reason += "; local evidence fallback"
        if retry_record:
            decision.retries.append(retry_record)
        if len({candidate.source_family for candidate in candidates if candidate.valid}) < 2:
            decision.unresolved = True
            decision.reason += "; missing independent family"
        chosen = by_id.get(selected.id) if selected else base
        if chosen is None:
            chosen = base
            decision.unresolved = True
            decision.hard_checks_passed = False
            decision.reason += "; selected text candidate had no canonical text block"
        chosen = chosen.model_copy(
            update={
                "id": unit_id,
                "bbox": base.bbox,
                "confidence": selected.confidence if selected else 0.0,
                "decision_id": decision.id,
            }
        )
        return chosen, candidates, decision

    async def _retry_text(
        self,
        raster: RasterPage,
        page_id: str,
        unit_id: str,
        base: TextBlock,
    ) -> tuple[list[Evidence], dict[str, TextBlock]]:
        candidates = await self._request_candidates(raster, page_id, unit_id, base.bbox, retry=True)
        evidence = []
        result: dict[str, TextBlock] = {}
        for candidate in candidates:
            blocks = (
                blocks_from_html(
                    candidate.html,
                    f"{unit_id}-retry",
                    base.bbox,
                    f"decision-{unit_id}",
                    [base],
                )
                if candidate.valid
                else []
            )
            block = next((item for item in blocks if isinstance(item, TextBlock)), None)
            if block:
                result[candidate.id] = block
            elif candidate.valid:
                candidate = candidate.model_copy(
                    update={
                        "valid": False,
                        "rejection_reasons": [
                            *candidate.rejection_reasons,
                            "malformed_text_payload",
                        ],
                    }
                )
            evidence.append(candidate)
        return evidence, result

    async def _reconcile_table(
        self,
        raster: RasterPage,
        page_id: str,
        base: Table,
        values: list[tuple[Evidence, Block | None]],
        supporting: list[Evidence],
    ) -> tuple[Table, list[Evidence], list[Decision]]:
        tables = [(parent, block) for parent, block in values if isinstance(block, Table)]
        topology = _topology(base)
        table_candidates = [
            _evidence_for_table(parent, table, base.id, base.bbox) for parent, table in tables
        ]
        topology_supporting = [item for item in supporting if item.source not in {"ppocr", "embedded_pdf"}]
        selected, table_decision = reconcile(
            base.id,
            table_candidates,
            _supporting_for_bbox(topology_supporting, base.bbox),
            base.bbox,
            topology,
        )
        if selected is not None:
            table_decision.unresolved = False
            table_decision.reason = "table topology reconciliation"
        retry_record = None
        if _table_retry_needed(table_candidates, len(self.adapters)):
            retry_candidates = await self._request_candidates(raster, page_id, base.id, base.bbox, retry=True)
            retry_tables = _retry_table_values(retry_candidates, base)
            if base.column_boundaries:
                retry_tables = _project_retry_table_values(retry_tables, base, supporting)
            tables.extend(retry_tables[1])
            table_candidates.extend(retry_tables[0])
            selected, table_decision = reconcile(
                base.id,
                table_candidates,
                _supporting_for_bbox(topology_supporting, base.bbox),
                base.bbox,
                topology,
            )
            if selected is not None:
                table_decision.unresolved = False
                table_decision.reason = "table topology reconciliation"
            retry_record = RetryRecord(
                request_id=f"{base.id}-retry",
                bbox=base.bbox,
                candidate_ids=[item.id for item in retry_tables[0]],
                reason="conflicting complete table topology candidates",
            )
        elif _table_content_retry_needed(
            base,
            tables,
            supporting,
            len(self.adapters),
        ):
            retry_candidates = await self._request_candidates(raster, page_id, base.id, base.bbox, retry=True)
            retry_tables = _project_retry_table_values(
                _retry_table_values(retry_candidates, base),
                base,
                supporting,
            )
            tables.extend(retry_tables[1])
            table_candidates.extend(retry_tables[0])
            selected, table_decision = reconcile(
                base.id,
                table_candidates,
                _supporting_for_bbox(topology_supporting, base.bbox),
                base.bbox,
                topology,
            )
            if selected is not None:
                table_decision.unresolved = False
                table_decision.reason = "table topology reconciliation"
            retry_record = RetryRecord(
                request_id=f"{base.id}-retry",
                bbox=base.bbox,
                candidate_ids=[item.id for item in retry_tables[0]],
                reason="conflicting complete table cell candidates",
            )
        if retry_record:
            table_decision.retries.append(retry_record)
            if _table_family_conflict(retry_tables[0]) and not _unique_cross_family_consensus(
                selected,
                table_candidates,
                topology=True,
            ):
                table_decision.unresolved = True
                table_decision.reason += "; topology conflict persisted after retry"
        topology_families = {
            candidate.source_family
            for candidate in table_candidates
            if candidate.valid and candidate.metadata.get("topology") == topology
        }
        if len(topology_families) < min(2, len(self.adapters)):
            table_decision.unresolved = True
            table_decision.reason += "; missing independent topology family"
        selected_table = next(
            (
                table
                for evidence, (_, table) in zip(table_candidates, tables, strict=True)
                if selected and evidence.id == selected.id
            ),
            base,
        )
        evidence = list(table_candidates)
        decisions = [table_decision]
        cells = []
        ambiguous_cell_ids = _ambiguous_cell_ids(base)
        compatible = [(parent, table) for parent, table in tables if _topology(table) == topology]
        for cell in sorted(base.cells, key=lambda item: (item.row, item.column)):
            candidates_with_cells = _matching_table_cells(cell, compatible)
            chosen, cell_evidence, decision = await self._select_cell(
                raster,
                page_id,
                cell,
                candidates_with_cells,
                supporting,
                allow_retry=False,
                allow_spatial_fallback=cell.id not in ambiguous_cell_ids,
            )
            cells.append(chosen)
            evidence.extend(cell_evidence)
            decisions.append(decision)
        cells = _normalize_table_sections(cells)
        return (
            selected_table.model_copy(
                update={
                    "id": base.id,
                    "bbox": base.bbox,
                    "cells": cells,
                    "confidence": selected.confidence if selected else 0.0,
                    "decision_id": table_decision.id,
                }
            ),
            evidence,
            decisions,
        )

    async def _select_cell(
        self,
        raster: RasterPage,
        page_id: str,
        base: Cell,
        values: list[tuple[Evidence, Cell]],
        supporting: list[Evidence],
        allow_retry: bool = True,
        allow_spatial_fallback: bool = True,
    ) -> tuple[Cell, list[Evidence], Decision]:
        candidates = [_evidence_for_cell(parent, cell, base.id, base.bbox) for parent, cell in values]
        by_id = {candidate.id: cell for candidate, (_, cell) in zip(candidates, values, strict=True)}
        selected, decision = reconcile(
            base.id, candidates, _supporting_for_bbox(supporting, base.bbox), base.bbox
        )
        local = _local_candidate(base.id, base.bbox, supporting) if allow_spatial_fallback else None
        empty_supported = _empty_cell_supported(base, supporting)
        locally_supported = local is not None or empty_supported
        retry_record = None
        if (
            allow_retry
            and not empty_supported
            and (selected is None or _should_retry(candidates, len(self.adapters), locally_supported))
        ):
            retry = await self._request_candidates(raster, page_id, base.id, base.bbox, retry=True)
            retry_cells = _retry_cell_values(retry, base)
            candidates.extend(retry_cells[0])
            by_id.update(retry_cells[1])
            selected, decision = reconcile(
                base.id, candidates, _supporting_for_bbox(supporting, base.bbox), base.bbox
            )
            retry_record = RetryRecord(
                request_id=f"{base.id}-retry",
                bbox=base.bbox,
                candidate_ids=[item.id for item in retry_cells[0]],
                reason="conflicting complete cell candidates",
            )
            if _family_outputs_conflict(retry_cells[0]) and not _unique_cross_family_consensus(
                selected, candidates
            ):
                decision.unresolved = True
                decision.reason += "; conflict persisted after retry"
        if selected is None and local:
            local_cell = base.model_copy(
                update={"paragraphs": local.text.splitlines(), "confidence": local.confidence}
            )
            candidates.append(local)
            by_id[local.id] = local_cell
            selected, decision = reconcile(
                base.id,
                candidates,
                _supporting_for_bbox(supporting, base.bbox),
                base.bbox,
            )
            decision.unresolved = True
            decision.reason += "; local evidence fallback"
        elif selected is None and empty_supported:
            decision.unresolved = False
            decision.hard_checks_passed = True
            decision.reason = "empty cell supported by OpenCV geometry"
        if retry_record:
            decision.retries.append(retry_record)
        if (
            len({candidate.source_family for candidate in candidates if candidate.valid}) < 2
            and not locally_supported
        ):
            decision.unresolved = True
            decision.reason += "; missing independent family"
        chosen = by_id.get(selected.id) if selected else base
        return (
            chosen.model_copy(
                update={
                    "id": base.id,
                    "bbox": base.bbox,
                    "confidence": selected.confidence if selected else 0.0,
                    "decision_id": decision.id,
                }
            ),
            candidates,
            decision,
        )

    def _failed_ingestion(self, input_names: list[str], reason: str) -> ExtractionResult:
        document_id = f"doc-{hashlib.sha256('|'.join(input_names).encode()).hexdigest()[:16]}"
        document = Document(id=document_id, pages=[])
        decision = Decision(
            id="decision-ingestion",
            unit_id="ingestion",
            reason=reason[:240],
            unresolved=True,
            hard_checks_passed=False,
        )
        result = ExtractionResult(
            document=document,
            status=Status.FAILED,
            evidence=[
                Evidence(
                    id="ingestion-failure",
                    source="ingest",
                    valid=False,
                    rejection_reasons=[reason[:240]],
                )
            ],
            decisions=[decision],
            canonical_html="",
            markdown="",
            quality=QualityReport(
                status=Status.FAILED,
                page_count=0,
                unresolved_decisions=1,
                hard_check_failures=1,
                degraded_reasons=["ingestion failed"],
            ),
            manifest=PackageManifest(
                document_id=document_id,
                status=Status.FAILED,
                inputs=input_names,
                hardware_profile=self.config.hardware_profile,
                models=[
                    {
                        "id": endpoint.model_id,
                        "revision": endpoint.revision,
                        "prompt_version": endpoint.prompt_version,
                    }
                    for endpoint in (self.config.nu_extract, self.config.gemma)
                ],
            ),
        )
        result.canonical_html = render_html(result)
        if not canonical_round_trip_preserves(document, result.canonical_html):
            raise RuntimeError("failure canonical HTML round-trip lost IR relationships")
        result.markdown = render_markdown(result)
        return result


def _record_text_corrections(
    corrections: list[TextCorrection],
    evidence: list[Evidence],
    decisions: list[Decision],
) -> None:
    decisions_by_id = {decision.id: decision for decision in decisions}
    for correction in corrections:
        decision = decisions_by_id.get(correction.decision_id or "")
        previous_evidence_id = decision.selected_evidence_id if decision else None
        evidence_id = f"postprocess-{correction.unit_id}"
        evidence.append(
            CandidateEvidence(
                id=evidence_id,
                source="document_context_rules",
                source_family="rules",
                page_id=correction.page_id,
                unit_id=correction.unit_id,
                text=correction.after,
                html="<p>" + std_html.escape(correction.after).replace("\n", "<br>") + "</p>",
                bbox=correction.bbox,
                confidence=correction.confidence,
                metadata={
                    "engine": "document_context_rules_v1",
                    "before": correction.before,
                    "previous_evidence_id": previous_evidence_id,
                },
            )
        )
        if decision is None:
            decision = Decision(
                id=f"decision-{correction.unit_id}-postprocess",
                unit_id=correction.unit_id,
                selected_evidence_id=evidence_id,
                reason="same-page canonical military designation normalization",
                hard_checks_passed=True,
            )
            decisions.append(decision)
            decisions_by_id[decision.id] = decision
            continue
        if previous_evidence_id and previous_evidence_id not in decision.alternative_evidence_ids:
            decision.alternative_evidence_ids.append(previous_evidence_id)
        decision.selected_evidence_id = evidence_id
        decision.reason += "; same-page canonical military designation normalization"


def _resolve_inputs(
    inputs: list[str | Path],
    manifest: str | Path | dict[str, Any] | None,
) -> tuple[list[Path], list[str], dict[str, str | int | float | bool | None]]:
    if len(inputs) > 1 and manifest is None:
        raise ValueError("A manifest is required to group multiple input files")
    if manifest is None:
        paths = [Path(value) for value in inputs]
        return paths, [safe_relative_path(path.name) for path in paths], {}
    if isinstance(manifest, (str, Path)):
        manifest_path = Path(manifest)
        data = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
        base = manifest_path.resolve().parent
    else:
        data = manifest
        base = Path.cwd().resolve()
    parsed = InputManifest.model_validate(data)
    paths = []
    for relative in parsed.inputs:
        target = (base / PurePosixPath(relative)).resolve()
        if target != base and base not in target.parents:
            raise ValueError(f"manifest input escapes its directory: {relative}")
        paths.append(target)
    return paths, parsed.inputs, parsed.metadata


def _document_id(pages: list[Page]) -> str:
    value = "|".join(f"{page.raster_sha256}:{page.instance}" for page in pages).encode()
    return f"doc-{hashlib.sha256(value).hexdigest()[:16]}"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _candidate_documents(
    candidates: list[Evidence],
    page_id: str,
    bbox: BBox,
    geometry: GeometryResult,
) -> list[CandidateDocument]:
    result = []
    for candidate in candidates:
        if not candidate.valid or not candidate.html:
            continue
        try:
            blocks = blocks_from_html(candidate.html, page_id, bbox, f"decision-{page_id}", geometry.blocks)
        except (ValueError, TypeError):
            continue
        if blocks and any(_block_text(block).strip() for block in blocks):
            result.append(CandidateDocument(candidate, blocks))
    return result


def _merge_paddle_skeleton(
    geometry_blocks: list[Block],
    evidence: list[Evidence],
    page_id: str,
) -> list[Block]:
    paddle_blocks: list[Block] = []
    table_evidence = [item for item in evidence if isinstance(item, TableEvidence)]
    cell_evidence = [item for item in evidence if isinstance(item, CellEvidence)]
    for table_index, table in enumerate(table_evidence):
        cells = [
            Cell(
                id=f"{page_id}-pt{table_index + 1}-c{index + 1}",
                row=item.row,
                column=item.column,
                rowspan=item.rowspan,
                colspan=item.colspan,
                bbox=item.bbox,
                paragraphs=[item.text] if item.text else [],
                confidence=item.confidence,
            )
            for index, item in enumerate(cell_evidence)
            if item.metadata.get("table_id") == table.unit_id and item.bbox is not None
        ]
        if not cells:
            continue
        try:
            paddle_blocks.append(
                Table(
                    id=table.unit_id or f"{page_id}-pt{table_index + 1}",
                    bbox=table.bbox,
                    reading_order=table_index,
                    cells=cells,
                    column_boundaries=sorted(
                        {value for cell in cells for value in (cell.bbox[0], cell.bbox[2])}
                    ),
                    confidence=table.confidence,
                )
            )
        except ValueError:
            continue
    regions = [item for item in evidence if isinstance(item, RegionEvidence)]
    for index, region in enumerate(regions):
        if region.region_type in {"table", "figure", "photo", "map", "diagram"} or not region.text:
            continue
        kind = (
            "heading"
            if region.region_type == "title"
            else "list"
            if region.region_type == "list"
            else "paragraph"
        )
        paddle_blocks.append(
            TextBlock(
                kind=kind,
                id=f"{page_id}-pr{index + 1}",
                bbox=region.bbox,
                reading_order=int(region.metadata.get("parsing_order", index)),
                paragraphs=[region.text],
                level=2 if kind == "heading" else None,
                confidence=region.confidence,
            )
        )
    geometry_tables = [block for block in geometry_blocks if isinstance(block, Table)]
    paddle_tables = [
        block
        for block in paddle_blocks
        if isinstance(block, Table)
        and not any(_intersection_ratio(block.bbox, table.bbox) > 0.5 for table in geometry_tables)
    ]
    paddle_text = [block for block in paddle_blocks if isinstance(block, TextBlock)]
    geometry_text = (
        [] if paddle_text else [block for block in geometry_blocks if isinstance(block, TextBlock)]
    )
    combined = [*geometry_tables, *paddle_tables, *paddle_text, *geometry_text]
    combined.sort(key=lambda item: (item.bbox[1], item.bbox[0], item.reading_order))
    return [block.model_copy(update={"reading_order": index}) for index, block in enumerate(combined)]


def _fallback_candidate(page_id: str, supporting: list[Evidence], bbox: BBox) -> Evidence | None:
    sources = [item for item in supporting if item.source in {"embedded_pdf", "ppocr"} and item.text]
    if not sources:
        return None
    ordered = sorted(sources, key=lambda item: ((item.bbox or bbox)[1], (item.bbox or bbox)[0]))
    markup, reasons = sanitize_candidate(
        "<article><p>" + "<br>".join(std_html.escape(item.text) for item in ordered) + "</p></article>"
    )
    return CandidateEvidence(
        id=f"fallback-{page_id}",
        source="local_evidence",
        page_id=page_id,
        unit_id=f"{page_id}-fallback",
        html=markup,
        text="\n".join(item.text for item in ordered),
        bbox=bbox,
        confidence=max((item.confidence for item in ordered), default=0.0),
        valid=not has_fatal_sanitization_reason(reasons),
        rejection_reasons=reasons,
    )


def _strict_local_fallback(
    raster: RasterPage,
    page_id: str,
    bbox: BBox,
    supporting: list[Evidence],
) -> tuple[list[Block], Evidence, list[Decision], dict[str, bytes]] | None:
    fallback = _fallback_candidate(page_id, supporting, bbox)
    if fallback is None:
        return None
    raster_block, assets = unreadable_block(page_id, bbox, raster.png_bytes())
    raster_decision_id = f"decision-{page_id}-raster-fallback"
    raster_block = raster_block.model_copy(
        update={"id": f"{page_id}-raster-fallback", "decision_id": raster_decision_id}
    )
    local_decision_id = f"decision-{page_id}-local-fallback"
    local_blocks = blocks_from_html(
        fallback.html,
        f"{page_id}-local",
        bbox,
        local_decision_id,
    )
    if not local_blocks:
        return None
    local_blocks = [
        block.model_copy(update={"reading_order": index + 1}) for index, block in enumerate(local_blocks)
    ]
    decisions = [
        Decision(
            id=raster_decision_id,
            unit_id=raster_block.id,
            reason="original raster retained beside local OCR fallback",
            unresolved=True,
            hard_checks_passed=False,
        ),
        Decision(
            id=local_decision_id,
            unit_id=local_blocks[0].id,
            selected_evidence_id=fallback.id,
            reason="model candidates failed hard checks; local OCR fallback",
            unresolved=True,
            hard_checks_passed=True,
        ),
    ]
    return [raster_block, *local_blocks], fallback, decisions, assets


def _matching_geometry_table(base: Table, blocks: list[Block]) -> Table | None:
    candidates = [
        block
        for block in blocks
        if isinstance(block, Table)
        and len(block.column_boundaries) >= 2
        and _intersection_ratio(block.bbox, base.bbox) >= 0.5
        and _intersection_ratio(base.bbox, block.bbox) >= 0.5
    ]
    return max(candidates, key=lambda table: _intersection_ratio(table.bbox, base.bbox), default=None)


def _project_table_structure(
    base: Table,
    geometry: Table,
    supporting: list[Evidence],
    visual_regions: list[BBox] | None = None,
) -> Table | None:
    semantic_rows, column_count = table_dimensions(base)
    geometry_rows, _ = table_dimensions(geometry)
    geometry_columns = len(geometry.column_boundaries) - 1
    row_count = min(semantic_rows, geometry_rows)
    if (
        row_count == 0
        or geometry_columns < column_count
        or (geometry_columns == column_count and geometry_rows == row_count and base.column_boundaries)
    ):
        return None
    column_boundaries = geometry.column_boundaries
    if len(column_boundaries) != geometry_columns + 1:
        return None
    row_boundaries = _projected_row_boundaries(
        geometry,
        row_count,
        supporting,
        base,
        visual_regions or [],
    )
    if row_boundaries is None:
        return None
    source_rows = _projected_source_rows(base, geometry, row_boundaries, supporting)
    occupied: set[tuple[int, int]] = set()
    projected: list[Cell] = []
    for row in range(row_count):
        source_row = source_rows.get(row, row)
        sources = sorted(
            (cell for cell in base.cells if cell.row == source_row),
            key=lambda cell: cell.column,
        )
        anchors = _geometry_row_anchors(
            geometry,
            row_boundaries,
            column_boundaries,
            row,
            occupied,
        )
        if len(sources) > len(anchors):
            sources = _collapsed_full_width_sources(
                base,
                geometry,
                row_boundaries,
                supporting,
                row,
                anchors,
            )
            if sources is None:
                return None
        target_text = [
            _local_text(
                (
                    column_boundaries[column],
                    row_boundaries[row],
                    column_boundaries[column + colspan],
                    row_boundaries[row + 1],
                ),
                supporting,
            )
            for column, colspan in anchors
        ]
        mapping = _align_text_sequences(
            [_block_text_value(cell.paragraphs) for cell in sources],
            target_text,
        )
        source_by_target = {target: sources[source] for target, source in mapping.items()}
        header_row = bool(sources) and all(cell.section == "thead" for cell in sources)
        for target, (column, colspan) in enumerate(anchors):
            source = source_by_target.get(target)
            rowspan = min(source.rowspan, row_count - row) if source else 1
            positions = {
                (target_row, target_column)
                for target_row in range(row, row + rowspan)
                for target_column in range(column, column + colspan)
            }
            if positions & occupied:
                rowspan = 1
                positions = {(row, target_column) for target_column in range(column, column + colspan)}
            occupied |= positions
            bbox = (
                column_boundaries[column],
                row_boundaries[row],
                column_boundaries[column + colspan],
                row_boundaries[row + rowspan],
            )
            if source:
                cell = source.model_copy(
                    update={
                        "id": f"{base.id}-r{row + 1}c{column + 1}",
                        "row": row,
                        "column": column,
                        "rowspan": rowspan,
                        "colspan": colspan,
                        "bbox": bbox,
                    }
                )
            else:
                cell = Cell(
                    id=f"{base.id}-r{row + 1}c{column + 1}",
                    row=row,
                    column=column,
                    colspan=colspan,
                    bbox=bbox,
                    is_header=header_row,
                    section="thead" if header_row else "tbody",
                    confidence=base.confidence,
                )
            projected.append(cell)
    projected_bbox = (
        geometry.bbox[0],
        row_boundaries[0],
        geometry.bbox[2],
        row_boundaries[-1],
    )
    try:
        return Table.model_validate(
            {
                **base.model_dump(),
                "bbox": projected_bbox,
                "cells": projected,
                "column_boundaries": column_boundaries,
            }
        )
    except ValueError:
        return None


def _collapsed_full_width_sources(
    base: Table,
    geometry: Table,
    row_boundaries: list[int],
    supporting: list[Evidence],
    row: int,
    anchors: list[tuple[int, int]],
) -> list[Cell] | None:
    if anchors != [(0, len(geometry.column_boundaries) - 1)]:
        return None
    bbox = (geometry.bbox[0], row_boundaries[row], geometry.bbox[2], row_boundaries[row + 1])
    text = _local_text(bbox, supporting)
    return [
        Cell(
            id=f"{base.id}-r{row + 1}c1",
            row=row,
            column=0,
            bbox=bbox,
            paragraphs=text.splitlines(),
            confidence=base.confidence,
        )
    ]


def _projected_row_boundaries(
    geometry: Table,
    row_count: int,
    supporting: list[Evidence],
    semantic: Table | None = None,
    visual_regions: list[BBox] | None = None,
) -> list[int] | None:
    boundaries = sorted({value for cell in geometry.cells for value in (cell.bbox[1], cell.bbox[3])})
    if len(boundaries) < 2:
        return None
    while len(boundaries) - 1 < row_count:
        index = max(
            range(len(boundaries) - 1),
            key=lambda value: boundaries[value + 1] - boundaries[value],
        )
        midpoint = (boundaries[index] + boundaries[index + 1]) // 2
        if midpoint in {boundaries[index], boundaries[index + 1]}:
            return None
        boundaries.insert(index + 1, midpoint)
    consecutive = _matching_row_window(
        geometry,
        semantic,
        boundaries,
        row_count,
        supporting,
        visual_regions or [],
    )
    if consecutive is not None:
        return consecutive
    local = [
        item
        for item in supporting
        if item.source in {"ppocr", "embedded_pdf"}
        and item.bbox is not None
        and _intersection_ratio(item.bbox, geometry.bbox) >= SUPPORTING_EVIDENCE_MIN_COVERAGE
    ]
    while len(boundaries) - 1 > row_count:
        candidates = []
        for index in range(1, len(boundaries) - 1):
            boundary = boundaries[index]
            crossings = sum(item.bbox[1] < boundary < item.bbox[3] for item in local if item.bbox)
            narrowest = min(boundary - boundaries[index - 1], boundaries[index + 1] - boundary)
            candidates.append((-narrowest, crossings, -index, index))
        boundaries.pop(max(candidates)[-1])
    return boundaries


def _matching_row_window(
    geometry: Table,
    semantic: Table | None,
    boundaries: list[int],
    row_count: int,
    supporting: list[Evidence],
    visual_regions: list[BBox],
) -> list[int] | None:
    geometry_rows = len(boundaries) - 1
    if semantic is None or geometry_rows == row_count:
        return boundaries if geometry_rows == row_count else None
    semantic_first_row = [cell for cell in semantic.cells if cell.row == 0]
    if (
        geometry_rows == row_count + 1
        and len(semantic_first_row) > 1
        and _geometry_row_spans_table(geometry, boundaries[0], boundaries[1])
    ):
        return boundaries[1:]
    source_text = [
        " ".join(
            _block_text_value(cell.paragraphs)
            for cell in sorted(
                (cell for cell in semantic.cells if cell.row == row),
                key=lambda cell: cell.column,
            )
        )
        for row in range(row_count)
    ]
    target_text = [
        _local_text(
            (geometry.bbox[0], boundaries[row], geometry.bbox[2], boundaries[row + 1]),
            supporting,
        )
        for row in range(geometry_rows)
    ]
    if not any(source_text) or not any(target_text):
        return None
    candidates = {
        tuple(boundaries[start : start + row_count + 1]) for start in range(geometry_rows - row_count + 1)
    }
    excess = geometry_rows - row_count
    if 0 < excess <= 3:
        for removed in itertools.combinations(range(1, len(boundaries) - 1), excess):
            candidates.add(tuple(value for index, value in enumerate(boundaries) if index not in removed))

    def score(candidate: tuple[int, ...]) -> tuple[int, float, int, tuple[int, ...]]:
        visual_crossings = sum(
            region[1] < boundary < region[3] for region in visual_regions for boundary in candidate[1:-1]
        )
        text_score = sum(
            _text_similarity(
                source_text[row],
                _local_text(
                    (geometry.bbox[0], candidate[row], geometry.bbox[2], candidate[row + 1]),
                    supporting,
                ),
            )
            for row in range(row_count)
        )
        return -visual_crossings, text_score, candidate[-1] - candidate[0], candidate

    return list(max(candidates, key=score))


def _geometry_row_spans_table(geometry: Table, top: int, bottom: int) -> bool:
    return any(
        cell.bbox[0] == geometry.column_boundaries[0]
        and cell.bbox[2] == geometry.column_boundaries[-1]
        and cell.bbox[1] <= top
        and cell.bbox[3] >= bottom
        for cell in geometry.cells
    )


def _projected_source_rows(
    base: Table,
    geometry: Table,
    row_boundaries: list[int],
    supporting: list[Evidence],
) -> dict[int, int]:
    source_rows, _ = table_dimensions(base)
    source_text = [
        " ".join(
            _block_text_value(cell.paragraphs)
            for cell in sorted(
                (cell for cell in base.cells if cell.row == row),
                key=lambda cell: cell.column,
            )
        )
        for row in range(source_rows)
    ]
    target_text = [
        _local_text(
            (geometry.bbox[0], row_boundaries[row], geometry.bbox[2], row_boundaries[row + 1]),
            supporting,
        )
        for row in range(len(row_boundaries) - 1)
    ]
    return _align_text_sequences(source_text, target_text, allow_source_skips=True)


def _geometry_row_anchors(
    geometry: Table,
    row_boundaries: list[int],
    column_boundaries: list[int],
    row: int,
    occupied: set[tuple[int, int]],
) -> list[tuple[int, int]]:
    result = []
    column = 0
    while column < len(column_boundaries) - 1:
        if (row, column) in occupied:
            column += 1
            continue
        spans = []
        for cell in geometry.cells:
            if cell.bbox[0] != column_boundaries[column]:
                continue
            overlap = max(
                0,
                min(cell.bbox[3], row_boundaries[row + 1]) - max(cell.bbox[1], row_boundaries[row]),
            )
            if overlap == 0:
                continue
            right = next(
                (index for index, boundary in enumerate(column_boundaries) if boundary == cell.bbox[2]),
                column + 1,
            )
            colspan = max(1, right - column)
            if all((row, value) not in occupied for value in range(column, column + colspan)):
                spans.append(colspan)
        colspan = max(spans, default=1)
        result.append((column, colspan))
        column += colspan
    return result


def _project_table_values(
    candidate: Table,
    topology: Table,
    supporting: list[Evidence],
) -> Table:
    target_rows, _ = table_dimensions(topology)
    source_rows, _ = table_dimensions(candidate)
    target_text = [
        " ".join(
            _block_text_value(cell.paragraphs)
            for cell in sorted(
                (cell for cell in topology.cells if cell.row == row),
                key=lambda cell: cell.column,
            )
        )
        or _local_text(_table_row_bbox(topology, row), supporting)
        for row in range(target_rows)
    ]
    source_text = [
        " ".join(
            _block_text_value(cell.paragraphs)
            for cell in sorted(
                (cell for cell in candidate.cells if cell.row == row),
                key=lambda cell: cell.column,
            )
        )
        for row in range(source_rows)
    ]
    row_mapping = _align_text_sequences(source_text, target_text, allow_source_skips=True)
    output = [
        cell.model_copy(
            update={
                "paragraphs": [],
                "confidence": 0.0,
                "asset": None,
                "image_present": False,
            }
        )
        for cell in topology.cells
    ]
    output_by_position = {(cell.row, cell.column): index for index, cell in enumerate(output)}
    for target_row, source_row in row_mapping.items():
        sources = sorted(
            (cell for cell in candidate.cells if cell.row == source_row),
            key=lambda cell: cell.column,
        )
        targets = sorted(
            (cell for cell in topology.cells if cell.row == target_row),
            key=lambda cell: cell.column,
        )
        mapping = _align_text_sequences(
            [_block_text_value(cell.paragraphs) for cell in sources],
            [_block_text_value(cell.paragraphs) or _local_text(cell.bbox, supporting) for cell in targets],
            allow_source_skips=True,
        )
        for target, source in mapping.items():
            target_cell = targets[target]
            source_cell = sources[source]
            output[output_by_position[(target_cell.row, target_cell.column)]] = target_cell.model_copy(
                update={
                    "paragraphs": source_cell.paragraphs,
                    "style": source_cell.style,
                    "confidence": source_cell.confidence,
                    "asset": source_cell.asset,
                    "image_present": source_cell.image_present,
                }
            )
    return topology.model_copy(
        update={
            "cells": output,
            "caption": candidate.caption,
            "confidence": candidate.confidence,
        }
    )


def _table_row_bbox(table: Table, row: int) -> BBox:
    boundaries = sorted({value for cell in table.cells for value in (cell.bbox[1], cell.bbox[3])})
    return (table.bbox[0], boundaries[row], table.bbox[2], boundaries[row + 1])


def _local_text(bbox: BBox, supporting: list[Evidence]) -> str:
    candidate = _local_candidate("alignment", bbox, supporting)
    return candidate.text if candidate else ""


def _block_text_value(paragraphs: list[str]) -> str:
    return " ".join(" ".join(value.split()) for value in paragraphs).strip()


def _align_blocks(base: list[Block], candidate: list[Block]) -> dict[int, Block]:
    mapping = align_indices(
        len(candidate),
        len(base),
        lambda source, target: _block_alignment_score(candidate[source], base[target]),
        lambda _: -1.5,
        lambda _: -1.5,
    )
    return {target: candidate[source] for target, source in mapping.items()}


def _block_alignment_score(first: Block, second: Block) -> float:
    if isinstance(first, Table) != isinstance(second, Table):
        return -4.0
    score = 4.0 * _text_similarity(_block_text(first), _block_text(second)) - 1.0
    if isinstance(first, Table) and isinstance(second, Table) and _topology(first) == _topology(second):
        return score + 0.2
    if isinstance(first, TextBlock) and isinstance(second, TextBlock) and first.kind == second.kind:
        return score + 0.2
    return score


def _evidence_for_text(parent: Evidence, block: TextBlock, unit_id: str, bbox: BBox) -> Evidence:
    return CandidateEvidence(
        id=f"{parent.id}-{unit_id}",
        source=parent.source,
        source_family=parent.source_family,
        page_id=parent.page_id,
        unit_id=unit_id,
        text=_block_text(block),
        html="<p>" + std_html.escape("\n\n".join(block.paragraphs)) + "</p>",
        bbox=bbox,
        confidence=parent.confidence,
        valid=parent.valid,
        rejection_reasons=parent.rejection_reasons,
    )


def _evidence_for_table(parent: Evidence, table: Table, unit_id: str, bbox: BBox) -> Evidence:
    return CandidateEvidence(
        id=f"{parent.id}-{unit_id}",
        source=parent.source,
        source_family=parent.source_family,
        page_id=parent.page_id,
        unit_id=unit_id,
        text=_block_text(table),
        html="<table></table>",
        bbox=bbox,
        confidence=parent.confidence,
        valid=parent.valid,
        rejection_reasons=parent.rejection_reasons,
        metadata={"topology": _topology(table)},
    )


def _evidence_for_cell(parent: Evidence, cell: Cell, unit_id: str, bbox: BBox) -> Evidence:
    return CandidateEvidence(
        id=f"{parent.id}-{unit_id}",
        source=parent.source,
        source_family=parent.source_family,
        page_id=parent.page_id,
        unit_id=unit_id,
        text="\n\n".join(cell.paragraphs),
        html="<p>" + std_html.escape("\n\n".join(cell.paragraphs)) + "</p>",
        bbox=bbox,
        confidence=parent.confidence,
        valid=parent.valid,
        rejection_reasons=parent.rejection_reasons,
    )


def _retry_cell_values(candidates: list[Evidence], base: Cell) -> tuple[list[Evidence], dict[str, Cell]]:
    evidence = []
    values = {}
    for candidate in candidates:
        if not candidate.valid:
            evidence.append(candidate)
            continue
        blocks = blocks_from_html(candidate.html, f"{base.id}-retry", base.bbox, f"decision-{base.id}")
        cell = next(
            (item for block in blocks if isinstance(block, Table) for item in block.cells),
            None,
        )
        if cell is not None:
            cell = cell.model_copy(
                update={
                    "row": base.row,
                    "column": base.column,
                    "rowspan": base.rowspan,
                    "colspan": base.colspan,
                }
            )
        if cell is None:
            text = next((item for item in blocks if isinstance(item, TextBlock)), None)
            if text:
                cell = base.model_copy(update={"paragraphs": text.paragraphs})
        unit = _evidence_for_cell(candidate, cell or base, base.id, base.bbox)
        evidence.append(unit)
        values[unit.id] = cell or base
    return evidence, values


def _retry_table_values(
    candidates: list[Evidence],
    base: Table,
) -> tuple[list[Evidence], list[tuple[Evidence, Table]]]:
    evidence = []
    values = []
    for candidate in candidates:
        tables = (
            [
                block
                for block in blocks_from_html(
                    candidate.html,
                    f"{base.id}-retry",
                    base.bbox,
                    f"decision-{base.id}",
                    [base],
                )
                if isinstance(block, Table)
            ]
            if candidate.valid
            else []
        )
        table = tables[0] if tables else base
        unit = _evidence_for_table(candidate, table, base.id, base.bbox)
        if not tables:
            unit = unit.model_copy(
                update={
                    "valid": False,
                    "rejection_reasons": [*unit.rejection_reasons, "malformed_table_payload"],
                    "metadata": {"topology": ""},
                }
            )
        evidence.append(unit)
        values.append((candidate, table))
    return evidence, values


def _project_retry_table_values(
    values: tuple[list[Evidence], list[tuple[Evidence, Table]]],
    base: Table,
    supporting: list[Evidence],
) -> tuple[list[Evidence], list[tuple[Evidence, Table]]]:
    evidence = []
    tables = []
    for unit, (parent, table) in zip(*values, strict=True):
        if unit.valid:
            table = _project_table_values(table, base, supporting)
            unit = _evidence_for_table(parent, table, base.id, base.bbox)
        evidence.append(unit)
        tables.append((parent, table))
    return evidence, tables


def _matching_table_cells(
    base: Cell,
    tables: list[tuple[Evidence, Table]],
) -> list[tuple[Evidence, Cell]]:
    result = []
    location = (base.row, base.column, base.rowspan, base.colspan)
    for parent, table in tables:
        matching = next(
            (
                cell
                for cell in table.cells
                if (cell.row, cell.column, cell.rowspan, cell.colspan) == location and cell.confidence > 0
            ),
            None,
        )
        if matching:
            result.append((parent, matching))
    return result


def _table_content_retry_needed(
    base: Table,
    tables: list[tuple[Evidence, Table]],
    supporting: list[Evidence],
    adapter_count: int,
) -> bool:
    compatible = [(parent, table) for parent, table in tables if _topology(table) == _topology(base)]
    for cell in base.cells:
        if _empty_cell_supported(cell, supporting):
            continue
        values = _matching_table_cells(cell, compatible)
        candidates = [_evidence_for_cell(parent, value, cell.id, cell.bbox) for parent, value in values]
        selected, _ = reconcile(
            cell.id,
            candidates,
            _supporting_for_bbox(supporting, cell.bbox),
            cell.bbox,
        )
        locally_supported = _local_candidate(cell.id, cell.bbox, supporting) is not None
        if selected is None or _should_retry(candidates, adapter_count, locally_supported):
            return True
    return False


def _should_retry(
    candidates: list[Evidence],
    adapter_count: int,
    has_local_support: bool = False,
) -> bool:
    valid = [candidate for candidate in candidates if candidate.valid]
    families = {candidate.source_family for candidate in valid}
    return needs_retry(candidates) or (
        bool(valid) and len(families) + has_local_support < min(2, adapter_count)
    )


def _family_outputs_conflict(candidates: list[Evidence]) -> bool:
    values = {
        (candidate.source_family, " ".join(candidate.text.split()).casefold())
        for candidate in candidates
        if candidate.valid
    }
    families = {family for family, _ in values}
    texts = {text for _, text in values}
    return len(families) >= 2 and len(texts) > 1


def _unique_cross_family_consensus(
    selected: Evidence | None,
    candidates: list[Evidence],
    topology: bool = False,
) -> bool:
    if selected is None:
        return False

    def value(candidate: Evidence) -> str:
        raw = candidate.metadata.get("topology", "") if topology else candidate.text
        return " ".join(str(raw).split()).casefold()

    families_by_value: dict[str, set[str]] = {}
    for candidate in candidates:
        candidate_value = value(candidate)
        if not candidate.valid or not candidate_value:
            continue
        families_by_value.setdefault(candidate_value, set()).add(candidate.source_family)
    supported = {
        candidate_value for candidate_value, families in families_by_value.items() if len(families) >= 2
    }
    return supported == {value(selected)}


def _table_retry_needed(candidates: list[Evidence], adapter_count: int) -> bool:
    valid = [candidate for candidate in candidates if candidate.valid]
    topologies = {candidate.metadata.get("topology") for candidate in valid}
    families = {candidate.source_family for candidate in valid}
    return len(topologies) > 1 or (bool(valid) and len(families) < min(2, adapter_count))


def _table_family_conflict(candidates: list[Evidence]) -> bool:
    values = {
        (candidate.source_family, candidate.metadata.get("topology"))
        for candidate in candidates
        if candidate.valid
    }
    return len({family for family, _ in values}) >= 2 and len({topology for _, topology in values}) > 1


def _spatial_fallback_allowed(bbox: BBox, page_bbox: BBox, sibling_count: int) -> bool:
    return sibling_count <= 1 or _intersection_ratio(page_bbox, bbox) < UNSCOPED_UNIT_PAGE_COVERAGE


def _ambiguous_cell_ids(table: Table) -> set[str]:
    cells_by_bbox: dict[BBox, list[Cell]] = {}
    for cell in table.cells:
        cells_by_bbox.setdefault(cell.bbox, []).append(cell)
    return {cell.id for cells in cells_by_bbox.values() if len(cells) > 1 for cell in cells}


def _local_candidate(unit_id: str, bbox: BBox, supporting: list[Evidence]) -> Evidence | None:
    local = [
        item
        for item in _supporting_for_bbox(supporting, bbox)
        if item.source in {"embedded_pdf", "ppocr"} and item.text
    ]
    if not local:
        return None
    local.sort(key=lambda item: ((item.bbox or bbox)[1], (item.bbox or bbox)[0]))
    selected = []
    for item in local:
        if any(
            " ".join(item.text.split()).casefold() == " ".join(prior.text.split()).casefold()
            and item.bbox is not None
            and prior.bbox is not None
            and _intersection_ratio(item.bbox, prior.bbox) >= 0.5
            for prior in selected
        ):
            continue
        selected.append(item)
    text = "\n".join(item.text for item in selected)
    return CandidateEvidence(
        id=f"local-{unit_id}",
        source="local_evidence",
        source_family="local",
        page_id=selected[0].page_id,
        unit_id=unit_id,
        text=text,
        html="<p>" + std_html.escape(text) + "</p>",
        bbox=bbox,
        confidence=max(item.confidence for item in selected),
    )


def _expanded_text_bbox(
    bbox: BBox,
    supporting: list[Evidence],
    column_split: float | None = None,
) -> BBox:
    side = _column_side(bbox, column_split)
    candidates = [
        item.bbox
        for item in supporting
        if item.source in {"ppocr", "embedded_pdf"}
        and item.text
        and item.bbox is not None
        and _column_side(item.bbox, column_split) == side
    ]
    nearby = []
    for candidate in candidates:
        horizontal = max(0, min(bbox[2], candidate[2]) - max(bbox[0], candidate[0]))
        candidate_width = max(1, candidate[2] - candidate[0])
        gap = max(0, candidate[1] - bbox[3], bbox[1] - candidate[3])
        if horizontal / candidate_width >= 0.5 and gap <= max(16, (bbox[3] - bbox[1]) * 0.75):
            nearby.append(candidate)
    if not nearby:
        return bbox
    return (
        min(bbox[0], *(candidate[0] for candidate in nearby)),
        min(bbox[1], *(candidate[1] for candidate in nearby)),
        max(bbox[2], *(candidate[2] for candidate in nearby)),
        max(bbox[3], *(candidate[3] for candidate in nearby)),
    )


def _matching_text_bbox(
    block: TextBlock,
    supporting: list[Evidence],
    column_split: float | None = None,
) -> BBox | None:
    text = _block_text_value(block.paragraphs)
    if len(text) < 8:
        return None
    side = _column_side(block.bbox, column_split)
    candidates = [
        item
        for item in supporting
        if item.source in {"ppocr", "embedded_pdf"}
        and item.text
        and item.bbox is not None
        and _column_side(item.bbox, column_split) == side
    ]
    if not candidates:
        return None
    ordered = sorted(candidates, key=lambda item: (item.bbox[1], item.bbox[0]))
    matches = []
    for start in range(len(ordered)):
        for end in range(
            start + 1,
            min(len(ordered), start + TEXT_BBOX_MAX_OCR_LINES) + 1,
        ):
            values = ordered[start:end]
            combined = "\n".join(item.text for item in values)
            matches.append((_text_similarity(text, combined), len(values), values))
    score, _, selected = max(matches, key=lambda item: (item[0], item[1]))
    if score < 0.72:
        return None
    boxes = [item.bbox for item in selected if item.bbox is not None]
    return (
        min(bbox[0] for bbox in boxes),
        min(bbox[1] for bbox in boxes),
        max(bbox[2] for bbox in boxes),
        max(bbox[3] for bbox in boxes),
    )


def _column_side(bbox: BBox, column_split: float | None) -> int:
    if column_split is None:
        return 0
    return int((bbox[0] + bbox[2]) / 2 >= column_split)


def _column_split_from_evidence(supporting: list[Evidence], page_bbox: BBox) -> float | None:
    boxes = [
        item.bbox
        for item in supporting
        if item.source in {"ppocr", "embedded_pdf"} and item.text and item.bbox is not None
    ]
    return _column_split(boxes, page_bbox, minimum_group=3)


def _column_split(boxes: list[BBox], page_bbox: BBox, minimum_group: int) -> float | None:
    if len(boxes) < minimum_group * 2:
        return None
    centers = sorted((bbox[0] + bbox[2]) / 2 for bbox in boxes)
    overall_mean = sum(centers) / len(centers)
    overall_error = sum((value - overall_mean) ** 2 for value in centers)
    if overall_error == 0:
        return None
    best: tuple[float, int, float, float] | None = None
    for index in range(minimum_group, len(centers) - minimum_group + 1):
        left = centers[:index]
        right = centers[index:]
        left_mean = sum(left) / len(left)
        right_mean = sum(right) / len(right)
        error = sum((value - left_mean) ** 2 for value in left)
        error += sum((value - right_mean) ** 2 for value in right)
        candidate = (error, index, left_mean, right_mean)
        if best is None or candidate < best:
            best = candidate
    if best is None:
        return None
    error, index, left_mean, right_mean = best
    width = page_bbox[2] - page_bbox[0]
    if right_mean - left_mean < width * 0.3 or error > overall_error * 0.55:
        return None
    return (centers[index - 1] + centers[index]) / 2


def _collapse_aggregate_text_blocks(
    blocks: list[Block],
    page_bbox: BBox,
    column_split: float | None = None,
) -> tuple[list[Block], set[str]]:
    unique: list[Block] = []
    removed: set[str] = set()
    text_seen: dict[str, TextBlock] = {}
    for block in blocks:
        if not isinstance(block, TextBlock):
            unique.append(block)
            continue
        normalized = " ".join(_block_text(block).split()).casefold()
        if normalized and normalized in text_seen:
            removed.add(block.id)
            continue
        text_seen[normalized] = block
        unique.append(block)
    text_blocks = [block for block in unique if isinstance(block, TextBlock)]
    aggregates = {
        block.id
        for block in text_blocks
        if len(_block_text(block)) >= 400
        and sum(
            other.id != block.id
            and _intersection_ratio(other.bbox, block.bbox) >= 0.9
            and _bbox_area(other.bbox) < _bbox_area(block.bbox) * 0.5
            for other in text_blocks
        )
        >= 2
    }
    if aggregates:
        aggregate_blocks = [block for block in text_blocks if block.id in aggregates]
        for block in text_blocks:
            if block.id in aggregates:
                continue
            if any(_intersection_ratio(block.bbox, aggregate.bbox) >= 0.9 for aggregate in aggregate_blocks):
                removed.add(block.id)
        for block in unique:
            if not isinstance(block, Table) or not _ambiguous_table_geometry(block):
                continue
            if any(
                _intersection_ratio(aggregate.bbox, block.bbox) >= 0.9
                or _intersection_ratio(block.bbox, aggregate.bbox) >= 0.9
                for aggregate in aggregate_blocks
            ):
                removed.add(block.id)
        unique = [block for block in unique if block.id not in removed]
    return _order_blocks(unique, page_bbox, column_split), removed


def _bbox_area(bbox: BBox) -> int:
    return max(0, bbox[2] - bbox[0]) * max(0, bbox[3] - bbox[1])


def _ambiguous_table_geometry(table: Table) -> bool:
    return len(table.cells) > 1 and len({cell.bbox for cell in table.cells}) == 1


def _order_blocks(
    blocks: list[Block],
    page_bbox: BBox,
    column_split: float | None = None,
) -> list[Block]:
    if column_split is None:
        column_split = _column_split([block.bbox for block in blocks], page_bbox, minimum_group=1)
    ordered = sorted(
        blocks,
        key=lambda block: (
            _column_side(block.bbox, column_split),
            block.bbox[1],
            block.bbox[0],
            block.reading_order,
        ),
    )
    return [block.model_copy(update={"reading_order": index}) for index, block in enumerate(ordered)]


def _selected_is_grounded(
    selected: Evidence | None,
    bbox: BBox,
    supporting: list[Evidence],
) -> bool:
    local = _local_candidate("grounding", bbox, supporting)
    return selected is not None and local is not None and _text_similarity(selected.text, local.text) >= 0.95


def _empty_cell_supported(cell: Cell, supporting: list[Evidence]) -> bool:
    if _block_text_value(cell.paragraphs):
        return False
    geometry_supported = any(
        isinstance(item, CellEvidence)
        and item.source == "opencv"
        and item.bbox is not None
        and item.bbox[0] == cell.bbox[0]
        and item.bbox[2] == cell.bbox[2]
        and item.bbox[1] >= cell.bbox[1]
        and item.bbox[3] <= cell.bbox[3]
        for item in supporting
    )
    return geometry_supported or _local_candidate(cell.id, cell.bbox, supporting) is None


def _topology(table: Table) -> str:
    return ";".join(
        f"{cell.row},{cell.column},{cell.rowspan},{cell.colspan}"
        for cell in sorted(table.cells, key=lambda item: (item.row, item.column))
    )


def _normalize_table_sections(cells: list[Cell]) -> list[Cell]:
    header_open = True
    sections: dict[int, str] = {}
    for row in sorted({cell.row for cell in cells}):
        row_cells = [cell for cell in cells if cell.row == row]
        if not row_cells or not all(cell.section == "thead" for cell in row_cells):
            header_open = False
        sections[row] = "thead" if header_open else "tbody"
    return [cell.model_copy(update={"section": sections[cell.row]}) for cell in cells]


def _block_text(block: Block) -> str:
    if isinstance(block, Table):
        values = [block.caption or ""]
        values.extend(
            "\n\n".join(cell.paragraphs)
            for cell in sorted(block.cells, key=lambda item: (item.row, item.column))
        )
        return "\n".join(value for value in values if value)
    return "\n".join(block.paragraphs)


def _supporting_for_bbox(supporting: list[Evidence], bbox: BBox) -> list[Evidence]:
    return [
        item
        for item in supporting
        if item.bbox is None or _intersection_ratio(item.bbox, bbox) >= SUPPORTING_EVIDENCE_MIN_COVERAGE
    ]


def _intersection_ratio(first: BBox, second: BBox) -> float:
    left, top = max(first[0], second[0]), max(first[1], second[1])
    right, bottom = min(first[2], second[2]), min(first[3], second[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    area = (first[2] - first[0]) * (first[3] - first[1])
    return intersection / area if area else 0.0


def _attach_visual_assets(
    image: Image.Image,
    page_id: str,
    blocks: list[Block],
    regions: list[BBox],
) -> tuple[list[Block], dict[str, bytes], list[Decision], list[Evidence]]:
    regions = _deduplicate_boxes(regions)
    assets: dict[str, bytes] = {}
    available: list[AssetRef] = []
    evidence = []
    for index, bbox in enumerate(regions):
        output = io.BytesIO()
        image.crop(bbox).save(output, "PNG")
        asset, content = asset_for_crop(page_id, bbox, output.getvalue())
        available.append(asset)
        assets.update(content)
        evidence.append(
            RegionEvidence(
                id=f"visual-{page_id}-{index + 1}",
                source="local_visual",
                page_id=page_id,
                bbox=bbox,
                confidence=0.8,
                region_type="figure",
            )
        )
    used: set[int] = set()
    output_blocks = []
    decisions = []
    for block in blocks:
        if isinstance(block, TextBlock) and (block.kind == "figure" or block.image_present):
            match = _best_asset(block.bbox, available, used)
            if match is not None:
                used.add(match)
                block = block.model_copy(update={"asset": available[match]})
            elif block.image_present:
                decisions.append(_missing_visual_decision(block.id))
        elif isinstance(block, Table):
            cells = []
            for cell in block.cells:
                if cell.image_present:
                    match = _best_asset(cell.bbox, available, used)
                    if match is not None:
                        used.add(match)
                        cell = cell.model_copy(update={"asset": available[match]})
                    else:
                        decisions.append(_missing_visual_decision(cell.id))
                elif cell.asset is None:
                    match = _best_asset(cell.bbox, available, used, minimum_score=0.9)
                    if match is not None:
                        used.add(match)
                        cell = cell.model_copy(update={"asset": available[match]})
                cells.append(cell)
            block = block.model_copy(update={"cells": cells})
        output_blocks.append(block)
    for index, asset in enumerate(available):
        if index in used:
            continue
        unit_id = f"{page_id}-visual-{index + 1}"
        decision_id = f"decision-{unit_id}"
        output_blocks.append(
            TextBlock(
                kind="figure",
                id=unit_id,
                bbox=asset.bbox,
                reading_order=len(output_blocks),
                confidence=0.8,
                decision_id=decision_id,
                asset=asset,
            )
        )
        decisions.append(
            Decision(
                id=decision_id,
                unit_id=unit_id,
                selected_evidence_id=f"visual-{page_id}-{index + 1}",
                reason="local visual region evidence",
                hard_checks_passed=True,
            )
        )
    output_blocks.sort(key=lambda item: (item.bbox[1], item.bbox[0], item.reading_order))
    output_blocks = [
        block.model_copy(update={"reading_order": index}) for index, block in enumerate(output_blocks)
    ]
    return output_blocks, assets, decisions, evidence


def _missing_visual_decision(unit_id: str) -> Decision:
    return Decision(
        id=f"decision-{unit_id}-image-missing",
        unit_id=unit_id,
        reason="model marked an image but no source visual region was detected",
        unresolved=True,
        hard_checks_passed=False,
    )


def _best_asset(
    bbox: BBox,
    assets: list[AssetRef],
    used: set[int],
    minimum_score: float = 0.0,
) -> int | None:
    scores = [
        (_intersection_ratio(asset.bbox, bbox), index)
        for index, asset in enumerate(assets)
        if index not in used
    ]
    if not scores:
        return None
    score, index = max(scores)
    return index if score > minimum_score else None


def _deduplicate_boxes(boxes: list[BBox]) -> list[BBox]:
    result = []
    for box in boxes:
        if not any(
            _intersection_ratio(box, prior) >= 0.9 and _intersection_ratio(prior, box) >= 0.9
            for prior in result
        ):
            result.append(box)
    return result


def _page_artifact(page_id: str, raster: RasterPage) -> dict[str, bytes]:
    return {f"raw/pages/{page_id}-{raster.raster_sha256}.png": raster.png_bytes()}


def _clone_processed(value: ProcessedPage, page_id: str) -> ProcessedPage:
    old = value.page_id
    blocks = [_clone_block(block, old, page_id) for block in value.blocks]
    return ProcessedPage(
        page_id,
        blocks,
        [_clone_evidence(item, old, page_id) for item in value.evidence],
        [_clone_decision(item, old, page_id) for item in value.decisions],
        value.assets.copy(),
        {path.replace(f"/{old}-", f"/{page_id}-"): content for path, content in value.raw_artifacts.items()},
        value.failed,
        value.degraded_reasons.copy(),
    )


def _clone_block(block: Block, old: str, new: str) -> Block:
    if isinstance(block, TextBlock):
        asset = block.asset.model_copy(update={"page_id": new}) if block.asset else None
        return block.model_copy(
            update={
                "id": _replace_page(block.id, old, new),
                "decision_id": _replace_page(block.decision_id, old, new),
                "asset": asset,
            }
        )
    cells = []
    for cell in block.cells:
        asset = cell.asset.model_copy(update={"page_id": new}) if cell.asset else None
        cells.append(
            cell.model_copy(
                update={
                    "id": _replace_page(cell.id, old, new),
                    "decision_id": _replace_page(cell.decision_id, old, new),
                    "asset": asset,
                }
            )
        )
    return block.model_copy(
        update={
            "id": _replace_page(block.id, old, new),
            "decision_id": _replace_page(block.decision_id, old, new),
            "cells": cells,
        }
    )


def _clone_evidence(item: Evidence, old: str, new: str) -> Evidence:
    return item.model_copy(
        update={
            "id": _replace_page(item.id, old, new),
            "page_id": _replace_page(item.page_id, old, new),
            "unit_id": _replace_page(item.unit_id, old, new),
        }
    )


def _page_evidence(item: Evidence, page_id: str) -> Evidence:
    return item.model_copy(
        update={
            "id": f"{item.id}-{page_id}",
            "page_id": page_id,
        }
    )


def _clone_decision(item: Decision, old: str, new: str) -> Decision:
    data = item.model_dump(mode="json")
    data["id"] = _replace_page(data["id"], old, new)
    data["unit_id"] = _replace_page(data["unit_id"], old, new)
    data["selected_evidence_id"] = _replace_page(data["selected_evidence_id"], old, new)
    data["alternative_evidence_ids"] = [
        _replace_page(value, old, new) for value in data["alternative_evidence_ids"]
    ]
    for rank in data["ranks"]:
        rank["evidence_id"] = _replace_page(rank["evidence_id"], old, new)
    for retry in data["retries"]:
        retry["request_id"] = _replace_page(retry["request_id"], old, new)
        retry["candidate_ids"] = [_replace_page(value, old, new) for value in retry["candidate_ids"]]
    return Decision.model_validate(data)


def _replace_page(value: str | None, old: str, new: str) -> str | None:
    return value.replace(old, new) if value else value


def _markup_text(markup: str) -> str:
    try:
        root = html.fromstring(markup)
    except (ValueError, html.etree.ParserError):
        return ""
    return " ".join(part.strip() for part in root.itertext() if part.strip())
