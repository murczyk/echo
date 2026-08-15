from __future__ import annotations

import hashlib
import json
import os
import re
from collections import Counter
from pathlib import Path, PurePosixPath

from lxml import html
from openpyxl import load_workbook
from pydantic import TypeAdapter, ValidationError

from .canonical import parse_canonical_html, table_dimensions
from .models import Decision, EvidenceRecord, PackageManifest, QualityReport, Table, safe_relative_path


def validate_package(path: str | Path) -> list[str]:
    package = Path(path)
    errors = []
    required = ["document.html", "document.md", "provenance.json", "quality.json", "manifest.json"]
    errors.extend(f"missing {name}" for name in required if not (package / name).is_file())
    if errors:
        return errors
    document = None
    try:
        document = parse_canonical_html((package / "document.html").read_text(encoding="utf-8"))
    except Exception as error:
        errors.append(f"invalid document.html: {error}")
    provenance, quality, manifest = _load_models(package, errors)
    if document is not None:
        _validate_relationships(document, provenance, errors)
        _validate_assets(package, document, errors)
        _validate_projections(package, document, errors)
        if any(isinstance(block, Table) for page in document.pages for block in page.blocks):
            if not (package / "document.xlsx").is_file():
                errors.append("document.xlsx missing for table document")
            else:
                _validate_xlsx(package / "document.xlsx", document, errors)
        elif (package / "document.xlsx").exists():
            errors.append("stale document.xlsx exists for table-free document")
    if quality is not None and document is not None and quality.page_count != len(document.pages):
        errors.append("quality page_count does not match canonical document")
    try:
        canonical_root = html.fromstring((package / "document.html").read_text(encoding="utf-8"))
        if canonical_root.tag != "article":
            canonical_root = canonical_root.xpath("//article")[0]
        status = canonical_root.get("data-status")
        if quality is not None and status != quality.status.value:
            errors.append("quality status does not match canonical document")
        if manifest is not None and status != manifest.status.value:
            errors.append("manifest status does not match canonical document")
    except (IndexError, ValueError):
        pass
    if manifest is not None:
        _validate_hashes(package, manifest, errors)
        if document is not None and manifest.document_id != document.id:
            errors.append("manifest document_id does not match canonical document")
        if manifest.status.value != "failed" and len(manifest.source_hashes) != len(manifest.inputs):
            errors.append("manifest source hashes do not correspond to inputs")
        if document is not None and manifest.raster_hashes != [page.raster_sha256 for page in document.pages]:
            errors.append("manifest raster hashes do not match canonical pages")
        if document is not None and any(
            page.source_sha256 not in manifest.source_hashes for page in document.pages
        ):
            errors.append("canonical page source hash is absent from manifest")
    _validate_permissions(package, errors)
    return sorted(set(errors))


def _load_models(
    package: Path,
    errors: list[str],
) -> tuple[dict[str, object] | None, QualityReport | None, PackageManifest | None]:
    values: dict[str, object] = {}
    for name in ("provenance.json", "quality.json", "manifest.json"):
        try:
            values[name] = json.loads((package / name).read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            errors.append(f"invalid {name}: {error}")
    provenance = values.get("provenance.json")
    if not isinstance(provenance, dict):
        if provenance is not None:
            errors.append("provenance.json must be an object")
        provenance = None
    elif provenance.get("schema_version") != 1:
        errors.append("unsupported provenance schema_version")
    else:
        try:
            TypeAdapter(list[EvidenceRecord]).validate_python(provenance.get("evidence", []))
            TypeAdapter(list[Decision]).validate_python(provenance.get("decisions", []))
        except ValidationError as error:
            errors.append(f"invalid provenance records: {error.errors()[0]['msg']}")
    try:
        quality = QualityReport.model_validate(values["quality.json"]) if "quality.json" in values else None
    except ValidationError as error:
        errors.append(f"invalid quality.json: {error.errors()[0]['msg']}")
        quality = None
    try:
        manifest = (
            PackageManifest.model_validate(values["manifest.json"]) if "manifest.json" in values else None
        )
    except ValidationError as error:
        errors.append(f"invalid manifest.json: {error.errors()[0]['msg']}")
        manifest = None
    return provenance, quality, manifest


def _validate_relationships(
    document: object,
    provenance: dict[str, object] | None,
    errors: list[str],
) -> None:
    units = []
    decision_refs = []
    page_sizes = {page.id: (page.width, page.height) for page in document.pages}
    for page in document.pages:
        for block in page.blocks:
            units.append(block.id)
            if block.decision_id:
                decision_refs.append((block.id, block.decision_id))
            else:
                errors.append(f"{block.id} lacks a decision relationship")
            if isinstance(block, Table):
                for cell in block.cells:
                    units.append(cell.id)
                    if cell.decision_id:
                        decision_refs.append((cell.id, cell.decision_id))
                    else:
                        errors.append(f"{cell.id} lacks a decision relationship")
    if len(units) != len(set(units)):
        errors.append("duplicate canonical IDs")
    if provenance is None:
        return
    evidence = provenance.get("evidence", [])
    decisions = provenance.get("decisions", [])
    evidence_ids = [item.get("id") for item in evidence if isinstance(item, dict)]
    decision_ids = [item.get("id") for item in decisions if isinstance(item, dict)]
    if len(evidence_ids) != len(set(evidence_ids)):
        errors.append("duplicate evidence IDs")
    if len(decision_ids) != len(set(decision_ids)):
        errors.append("duplicate decision IDs")
    known_evidence = set(evidence_ids)
    known_decisions = set(decision_ids)
    known_units = set(units)
    for unit_id, decision_id in decision_refs:
        if decision_id not in known_decisions:
            errors.append(f"{unit_id} references missing decision {decision_id}")
    for item in decisions:
        if not isinstance(item, dict):
            continue
        selected = item.get("selected_evidence_id")
        if (
            item.get("hard_checks_passed")
            and item.get("unit_id") not in known_units
            and item.get("unit_id") != "ingestion"
        ):
            errors.append(f"{item.get('id')} references missing canonical unit {item.get('unit_id')}")
        if selected and selected not in known_evidence:
            errors.append(f"{item.get('id')} selects missing evidence {selected}")
        for alternative in item.get("alternative_evidence_ids", []):
            if alternative not in known_evidence:
                errors.append(f"{item.get('id')} references missing alternative {alternative}")
    for item in evidence:
        if not isinstance(item, dict) or not item.get("page_id"):
            continue
        page_id = item["page_id"]
        if page_id not in page_sizes:
            errors.append(f"{item.get('id')} references missing page {page_id}")
            continue
        bbox = item.get("bbox")
        if bbox and (bbox[2] > page_sizes[page_id][0] or bbox[3] > page_sizes[page_id][1]):
            errors.append(f"{item.get('id')} bounding box exceeds source page")


def _validate_assets(package: Path, document: object, errors: list[str]) -> None:
    referenced = {}
    for page in document.pages:
        for block in page.blocks:
            if getattr(block, "asset", None):
                referenced[block.asset.path] = block.asset.sha256
            if isinstance(block, Table):
                for cell in block.cells:
                    if cell.asset:
                        referenced[cell.asset.path] = cell.asset.sha256
    for relative, digest in referenced.items():
        try:
            safe_relative_path(relative, "assets")
        except ValueError:
            errors.append(f"unsafe asset link {relative}")
            continue
        target = package.joinpath(*PurePosixPath(relative).parts)
        if not target.is_file():
            errors.append(f"missing asset {relative}")
        elif hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            errors.append(f"asset hash mismatch {relative}")
    assets_dir = package / "assets"
    if assets_dir.is_dir():
        actual = {item.relative_to(package).as_posix() for item in assets_dir.rglob("*") if item.is_file()}
        stale = actual - set(referenced)
        errors.extend(f"unreferenced stale asset {relative}" for relative in sorted(stale))


def _validate_hashes(package: Path, manifest: PackageManifest, errors: list[str]) -> None:
    actual_files = {
        item.relative_to(package).as_posix(): hashlib.sha256(item.read_bytes()).hexdigest()
        for item in package.rglob("*")
        if item.is_file() and item.name not in {"manifest.json", "inspection.html"}
    }
    if actual_files != manifest.file_hashes:
        for relative in sorted(actual_files.keys() | manifest.file_hashes.keys()):
            if actual_files.get(relative) != manifest.file_hashes.get(relative):
                errors.append(f"manifest hash mismatch {relative}")


def _validate_permissions(package: Path, errors: list[str]) -> None:
    if os.name != "posix":
        return
    for item in [package, *package.rglob("*")]:
        mode = item.stat().st_mode & 0o777
        expected = 0o700 if item.is_dir() else 0o600
        if mode != expected:
            errors.append(f"unsafe permissions {item.relative_to(package) or '.'}: {mode:04o}")


def _validate_projections(package: Path, document: object, errors: list[str]) -> None:
    markdown = (package / "document.md").read_text(encoding="utf-8")
    normalized_markdown = _normalized_markup(markdown)
    for page in document.pages:
        for block in page.blocks:
            if isinstance(block, Table):
                for cell in block.cells:
                    for paragraph in cell.paragraphs:
                        if paragraph and _normalized_text(paragraph) not in normalized_markdown:
                            errors.append(f"Markdown omits {cell.id}")
                    if cell.asset and cell.asset.path not in markdown:
                        errors.append(f"Markdown omits asset {cell.asset.path}")
            elif block.kind not in {"figure", "unreadable"}:
                for paragraph in block.paragraphs:
                    if paragraph and _normalized_text(paragraph) not in normalized_markdown:
                        errors.append(f"Markdown omits {block.id}")
            if getattr(block, "asset", None) and block.asset.path not in markdown:
                errors.append(f"Markdown omits asset {block.asset.path}")


def _validate_xlsx(path: Path, document: object, errors: list[str]) -> None:
    try:
        workbook = load_workbook(path, read_only=False, data_only=False)
    except Exception as error:
        errors.append(f"invalid document.xlsx: {error}")
        return
    if "_provenance" not in workbook.sheetnames or workbook["_provenance"].sheet_state != "hidden":
        errors.append("hidden _provenance worksheet missing")
        return
    provenance = workbook["_provenance"]
    mapped_ids = {row[6].value for row in provenance.iter_rows(min_row=2) if row[6].value}
    expected_cells = {
        cell.id: cell
        for page in document.pages
        for block in page.blocks
        if isinstance(block, Table)
        for cell in block.cells
    }
    expected_ids = set(expected_cells)
    if mapped_ids != expected_ids:
        errors.append("XLSX provenance does not map every canonical cell")
    for row in provenance.iter_rows(min_row=2, values_only=True):
        sheet_name, cell_range, *_, unit_id = row
        if unit_id not in expected_cells or sheet_name not in workbook.sheetnames:
            continue
        coordinate = str(cell_range).split(":", 1)[0]
        value = workbook[sheet_name][coordinate].value
        expected = "\n\n".join(expected_cells[unit_id].paragraphs)
        if _normalized_text(str(value or "")) != _normalized_text(expected):
            errors.append(f"XLSX text mismatch for {unit_id}")
    expected_images = sum(bool(cell.asset) for cell in expected_cells.values())
    actual_images = sum(len(sheet._images) for sheet in workbook.worksheets if sheet.title != "_provenance")
    if actual_images != expected_images:
        errors.append("XLSX image count does not match canonical image cells")
    for sheet in workbook.worksheets:
        if sheet.title == "_provenance":
            continue
        for row in sheet.iter_rows():
            for cell in row:
                if (
                    isinstance(cell.value, str)
                    and cell.value.startswith(("=", "+", "-", "@"))
                    and cell.data_type == "f"
                ):
                    errors.append(f"XLSX formula injection at {sheet.title}!{cell.coordinate}")


def evaluate(
    gold_dir: str | Path,
    output_dir: str | Path,
    deterministic_dir: str | Path | None = None,
) -> dict[str, object]:
    gold_document = parse_canonical_html((Path(gold_dir) / "document.html").read_text(encoding="utf-8"))
    output_document = parse_canonical_html((Path(output_dir) / "document.html").read_text(encoding="utf-8"))
    gold_blocks = _blocks(gold_document)
    output_blocks = _blocks(output_document)
    gold_text = "\n".join(_unit_text(block) for block in gold_blocks)
    output_text = "\n".join(_unit_text(block) for block in output_blocks)
    gold_tokens = re.findall(r"\S+", gold_text)
    output_tokens = re.findall(r"\S+", output_text)
    gold_critical = Counter(_critical_tokens(gold_text))
    output_critical = Counter(_critical_tokens(output_text))
    topology_match = _table_topologies(gold_document) == _table_topologies(output_document)
    span_match = _table_spans(gold_document) == _table_spans(output_document)
    deterministic = None
    if deterministic_dir is not None:
        deterministic = (Path(output_dir) / "document.html").read_bytes() == (
            Path(deterministic_dir) / "document.html"
        ).read_bytes() and _deterministic_provenance(
            Path(output_dir) / "provenance.json"
        ) == _deterministic_provenance(Path(deterministic_dir) / "provenance.json")
    metrics = {
        "block_split_merge_errors": abs(len(gold_blocks) - len(output_blocks)),
        "table_topology_match": topology_match,
        "span_match": span_match,
        "cer": _edit_distance(list(gold_text), list(output_text)) / max(1, len(gold_text)),
        "wer": _edit_distance(gold_tokens, output_tokens) / max(1, len(gold_tokens)),
        "critical_token_recall": sum((gold_critical & output_critical).values())
        / max(1, sum(gold_critical.values())),
        "added_critical_tokens": list((output_critical - gold_critical).elements()),
        "projection_errors": validate_package(output_dir),
        "deterministic_match": deterministic,
    }
    metrics["passed"] = bool(
        topology_match
        and span_match
        and not metrics["added_critical_tokens"]
        and not metrics["projection_errors"]
        and deterministic is not False
    )
    return metrics


def _blocks(document: object) -> list[object]:
    return [block for page in document.pages for block in page.blocks]


def _unit_text(block: object) -> str:
    if isinstance(block, Table):
        return "\n".join("\n\n".join(cell.paragraphs) for cell in block.cells)
    return "\n".join(block.paragraphs)


def _table_topologies(document: object) -> list[tuple[int, int]]:
    return [
        table_dimensions(block)
        for page in document.pages
        for block in page.blocks
        if isinstance(block, Table)
    ]


def _table_spans(document: object) -> list[list[tuple[int, int, int, int]]]:
    return [
        [(cell.row, cell.column, cell.rowspan, cell.colspan) for cell in block.cells]
        for page in document.pages
        for block in page.blocks
        if isinstance(block, Table)
    ]


def _critical_tokens(value: str) -> list[str]:
    return [
        token.casefold()
        for token in re.findall(r"\b(?=\w*[A-Za-zА-Яа-яІіЇїЄєҐґ])(?=\w*\d)[\w./:-]+\b", value)
    ]


def _edit_distance(first: list[object], second: list[object]) -> int:
    prior = list(range(len(second) + 1))
    for row, left in enumerate(first, start=1):
        current = [row]
        for column, right in enumerate(second, start=1):
            current.append(min(current[-1] + 1, prior[column] + 1, prior[column - 1] + (left != right)))
        prior = current
    return prior[-1]


def _deterministic_provenance(path: Path) -> object:
    value = json.loads(path.read_text(encoding="utf-8"))
    for evidence in value.get("evidence", []):
        evidence.get("metadata", {}).pop("latency_ms", None)
    return value


def _normalized_markup(value: str) -> str:
    root = html.fromstring(f"<div>{value}</div>")
    for line_break in root.iter("br"):
        line_break.tail = " " + (line_break.tail or "")
    return re.sub(r"\s+", " ", root.text_content()).strip().casefold()


def _normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()
