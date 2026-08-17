#!/usr/bin/env python3
import argparse
import copy
import hashlib
import html
import json
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

REPORT_FILE = "l54dw_8gZt5foedpH-PY.jpg"
TABLE_FILE = "J5rHE_ZMsk1H_QDCCn3v.jpg"


class DocumentHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.text = []
        self.rows = []
        self.current_row = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "tr":
            self.current_row = 0
        elif tag in {"td", "th"} and self.current_row is not None:
            self.current_row += 1
        elif tag in {"br", "p", "tr"}:
            self.text.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "tr" and self.current_row is not None:
            self.rows.append(self.current_row)
            self.current_row = None
        elif tag in {"td", "th", "p"}:
            self.text.append("\n")

    def handle_data(self, data: str) -> None:
        self.text.append(data)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value.rstrip() + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def plain_text(markup: str) -> str:
    parser = DocumentHTMLParser()
    parser.feed(markup)
    text = html.unescape("".join(parser.text))
    text = re.sub(r"!\[[^]]*]\([^)]*\)", " ", text)
    text = re.sub(r"[`*_#]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def number_set(text: str) -> set[str]:
    return set(re.findall(r"\d+(?:[.,]\d+)?", plain_text(text)))


def markdown_candidate(data: dict, filename: str, mode: str) -> str:
    return next(
        run["answer"]
        for run in data["runs"]
        if run["file"] == filename and run["mode"] == mode
    )


def structured_candidate(data: dict, filename: str, mode: str) -> dict:
    return copy.deepcopy(
        next(
            run["parsed"]
            for run in data["runs"]
            if run["file"] == filename and run["mode"] == mode
        )
    )


def numarkdown_candidate(data: dict, filename: str) -> str:
    collection = data.get("documents", data.get("runs", []))
    return next(item["answer"] for item in collection if item["file"] == filename)


def gemma_crop_candidate(data: dict) -> str:
    content = []
    for run in data["runs"]:
        if run["name"].startswith("crop_"):
            content.append(run["response"]["choices"][0]["message"]["content"])
    return "\n\n".join(content)


def check(code: str, passed: bool, detail: str, severity: str = "error") -> dict:
    return {
        "code": code,
        "passed": passed,
        "severity": severity,
        "detail": detail,
    }


def html_row_widths(markup: str) -> list[int]:
    parser = DocumentHTMLParser()
    parser.feed(markup)
    return parser.rows


def extract_variants(pattern: str, candidates: dict[str, str]) -> dict[str, str | None]:
    variants = {}
    for name, candidate in candidates.items():
        match = re.search(pattern, plain_text(candidate), flags=re.IGNORECASE)
        variants[name] = match.group(1) if match else None
    return variants


def disagreement_check(code: str, pattern: str, candidates: dict[str, str]) -> dict:
    variants = extract_variants(pattern, candidates)
    unique = {value.casefold() for value in variants.values() if value}
    return check(
        code,
        len(unique) <= 1,
        json.dumps(variants, ensure_ascii=False),
        severity="review",
    )


def validate_report(selected: str, candidates: dict[str, str]) -> dict:
    checks = []
    required = [
        "Доклад",
        "К выполнению задач привлечено",
        "Всего за сутки",
        "За сутки уничтожено",
        "Основная задача на сутки",
        "Начальник группы боевого управления",
    ]
    missing = [marker for marker in required if marker not in selected]
    checks.append(check("required_sections", not missing, f"missing={missing}"))

    widths = html_row_widths(selected)
    checks.append(
        check(
            "two_column_layout",
            bool(widths) and max(widths) == 2,
            f"html_row_widths={widths}",
        )
    )

    selected_numbers = number_set(selected)
    for name, candidate in candidates.items():
        candidate_numbers = number_set(candidate)
        missing_numbers = sorted(candidate_numbers - selected_numbers)
        checks.append(
            check(
                f"numbers_cover_{name}",
                not missing_numbers,
                f"missing_from_selected={missing_numbers}",
                severity="review",
            )
        )

    checks.append(
        check(
            "no_latinized_gbps",
            not re.search(r"\bgbps\b", selected, flags=re.IGNORECASE),
            "The source abbreviation should remain Cyrillic.",
            severity="review",
        )
    )
    checks.append(
        check(
            "no_replacement_character",
            "�" not in selected,
            "No Unicode replacement character is allowed.",
        )
    )
    checks.append(
        disagreement_check(
            "flight_heading_consensus",
            r"Всего за сутки (соверш\w+) вылетов",
            candidates,
        )
    )
    checks.append(
        disagreement_check(
            "artillery_target_consensus",
            r"(Арт\.\s+[А-Яа-яЁё]+)\s*-\s*1",
            candidates,
        )
    )
    checks.append(
        disagreement_check(
            "kushuhum_spelling_consensus",
            r"(Куш[А-Яа-яЁё]+)",
            candidates,
        )
    )

    failed = [item for item in checks if not item["passed"]]
    return {
        "status": "review_required" if failed else "passed",
        "checks": checks,
        "failed_check_count": len(failed),
    }


def reconcile_report_data(non_thinking: dict, thinking: dict) -> tuple[dict, list[dict]]:
    result = copy.deepcopy(non_thinking)
    repairs = []
    primary = result.get("destroyed_or_suppressed", [])
    fallback = thinking.get("destroyed_or_suppressed", [])
    primary_bases = {item.get("accounting_basis") for item in primary}
    fallback_bases = {item.get("accounting_basis") for item in fallback}
    if len(primary) == len(fallback) and len(primary_bases) == 1 and len(fallback_bases) == 2:
        for primary_item, fallback_item in zip(primary, fallback):
            primary_item["accounting_basis"] = fallback_item["accounting_basis"]
        repairs.append(
            {
                "code": "restored_destroyed_accounting_columns",
                "source": "NuExtract3 thinking layout",
                "rows": len(primary),
            }
        )
    return result, repairs


def validate_report_data(data: dict) -> dict:
    checks = []
    invalid_sorties = [
        item
        for item in data.get("sorties", [])
        if item.get("total") is None
        or item.get("successful") is None
        or item["successful"] > item["total"]
    ]
    checks.append(
        check("sortie_arithmetic", not invalid_sorties, f"invalid={invalid_sorties}")
    )
    bases = {
        item.get("accounting_basis")
        for item in data.get("destroyed_or_suppressed", [])
    }
    checks.append(
        check(
            "destroyed_accounting_bases",
            bases == {"ВЫГРУЖЕНО", "ПО ФАКТУ"},
            f"bases={sorted(value for value in bases if value)}",
        )
    )
    serialized = json.dumps(data, ensure_ascii=False)
    checks.append(
        check(
            "structured_no_replacement_character",
            "�" not in serialized,
            "A structured target contains the Unicode replacement character.",
            severity="review",
        )
    )
    incomplete_routes = [
        item
        for item in data.get("special_attention_areas", [])
        if len(item.get("coordinates", [])) > 1
        and not re.search(r"[-–]", item.get("object_or_route") or "")
    ]
    checks.append(
        check(
            "route_endpoints_present",
            not incomplete_routes,
            f"incomplete={incomplete_routes}",
            severity="review",
        )
    )
    failed = [item for item in checks if not item["passed"]]
    return {
        "status": "review_required" if failed else "passed",
        "checks": checks,
        "failed_check_count": len(failed),
    }


def empty_table_column(column: dict) -> bool:
    return (
        not column.get("object")
        and not column.get("coordinates")
        and not column.get("planned_means")
        and not column.get("notes")
    )


def clean_table_data(data: dict) -> tuple[dict, list[dict]]:
    result = copy.deepcopy(data)
    original = result.get("columns", [])
    kept = [column for column in original if not empty_table_column(column)]
    repairs = []
    if len(kept) != len(original):
        repairs.append(
            {
                "code": "dropped_empty_visual_header_column",
                "removed_titles": [
                    column.get("title") for column in original if empty_table_column(column)
                ],
            }
        )
    result["columns"] = kept
    return result, repairs


def coordinate_labels(coordinates: list[str]) -> list[str]:
    labels = []
    for coordinate in coordinates:
        match = re.match(r"\s*([XY])\s*=", coordinate)
        if match:
            labels.append(match.group(1))
    return labels


def alternating_xy(labels: list[str]) -> bool:
    return not labels or labels == ["X", "Y"] * (len(labels) // 2)


def validate_table_data(data: dict, thinking: dict, numarkdown: str) -> dict:
    columns = data.get("columns", [])
    checks = [check("four_data_columns", len(columns) == 4, f"count={len(columns)}")]
    incomplete = [
        index + 1
        for index, column in enumerate(columns)
        if not all(
            [
                column.get("title"),
                column.get("object"),
                column.get("coordinates"),
                column.get("planned_means"),
                column.get("notes"),
            ]
        )
    ]
    checks.append(check("required_cells", not incomplete, f"incomplete={incomplete}"))

    bad_pairing = [
        {"column": index + 1, "labels": coordinate_labels(column["coordinates"])}
        for index, column in enumerate(columns)
        if not alternating_xy(coordinate_labels(column["coordinates"]))
    ]
    checks.append(check("coordinate_pairing", not bad_pairing, f"bad={bad_pairing}"))

    structured_numbers = set()
    for column in columns:
        structured_numbers.update(number_set(" ".join(column["coordinates"])))
    missing_from_markdown = sorted(structured_numbers - number_set(numarkdown))
    checks.append(
        check(
            "coordinates_confirmed_by_numarkdown",
            not missing_from_markdown,
            f"missing={missing_from_markdown}",
            severity="review",
        )
    )

    thinking_columns = [
        column for column in thinking.get("columns", []) if not empty_table_column(column)
    ]
    primary_names = [[item["name"] for item in col["planned_means"]] for col in columns]
    thinking_names = [
        [item["name"] for item in col["planned_means"]] for col in thinking_columns
    ]
    checks.append(
        check(
            "planned_means_consensus",
            primary_names == thinking_names,
            json.dumps(
                {"non_thinking": primary_names, "thinking": thinking_names},
                ensure_ascii=False,
            ),
            severity="review",
        )
    )

    punctuation = [
        column["title"] for column in columns if re.search(r"н\.п\s", column["title"])
    ]
    checks.append(
        check(
            "settlement_abbreviation_punctuation",
            not punctuation,
            f"titles={punctuation}",
            severity="review",
        )
    )
    failed = [item for item in checks if not item["passed"]]
    return {
        "status": "review_required" if failed else "passed",
        "checks": checks,
        "failed_check_count": len(failed),
    }


def escape_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", "<br>")


def render_table(data: dict) -> str:
    columns = data["columns"]
    header = ["Поле"] + [column["title"] for column in columns]
    rows = [
        ["Объект поражения"] + [column["object"] for column in columns],
        ["Координаты"]
        + ["<br>".join(column["coordinates"]) for column in columns],
        ["Спланированные средства Разведки / поражения"]
        + [
            "<br>".join(
                f'{item["name"]} ({item["configuration"]})'
                for item in column["planned_means"]
            )
            for column in columns
        ],
        ["Примечания"] + [column["notes"] for column in columns],
    ]
    lines = [
        "| " + " | ".join(escape_cell(value) for value in header) + " |",
        "| " + " | ".join("---" for _ in header) + " |",
    ]
    lines.extend(
        "| " + " | ".join(escape_cell(value) for value in row) + " |"
        for row in rows
    )
    return "\n".join(lines)


def summary_result(data: dict) -> dict:
    return {
        "summary_uk": data["summary_uk"],
        "validation": data["validation"],
        "attempt_count": data.get("attempt_count", 1),
    }


def write_candidates(output: Path, document: str, candidates: dict[str, str]) -> None:
    for name, candidate in candidates.items():
        write_text(output / document / "candidates" / f"{name}.md", candidate)


def build_review(
    report_validation: dict,
    report_data_validation: dict,
    table_validation: dict,
    summaries: dict[str, dict],
) -> str:
    lines = [
        "# Звіт high-quality pipeline",
        "",
        "## Статус",
        "",
        "| Компонент | Статус |",
        "| --- | --- |",
        f'| OCR/layout звіту | {report_validation["status"]} |',
        f'| Структуровані дані звіту | {report_data_validation["status"]} |',
        f'| Структурована таблиця | {table_validation["status"]} |',
        f'| Український підсумок l54 | {"passed" if summaries["l54"]["validation"]["passed"] else "review_required"} |',
        f'| Український підсумок J5 | {"passed" if summaries["j5"]["validation"]["passed"] else "review_required"} |',
        "",
        "Автоматичний результат навмисно не приховує розбіжності між моделями. "
        "Фінальними еталонними файлами після візуального аудиту залишаються "
        "[l54](../../legacy/l54dw_8gZt5foedpH-PY.md) та "
        "[J5](../../legacy/J5rHE_ZMsk1H_QDCCn3v.md).",
        "",
        "## Перевірки, що потребують уваги",
        "",
    ]
    groups = [
        ("OCR/layout звіту", report_validation),
        ("Структуровані дані звіту", report_data_validation),
        ("Таблиця", table_validation),
    ]
    for title, validation in groups:
        failed = [item for item in validation["checks"] if not item["passed"]]
        if not failed:
            continue
        lines.append(f"### {title}")
        lines.append("")
        for item in failed:
            lines.append(f'- `{item["code"]}` ({item["severity"]}): {item["detail"]}')
        lines.append("")
    return "\n".join(lines)


def input_manifest(paths: list[Path]) -> list[dict]:
    return [
        {"file": path.name, "bytes": path.stat().st_size, "sha256": sha256(path)}
        for path in paths
    ]


def run() -> None:
    args = parse_args()
    paths = {
        "nuextract_markdown": args.results / "nuextract3.vllm.raw.json",
        "nuextract_structured": args.results / "nuextract3.structured.raw.json",
        "numarkdown": args.results / "numarkdown.vllm.raw.json",
        "gemma_report": args.results / "l54dw_8gZt5foedpH-PY.gemma.raw.json",
        "summary_l54": args.results / "l54.gemma-summary.raw.json",
        "summary_j5": args.results / "J5.gemma-summary.raw.json",
    }
    inputs = {name: load_json(path) for name, path in paths.items()}

    report_candidates = {
        "nuextract3.non_thinking": markdown_candidate(
            inputs["nuextract_markdown"], REPORT_FILE, "non_thinking"
        ),
        "nuextract3.thinking": markdown_candidate(
            inputs["nuextract_markdown"], REPORT_FILE, "thinking"
        ),
        "numarkdown": numarkdown_candidate(inputs["numarkdown"], REPORT_FILE),
        "gemma.crops": gemma_crop_candidate(inputs["gemma_report"]),
    }
    selected_report = report_candidates["nuextract3.non_thinking"]
    report_validation = validate_report(selected_report, report_candidates)
    write_candidates(args.output, "l54", report_candidates)
    write_text(args.output / "l54" / "selected-layout.md", selected_report)

    report_non_thinking = structured_candidate(
        inputs["nuextract_structured"], REPORT_FILE, "non_thinking"
    )
    report_thinking = structured_candidate(
        inputs["nuextract_structured"], REPORT_FILE, "thinking"
    )
    report_data, report_repairs = reconcile_report_data(
        report_non_thinking, report_thinking
    )
    report_data_validation = validate_report_data(report_data)
    write_json(args.output / "l54" / "derived-data.json", report_data)

    table_non_thinking = structured_candidate(
        inputs["nuextract_structured"], TABLE_FILE, "non_thinking"
    )
    table_thinking = structured_candidate(
        inputs["nuextract_structured"], TABLE_FILE, "thinking"
    )
    table_data, table_repairs = clean_table_data(table_non_thinking)
    table_numarkdown = numarkdown_candidate(inputs["numarkdown"], TABLE_FILE)
    table_validation = validate_table_data(
        table_data, table_thinking, table_numarkdown
    )
    write_json(args.output / "J5" / "structured-table.json", table_data)
    write_text(args.output / "J5" / "structured-table.md", render_table(table_data))

    summaries = {
        "l54": summary_result(inputs["summary_l54"]),
        "j5": summary_result(inputs["summary_j5"]),
    }
    write_text(args.output / "l54" / "gemma-summary.uk.md", summaries["l54"]["summary_uk"])
    write_text(args.output / "J5" / "gemma-summary.uk.md", summaries["j5"]["summary_uk"])

    report_bundle = {
        "document": REPORT_FILE,
        "selected_layout_candidate": "nuextract3.non_thinking",
        "layout_validation": report_validation,
        "structured_validation": report_data_validation,
        "structured_repairs": report_repairs,
        "summary": summaries["l54"],
        "canonical_reviewed_file": "../../legacy/l54dw_8gZt5foedpH-PY.md",
    }
    table_bundle = {
        "document": TABLE_FILE,
        "selected_structured_candidate": "nuextract3.non_thinking",
        "validation": table_validation,
        "repairs": table_repairs,
        "summary": summaries["j5"],
        "canonical_reviewed_file": "../../legacy/J5rHE_ZMsk1H_QDCCn3v.md",
    }
    write_json(args.output / "l54" / "validation.json", report_bundle)
    write_json(args.output / "J5" / "validation.json", table_bundle)

    manifest = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "strategy": {
            "primary_ocr": "NuExtract3 BF16 non-thinking",
            "fallback_ocr": ["NuExtract3 BF16 thinking", "NuMarkdown 4-bit"],
            "independent_verifier": "Gemma 4 26B on Spark crops",
            "semantic_summary": "Gemma 4 26B text-only with validation and retry",
            "policy": "Never silently accept a cross-model disagreement.",
        },
        "models": {
            "nuextract3": "2e9fca82ee641e6bb6e1f5d905241e994be27a07",
            "numarkdown": "8dfc5236ae68b799d86308aae2f9717fdb50286e",
            "gemma": "google/gemma-4-26B-A4B-it",
        },
        "inputs": input_manifest(list(paths.values())),
        "repairs": {
            "report": report_repairs,
            "table": table_repairs,
        },
        "final_status": {
            "report": "review_required",
            "table": table_validation["status"],
            "canonical_reviewed_outputs_available": True,
        },
    }
    write_json(args.output / "manifest.json", manifest)
    write_text(
        args.output / "REVIEW.md",
        build_review(
            report_validation,
            report_data_validation,
            table_validation,
            summaries,
        ),
    )


if __name__ == "__main__":
    run()
