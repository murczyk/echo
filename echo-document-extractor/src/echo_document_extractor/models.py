from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal, TypeAlias

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    SerializeAsAny,
    field_validator,
    model_validator,
)


def _valid_bbox(value: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    left, top, right, bottom = value
    if min(value) < 0 or right <= left or bottom <= top:
        raise ValueError("bounding boxes must have non-negative coordinates and positive area")
    return value


BBox = Annotated[tuple[int, int, int, int], AfterValidator(_valid_bbox)]
Confidence = Annotated[float, Field(ge=0.0, le=1.0)]
SafeId = Annotated[str, Field(min_length=1, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")]


def safe_relative_path(value: str, prefix: str | None = None) -> str:
    if not value or "\\" in value:
        raise ValueError("path must be a non-empty POSIX relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("unsafe relative path")
    if prefix and (not path.parts or path.parts[0] != prefix):
        raise ValueError(f"path must be below {prefix}/")
    return path.as_posix()


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Status(str, Enum):
    ACCEPTED = "accepted"
    DEGRADED = "degraded"
    FAILED = "failed"


class SourceTransform(StrictModel):
    """Affine transform from evidence coordinates into source raster pixels."""

    scale_x: float = Field(default=1.0, gt=0)
    scale_y: float = Field(default=1.0, gt=0)
    offset_x: float = 0.0
    offset_y: float = 0.0
    rotation_degrees: float = Field(default=0.0, ge=-180, le=180)


class AssetRef(StrictModel):
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    path: str
    mime_type: Literal["image/png"] = "image/png"
    bbox: BBox
    page_id: SafeId

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        return safe_relative_path(value, "assets")


EvidenceKind = Literal[
    "page",
    "region",
    "table",
    "cell",
    "ocr_token",
    "topology",
    "candidate",
]


class Evidence(StrictModel):
    """Typed evidence record kept for compatibility with the original API."""

    id: SafeId
    kind: EvidenceKind = "candidate"
    source: str = Field(min_length=1)
    source_family: str | None = None
    page_id: SafeId | None = None
    unit_id: SafeId | None = None
    text: str = ""
    html: str = ""
    bbox: BBox | None = None
    confidence: Confidence = 0.0
    transform: SourceTransform = Field(default_factory=SourceTransform)
    valid: bool = True
    rejection_reasons: list[str] = Field(default_factory=list)
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)

    @model_validator(mode="after")
    def normalize_family(self) -> Evidence:
        if self.source_family is None:
            self.source_family = {
                "nuextract3": "nuextract",
                "numarkdown": "nuextract",
                "gemma": "gemma",
                "ppocr": "paddle",
                "ppstructure": "paddle",
            }.get(self.source, self.source)
        return self


class PageEvidence(Evidence):
    kind: Literal["page"] = "page"
    page_id: SafeId
    bbox: BBox


class RegionEvidence(Evidence):
    kind: Literal["region"] = "region"
    page_id: SafeId
    bbox: BBox
    region_type: Literal["text", "title", "list", "table", "figure", "photo", "map", "diagram"]


class TableEvidence(Evidence):
    kind: Literal["table"] = "table"
    page_id: SafeId
    unit_id: SafeId
    bbox: BBox
    rows: int = Field(ge=0)
    columns: int = Field(ge=0)


class CellEvidence(Evidence):
    kind: Literal["cell"] = "cell"
    page_id: SafeId
    unit_id: SafeId
    bbox: BBox
    row: int = Field(ge=0)
    column: int = Field(ge=0)
    rowspan: int = Field(default=1, ge=1, le=10_000)
    colspan: int = Field(default=1, ge=1, le=10_000)


class OcrTokenEvidence(Evidence):
    kind: Literal["ocr_token"] = "ocr_token"
    page_id: SafeId
    bbox: BBox
    language: Literal["ru", "uk", "en"]


class TopologyEvidence(Evidence):
    kind: Literal["topology"] = "topology"
    page_id: SafeId
    unit_id: SafeId
    bbox: BBox
    row_boundaries: list[int] = Field(default_factory=list)
    column_boundaries: list[int] = Field(default_factory=list)

    @field_validator("row_boundaries", "column_boundaries")
    @classmethod
    def ordered_boundaries(cls, value: list[int]) -> list[int]:
        if value != sorted(set(value)) or any(item < 0 for item in value):
            raise ValueError("topology boundaries must be sorted, unique, and non-negative")
        return value


class CandidateEvidence(Evidence):
    kind: Literal["candidate"] = "candidate"
    page_id: SafeId
    unit_id: SafeId
    bbox: BBox


EvidenceRecord: TypeAlias = (
    PageEvidence
    | RegionEvidence
    | TableEvidence
    | CellEvidence
    | OcrTokenEvidence
    | TopologyEvidence
    | CandidateEvidence
    | Evidence
)


class ValidatorRecord(StrictModel):
    name: str
    passed: bool
    score: float = Field(default=0.0, ge=0.0, le=1.0)
    details: str = ""


class RankFactors(StrictModel):
    hard_checks: int = Field(ge=0)
    geometry_compatibility: float = Field(ge=0.0, le=1.0)
    critical_numeric_support: float = Field(ge=-1.0, le=1.0)
    independent_family_agreement: int = Field(ge=0)
    ocr_similarity: float = Field(ge=0.0)
    peer_median_similarity: float = Field(ge=0.0, le=1.0)
    nuextract3_tiebreaker: bool

    def tuple(self) -> tuple[int, float, float, int, float, float, bool]:
        return (
            self.hard_checks,
            self.geometry_compatibility,
            self.critical_numeric_support,
            self.independent_family_agreement,
            self.ocr_similarity,
            self.peer_median_similarity,
            self.nuextract3_tiebreaker,
        )


class CandidateRank(StrictModel):
    evidence_id: SafeId
    factors: RankFactors
    validators: list[ValidatorRecord] = Field(default_factory=list)
    rejected: bool = False


class RetryRecord(StrictModel):
    request_id: SafeId
    bbox: BBox
    candidate_ids: list[SafeId] = Field(default_factory=list)
    reason: str


class Decision(StrictModel):
    id: SafeId
    unit_id: SafeId
    selected_evidence_id: SafeId | None = None
    alternative_evidence_ids: list[SafeId] = Field(default_factory=list)
    reason: str
    unresolved: bool = False
    hard_checks_passed: bool = False
    ranks: list[CandidateRank] = Field(default_factory=list)
    validators: list[ValidatorRecord] = Field(default_factory=list)
    retries: list[RetryRecord] = Field(default_factory=list)


class CellStyle(StrictModel):
    bold: bool = False
    italic: bool = False
    alignment: Literal["left", "center", "right", "top", "middle", "bottom"] = "top"
    font_color: str | None = Field(default=None, pattern=r"^#?[0-9A-Fa-f]{6}$")
    fill: str | None = Field(default=None, pattern=r"^#?[0-9A-Fa-f]{6}$")

    @field_validator("font_color", "fill")
    @classmethod
    def normalize_color(cls, value: str | None) -> str | None:
        return f"#{value.lstrip('#').upper()}" if value else None


class Cell(StrictModel):
    id: SafeId
    row: int = Field(ge=0)
    column: int = Field(ge=0)
    rowspan: int = Field(default=1, ge=1, le=10_000)
    colspan: int = Field(default=1, ge=1, le=10_000)
    bbox: BBox
    paragraphs: list[str] = Field(default_factory=list)
    is_header: bool = False
    section: Literal["thead", "tbody"] = "tbody"
    style: CellStyle = Field(default_factory=CellStyle)
    confidence: Confidence = 0.0
    decision_id: SafeId | None = None
    asset: AssetRef | None = None
    image_present: bool = Field(default=False, exclude=True)


class Table(StrictModel):
    id: SafeId
    bbox: BBox
    reading_order: int = Field(ge=0)
    cells: list[Cell] = Field(default_factory=list)
    caption: str | None = None
    continuation_key: str | None = None
    column_boundaries: list[int] = Field(default_factory=list)
    confidence: Confidence = 0.0
    decision_id: SafeId | None = None

    @model_validator(mode="after")
    def validate_topology(self) -> Table:
        occupied: set[tuple[int, int]] = set()
        for cell in self.cells:
            if cell.rowspan * cell.colspan > 10_000:
                raise ValueError("table cell span is unreasonably large")
            positions = {
                (row, column)
                for row in range(cell.row, cell.row + cell.rowspan)
                for column in range(cell.column, cell.column + cell.colspan)
            }
            if occupied & positions:
                raise ValueError("table cells overlap")
            occupied |= positions
            if (
                cell.bbox[0] < self.bbox[0]
                or cell.bbox[1] < self.bbox[1]
                or cell.bbox[2] > self.bbox[2]
                or cell.bbox[3] > self.bbox[3]
            ):
                raise ValueError(f"{cell.id} bounding box exceeds its table")
        if occupied:
            rows = max(row for row, _ in occupied) + 1
            columns = max(column for _, column in occupied) + 1
            if len(occupied) != rows * columns:
                raise ValueError("table topology contains unrepresented empty cells")
        if self.column_boundaries != sorted(set(self.column_boundaries)):
            raise ValueError("column boundaries must be sorted and unique")
        if self.column_boundaries and (
            self.column_boundaries[0] < self.bbox[0] or self.column_boundaries[-1] > self.bbox[2]
        ):
            raise ValueError("column boundaries exceed table bounding box")
        return self


class TextBlock(StrictModel):
    kind: Literal["paragraph", "heading", "list", "figure", "unreadable"]
    id: SafeId
    bbox: BBox
    reading_order: int = Field(ge=0)
    paragraphs: list[str] = Field(default_factory=list)
    level: int | None = Field(default=None, ge=1, le=6)
    list_ordered: bool = False
    confidence: Confidence = 0.0
    decision_id: SafeId | None = None
    asset: AssetRef | None = None
    image_present: bool = Field(default=False, exclude=True)

    @model_validator(mode="after")
    def validate_kind_fields(self) -> TextBlock:
        if self.kind == "heading" and self.level is None:
            raise ValueError("heading level is required")
        if self.kind != "heading" and self.level is not None:
            raise ValueError("heading level is only valid for headings")
        return self


Block: TypeAlias = TextBlock | Table


class Page(StrictModel):
    id: SafeId
    source_name: str = Field(min_length=1)
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    raster_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    instance: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    rotation_degrees: int = Field(default=0)
    blocks: list[Block] = Field(default_factory=list)
    embedded_pdf_evidence: list[Evidence] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_page_relationships(self) -> Page:
        ids = [block.id for block in self.blocks]
        ids.extend(cell.id for block in self.blocks if isinstance(block, Table) for cell in block.cells)
        if len(ids) != len(set(ids)):
            raise ValueError("page block and cell IDs must be unique")
        for block in self.blocks:
            if block.bbox[2] > self.width or block.bbox[3] > self.height:
                raise ValueError(f"{block.id} bounding box exceeds page")
            assets = (
                [block.asset]
                if isinstance(block, TextBlock)
                else [cell.asset for cell in block.cells if cell.asset]
            )
            for asset in assets:
                if asset and (
                    asset.page_id != self.id or asset.bbox[2] > self.width or asset.bbox[3] > self.height
                ):
                    raise ValueError(f"{block.id} asset relationship exceeds page")
        return self


class Document(StrictModel):
    id: SafeId
    pages: list[Page]

    @model_validator(mode="after")
    def validate_pages(self) -> Document:
        if [page.instance for page in self.pages] != list(range(len(self.pages))):
            raise ValueError("page instances must be consecutive and ordered")
        if len({page.id for page in self.pages}) != len(self.pages):
            raise ValueError("page IDs must be unique")
        return self


class QualityReport(StrictModel):
    schema_version: Literal[1] = 1
    status: Status
    page_count: int = Field(ge=0)
    accepted_units: int = Field(default=0, ge=0)
    unresolved_decisions: int = Field(default=0, ge=0)
    unreadable_pages: int = Field(default=0, ge=0)
    hard_check_failures: int = Field(default=0, ge=0)
    degraded_reasons: list[str] = Field(default_factory=list)


class PackageModel(StrictModel):
    id: str
    revision: str
    prompt_version: str


class PackageManifest(StrictModel):
    schema_version: Literal[1] = 1
    document_id: SafeId
    status: Status
    inputs: list[str]
    source_hashes: list[str] = Field(default_factory=list)
    raster_hashes: list[str] = Field(default_factory=list)
    hardware_profile: Literal["split_gpu", "single_spark"]
    models: list[PackageModel] = Field(default_factory=list)
    metadata: dict[str, str | int | float | bool | None] = Field(default_factory=dict)
    file_hashes: dict[str, str] = Field(default_factory=dict)

    @field_validator("inputs")
    @classmethod
    def relative_inputs(cls, values: list[str]) -> list[str]:
        return [safe_relative_path(value) for value in values]

    @field_validator("source_hashes", "raster_hashes")
    @classmethod
    def valid_hashes(cls, values: list[str]) -> list[str]:
        if any(not re.fullmatch(r"[0-9a-f]{64}", value) for value in values):
            raise ValueError("source and raster hashes must be SHA-256 values")
        return values

    @field_validator("file_hashes")
    @classmethod
    def valid_file_hashes(cls, values: dict[str, str]) -> dict[str, str]:
        for path, digest in values.items():
            safe_relative_path(path)
            if not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise ValueError("package file hashes must be SHA-256 values")
        return values


class ExtractionResult(StrictModel):
    document: Document
    status: Status
    evidence: list[SerializeAsAny[Evidence]] = Field(default_factory=list)
    decisions: list[Decision] = Field(default_factory=list)
    canonical_html: str
    markdown: str
    quality: QualityReport
    manifest: PackageManifest
    assets: dict[str, bytes] = Field(default_factory=dict, exclude=True)
    raw_artifacts: dict[str, bytes] = Field(default_factory=dict, exclude=True)

    @field_validator("assets")
    @classmethod
    def validate_assets(cls, value: dict[str, bytes]) -> dict[str, bytes]:
        for path, content in value.items():
            safe_relative_path(path, "assets")
            if hashlib.sha256(content).hexdigest() != PurePosixPath(path).stem:
                raise ValueError(f"asset hash does not match path: {path}")
        return value

    @field_validator("raw_artifacts")
    @classmethod
    def validate_raw_artifacts(cls, value: dict[str, bytes]) -> dict[str, bytes]:
        for path in value:
            safe_relative_path(path, "raw")
        return value

    def write_package(self, path: str | Path) -> None:
        """Atomically write into a new or empty private directory."""
        from .render import write_xlsx

        output = Path(path)
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.exists() and (not output.is_dir() or any(output.iterdir())):
            raise ValueError("output directory must be new or empty")
        staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.tmp-", dir=output.parent))
        try:
            os.chmod(staging, 0o700)
            self._write_text(staging / "document.html", self.canonical_html)
            self._write_text(staging / "document.md", self.markdown)
            self._write_json(
                staging / "provenance.json",
                {
                    "schema_version": 1,
                    "evidence": [item.model_dump(mode="json") for item in self.evidence],
                    "decisions": [item.model_dump(mode="json") for item in self.decisions],
                },
            )
            self._write_json(staging / "quality.json", self.quality.model_dump(mode="json"))
            for relative, content in {**self.assets, **self.raw_artifacts}.items():
                target = self._safe_target(staging, relative)
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                target.write_bytes(content)
                os.chmod(target, 0o600)
            (staging / "assets").mkdir(mode=0o700, exist_ok=True)
            (staging / "raw").mkdir(mode=0o700, exist_ok=True)
            if any(isinstance(block, Table) for page in self.document.pages for block in page.blocks):
                write_xlsx(self, staging / "document.xlsx")
                os.chmod(staging / "document.xlsx", 0o600)
            self.manifest.file_hashes = {
                item.relative_to(staging).as_posix(): hashlib.sha256(item.read_bytes()).hexdigest()
                for item in staging.rglob("*")
                if item.is_file()
            }
            self._write_json(staging / "manifest.json", self.manifest.model_dump(mode="json"))
            for directory in [staging, *[item for item in staging.rglob("*") if item.is_dir()]]:
                os.chmod(directory, 0o700)
            if output.exists():
                output.rmdir()
            os.replace(staging, output)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    @staticmethod
    def _safe_target(root: Path, relative: str) -> Path:
        relative = safe_relative_path(relative)
        target = root.joinpath(*PurePosixPath(relative).parts)
        if root.resolve() not in target.resolve().parents:
            raise ValueError(f"unsafe package path: {relative}")
        return target

    @staticmethod
    def _write_text(path: Path, value: str) -> None:
        path.write_text(value.rstrip() + "\n", encoding="utf-8")
        os.chmod(path, 0o600)

    @classmethod
    def _write_json(cls, path: Path, value: object) -> None:
        cls._write_text(path, json.dumps(value, ensure_ascii=False, indent=2))


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def is_sha256(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-f]{64}", value))
