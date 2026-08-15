from __future__ import annotations

import asyncio
import hashlib
import html as std_html
import inspect
import io
import json
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, TypeVar

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
    unreadable_block,
)
from .config import ExtractionConfig
from .geometry import GeometryResult, detect_geometry
from .ingest import RasterPage, crop_with_transform, ingest
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
from .reconcile import needs_retry, reconcile
from .render import render_html, render_markdown
from .sanitize import sanitize_candidate


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
    assets: dict[str, bytes] = field(default_factory=dict)
    raw_artifacts: dict[str, bytes] = field(default_factory=dict)
    failed: bool = False
    degraded_reasons: list[str] = field(default_factory=list)


T = TypeVar("T", TextBlock, Cell)


class Extractor:
    def __init__(self, config: ExtractionConfig, adapters: list[ModelAdapter] | None = None) -> None:
        self.config = config
        self.adapters = adapters or [
            NuExtract3Adapter(config.nu_extract, config.endpoint_concurrency),
            GemmaAdapter(config.gemma, config.endpoint_concurrency),
        ]
        self.ocr = PaddleEvidenceProvider(config.enable_paddle, config.paddle_languages)
        self._request_artifacts: dict[str, bytes] = {}
        self._single_spark_queue = asyncio.Semaphore(1) if config.hardware_profile == "single_spark" else None

    async def extract(
        self,
        inputs: list[str | Path],
        manifest: str | Path | dict[str, Any] | None = None,
    ) -> ExtractionResult:
        self._request_artifacts = {}
        ordered_inputs, input_names, metadata = _resolve_inputs(inputs, manifest)
        try:
            raster_pages = ingest(ordered_inputs, self.config.pdf_dpi)
        except Exception as error:
            return self._failed_ingestion(input_names, str(error))
        document_id = _document_id(raster_pages)
        unique: dict[str, tuple[str, RasterPage]] = {}
        for index, raster in enumerate(raster_pages):
            unique.setdefault(raster.raster_sha256, (f"p{index + 1}", raster))
        processed_values = await asyncio.gather(
            *(self._process_page(raster, page_id) for page_id, raster in unique.values())
        )
        processed_by_hash = dict(zip(unique, processed_values, strict=True))
        pages: list[Page] = []
        all_evidence: list[Evidence] = []
        decisions: list[Decision] = []
        assets: dict[str, bytes] = {}
        raw_artifacts: dict[str, bytes] = {}
        degraded_reasons: list[str] = []
        failed_pages = 0
        for index, raster in enumerate(raster_pages):
            page_id = f"p{index + 1}"
            original = processed_by_hash[raster.raster_sha256]
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
        unresolved = sum(decision.unresolved for decision in decisions)
        hard_failures = sum(not decision.hard_checks_passed for decision in decisions)
        if failed_pages == len(pages):
            status = Status.FAILED
        elif degraded_reasons or unresolved or hard_failures:
            status = Status.DEGRADED
        else:
            status = Status.ACCEPTED
        document = Document(id=document_id, pages=pages)
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
                source_hashes=[hashlib.sha256(path.read_bytes()).hexdigest() for path in ordered_inputs],
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

    async def _process_page(self, raster: RasterPage, page_id: str) -> ProcessedPage:
        geometry = detect_geometry(raster.image, page_id)
        try:
            paddle = self.ocr.extract_all(raster.image, page_id)
        except RuntimeError as error:
            paddle = None
            paddle_error = Evidence(
                id=f"paddle-error-{page_id}",
                source="paddle",
                page_id=page_id,
                valid=False,
                rejection_reasons=[str(error)[:160]],
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
            )
            evidence.extend(unit_evidence)
            if decisions and not any(decision.hard_checks_passed for decision in decisions):
                block, assets = unreadable_block(page_id, page_bbox, raster.png_bytes())
                block = block.model_copy(update={"decision_id": f"decision-{page_id}-unreadable"})
                decisions.append(
                    Decision(
                        id=f"decision-{page_id}-unreadable",
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
            prompt_version="crop-conflict-v1" if retry else "semantic-html-v1",
            image_png=image_png,
            retry=retry,
        )
        values = await asyncio.gather(
            *(self._call_adapter(adapter, request, image) for adapter in self.adapters)
        )
        return values

    def _crop_artifacts(self, page_id: str) -> dict[str, bytes]:
        return {
            path: content
            for path, content in self._request_artifacts.items()
            if PurePosixPath(path).name.startswith(f"{page_id}-")
        }

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
            valid=value.valid and not reasons and bool(text.strip()),
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
    ) -> tuple[list[Block], list[Evidence], list[Decision]]:
        base = max(
            candidates,
            key=lambda item: (
                len(item.blocks),
                sum(isinstance(block, Table) for block in item.blocks),
                item.evidence.source == "nuextract3",
            ),
        )
        alignments = {item.evidence.id: _align_blocks(base.blocks, item.blocks) for item in candidates}
        output: list[Block] = []
        evidence: list[Evidence] = []
        decisions: list[Decision] = []
        for order, base_block in enumerate(base.blocks):
            aligned = [
                (item.evidence, alignments[item.evidence.id].get(order))
                for item in candidates
                if alignments[item.evidence.id].get(order) is not None
            ]
            if isinstance(base_block, Table):
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
                block, block_evidence, decision = await self._select_text_block(
                    raster,
                    page_id,
                    base_block,
                    text_values,
                    supporting,
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
    ) -> tuple[TextBlock, list[Evidence], Decision]:
        unit_id = base.id
        candidates = [_evidence_for_text(parent, block, unit_id, base.bbox) for parent, block in values]
        by_id = {candidate.id: block for candidate, (_, block) in zip(candidates, values, strict=True)}
        selected, decision = reconcile(
            unit_id, candidates, _supporting_for_bbox(supporting, base.bbox), base.bbox
        )
        retry_record = None
        if _should_retry(candidates, len(self.adapters)):
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
            if _family_outputs_conflict(retry):
                decision.unresolved = True
                decision.reason += "; conflict persisted after retry"
        if selected is None:
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
        return candidates, result

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
        selected, table_decision = reconcile(
            base.id,
            table_candidates,
            _supporting_for_bbox(supporting, base.bbox),
            base.bbox,
            topology,
        )
        retry_record = None
        if _table_retry_needed(table_candidates, len(self.adapters)):
            retry_candidates = await self._request_candidates(raster, page_id, base.id, base.bbox, retry=True)
            retry_tables = _retry_table_values(retry_candidates, base)
            tables.extend(retry_tables[1])
            table_candidates.extend(retry_tables[0])
            selected, table_decision = reconcile(
                base.id,
                table_candidates,
                _supporting_for_bbox(supporting, base.bbox),
                base.bbox,
                topology,
            )
            retry_record = RetryRecord(
                request_id=f"{base.id}-retry",
                bbox=base.bbox,
                candidate_ids=[item.id for item in retry_tables[0]],
                reason="conflicting complete table topology candidates",
            )
        if retry_record:
            table_decision.retries.append(retry_record)
            if _table_family_conflict(retry_tables[0]):
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
        compatible = [(parent, table) for parent, table in tables if _topology(table) == topology]
        for cell in sorted(base.cells, key=lambda item: (item.row, item.column)):
            candidates_with_cells = []
            for parent, table in compatible:
                matching = next(
                    (
                        item
                        for item in table.cells
                        if (item.row, item.column, item.rowspan, item.colspan)
                        == (cell.row, cell.column, cell.rowspan, cell.colspan)
                    ),
                    None,
                )
                if matching:
                    candidates_with_cells.append((parent, matching))
            chosen, cell_evidence, decision = await self._select_cell(
                raster,
                page_id,
                cell,
                candidates_with_cells,
                supporting,
            )
            cells.append(chosen)
            evidence.extend(cell_evidence)
            decisions.append(decision)
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
    ) -> tuple[Cell, list[Evidence], Decision]:
        candidates = [_evidence_for_cell(parent, cell, base.id, base.bbox) for parent, cell in values]
        by_id = {candidate.id: cell for candidate, (_, cell) in zip(candidates, values, strict=True)}
        selected, decision = reconcile(
            base.id, candidates, _supporting_for_bbox(supporting, base.bbox), base.bbox
        )
        retry_record = None
        if _should_retry(candidates, len(self.adapters)):
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
            if _family_outputs_conflict(retry_cells[0]):
                decision.unresolved = True
                decision.reason += "; conflict persisted after retry"
        if selected is None:
            local = _local_candidate(base.id, base.bbox, supporting)
            if local:
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
        if retry_record:
            decision.retries.append(retry_record)
        if len({candidate.source_family for candidate in candidates if candidate.valid}) < 2:
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


def _document_id(pages: list[RasterPage]) -> str:
    value = "|".join(f"{page.raster_sha256}:{page.instance}" for page in pages).encode()
    return f"doc-{hashlib.sha256(value).hexdigest()[:16]}"


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
        valid=not reasons,
        rejection_reasons=reasons,
    )


def _align_blocks(base: list[Block], candidate: list[Block]) -> dict[int, Block]:
    mapping: dict[int, Block] = {}
    position = 0
    for base_index, block in enumerate(base):
        compatible = [
            (index, value)
            for index, value in enumerate(candidate[position:], start=position)
            if isinstance(value, Table) == isinstance(block, Table)
        ]
        if not compatible:
            continue
        index, selected = max(
            compatible[:3],
            key=lambda item: _block_similarity(block, item[1]),
        )
        mapping[base_index] = selected
        position = index + 1
    return mapping


def _block_similarity(first: Block, second: Block) -> tuple[int, float]:
    if isinstance(first, Table) and isinstance(second, Table):
        return (
            _topology(first) == _topology(second),
            _text_similarity(_block_text(first), _block_text(second)),
        )
    if isinstance(first, TextBlock) and isinstance(second, TextBlock):
        return (first.kind == second.kind, _text_similarity(_block_text(first), _block_text(second)))
    return (0, 0.0)


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


def _should_retry(candidates: list[Evidence], adapter_count: int) -> bool:
    valid = [candidate for candidate in candidates if candidate.valid]
    families = {candidate.source_family for candidate in valid}
    return needs_retry(candidates) or (bool(valid) and len(families) < min(2, adapter_count))


def _family_outputs_conflict(candidates: list[Evidence]) -> bool:
    values = {
        (candidate.source_family, " ".join(candidate.text.split()).casefold())
        for candidate in candidates
        if candidate.valid
    }
    families = {family for family, _ in values}
    texts = {text for _, text in values}
    return len(families) >= 2 and len(texts) > 1


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


def _topology(table: Table) -> str:
    return ";".join(
        f"{cell.row},{cell.column},{cell.rowspan},{cell.colspan}"
        for cell in sorted(table.cells, key=lambda item: (item.row, item.column))
    )


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
    return [item for item in supporting if item.bbox is None or _intersection_ratio(item.bbox, bbox) > 0]


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


def _best_asset(bbox: BBox, assets: list[AssetRef], used: set[int]) -> int | None:
    scores = [
        (_intersection_ratio(asset.bbox, bbox), index)
        for index, asset in enumerate(assets)
        if index not in used
    ]
    if not scores:
        return None
    score, index = max(scores)
    return index if score > 0 else None


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


def _text_similarity(first: str, second: str) -> float:
    from difflib import SequenceMatcher

    return SequenceMatcher(
        None, " ".join(first.split()).casefold(), " ".join(second.split()).casefold()
    ).ratio()
