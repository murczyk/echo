#!/usr/bin/env python3
import csv
import hashlib
import json
import pathlib
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass

csv.field_size_limit(sys.maxsize)

EVAL_DIR = pathlib.Path(__file__).resolve().parent.parent
CONFIG_PATH = EVAL_DIR / "datasets.json"
PREPARED_DIR = EVAL_DIR / "raw" / "prepared"
FIELDS = ["source message", "all parsed callsigns", "expected callsigns"]


@dataclass(frozen=True)
class ReviewRow:
    dataset: str
    priority: int
    line_number: int
    message: str
    parsed: tuple[str, ...]
    expected: tuple[str, ...]

    @property
    def corrected(self) -> bool:
        return self.parsed != self.expected

    @property
    def case_id(self) -> str:
        return hashlib.sha256(self.message.encode()).hexdigest()

    @property
    def split(self) -> str:
        return "development" if int(self.case_id[:8], 16) % 10 < 7 else "validation"


def parse_callsigns(value: str, location: str) -> tuple[str, ...]:
    try:
        callsigns = json.loads(value)
    except json.JSONDecodeError as error:
        raise SystemExit(f"{location}: invalid callsign JSON: {error}") from error
    if not isinstance(callsigns, list) or not all(
        isinstance(callsign, str) for callsign in callsigns
    ):
        raise SystemExit(f"{location}: callsigns must be a JSON string array")
    return tuple(callsigns)


def source_lines(path: pathlib.Path):
    with path.open(newline="", encoding="utf-8", errors="replace") as input_file:
        for line in input_file:
            yield line.replace("\0", "")


def load_source(config: dict) -> tuple[list[ReviewRow], dict]:
    path = EVAL_DIR / config["path"]
    rows = []
    stats = Counter()
    with path.open("rb") as input_file:
        checksum = hashlib.sha256(input_file.read()).hexdigest()
    reader = csv.DictReader(source_lines(path), delimiter=config["delimiter"])
    if reader.fieldnames != FIELDS:
        raise SystemExit(f"{path}: unexpected header {reader.fieldnames}")
    for line_number, row in enumerate(reader, start=2):
        stats["inputRows"] += 1
        expected_text = row["expected callsigns"].strip()
        if not expected_text:
            stats["unfinishedRows"] += 1
            continue
        location = f"{path}:{line_number}"
        rows.append(
            ReviewRow(
                dataset=config["name"],
                priority=config["priority"],
                line_number=line_number,
                message=row["source message"],
                parsed=parse_callsigns(row["all parsed callsigns"], location),
                expected=parse_callsigns(expected_text, location),
            )
        )
        stats["labeledRows"] += 1
    stats["correctedRows"] = sum(row.corrected for row in rows)
    return rows, {"sha256": checksum, **stats}


def choose_row(rows: list[ReviewRow]) -> ReviewRow | None:
    priority = max(row.priority for row in rows)
    preferred = [row for row in rows if row.priority == priority]
    corrected = [row for row in preferred if row.corrected]
    if corrected:
        preferred = corrected
    expected_values = {row.expected for row in preferred}
    if len(expected_values) != 1:
        return None
    return min(preferred, key=lambda row: row.line_number)


def canonicalize(rows: list[ReviewRow]) -> tuple[list[ReviewRow], int]:
    grouped = defaultdict(list)
    for row in rows:
        grouped[row.message].append(row)
    selected = []
    ambiguous = 0
    for message_rows in grouped.values():
        row = choose_row(message_rows)
        if row is None:
            ambiguous += 1
        else:
            selected.append(row)
    selected.sort(key=lambda row: row.case_id)
    return selected, ambiguous


def json_array(values: tuple[str, ...]) -> str:
    return json.dumps(values, ensure_ascii=False, separators=(",", ":"))


def write_canonical(rows: list[ReviewRow], path: pathlib.Path) -> None:
    with path.open("w", newline="", encoding="utf-8") as output_file:
        writer = csv.writer(output_file)
        writer.writerow(
            [
                "case id",
                "dataset",
                "split",
                "source message",
                "all parsed callsigns",
                "expected callsigns",
            ]
        )
        for row in rows:
            writer.writerow(
                [
                    row.case_id,
                    row.dataset,
                    row.split,
                    row.message,
                    json_array(row.parsed),
                    json_array(row.expected),
                ]
            )


def evaluation_rows(rows: list[ReviewRow], guard_limit: int) -> list[tuple[ReviewRow, str]]:
    selected = [(row, "correction") for row in rows if row.corrected]
    guards = defaultdict(list)
    for row in rows:
        if not row.corrected:
            guards[(row.dataset, row.split)].append(row)
    for candidates in guards.values():
        candidates.sort(key=lambda row: row.case_id)
        selected.extend((row, "guard") for row in candidates[:guard_limit])
    selected.sort(key=lambda item: item[0].case_id)
    return selected


def write_evaluation(rows: list[tuple[ReviewRow, str]], path: pathlib.Path) -> None:
    with path.open("w", newline="", encoding="utf-8") as output_file:
        writer = csv.writer(output_file)
        writer.writerow(
            [
                "case id",
                "dataset",
                "split",
                "case kind",
                "source message",
                "all parsed callsigns",
                "expected callsigns",
            ]
        )
        for row, case_kind in rows:
            writer.writerow(
                [
                    row.case_id,
                    row.dataset,
                    row.split,
                    case_kind,
                    row.message,
                    json_array(row.parsed),
                    json_array(row.expected),
                ]
            )


def baseline_metrics(rows: list[ReviewRow]) -> dict:
    false_positives = 0
    false_negatives = 0
    for row in rows:
        false_positives += len(set(row.parsed) - set(row.expected))
        false_negatives += len(set(row.expected) - set(row.parsed))
    return {
        "cases": len(rows),
        "exactCases": sum(not row.corrected for row in rows),
        "errorCases": sum(row.corrected for row in rows),
        "falsePositives": false_positives,
        "falseNegatives": false_negatives,
    }


def main() -> None:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    all_rows = []
    source_stats = {}
    for source in config["sources"]:
        rows, stats = load_source(source)
        all_rows.extend(rows)
        source_stats[source["name"]] = stats
    canonical, ambiguous = canonicalize(all_rows)
    evaluation = evaluation_rows(canonical, config["guardRowsPerSourceSplit"])
    PREPARED_DIR.mkdir(parents=True, exist_ok=True)
    canonical_path = PREPARED_DIR / "canonical.csv"
    evaluation_path = PREPARED_DIR / "evaluation.csv"
    write_canonical(canonical, canonical_path)
    write_evaluation(evaluation, evaluation_path)
    manifest = {
        "version": config["version"],
        "sources": source_stats,
        "canonical": {
            "labeledRows": len(canonical),
            "correctedRows": sum(row.corrected for row in canonical),
            "ambiguousMessagesExcluded": ambiguous,
            "baseline": baseline_metrics(canonical),
            "sha256": hashlib.sha256(canonical_path.read_bytes()).hexdigest(),
        },
        "evaluation": {
            "rows": len(evaluation),
            "correctionRows": sum(kind == "correction" for _, kind in evaluation),
            "guardRows": sum(kind == "guard" for _, kind in evaluation),
            "developmentRows": sum(row.split == "development" for row, _ in evaluation),
            "validationRows": sum(row.split == "validation" for row, _ in evaluation),
            "sha256": hashlib.sha256(evaluation_path.read_bytes()).hexdigest(),
        },
    }
    (PREPARED_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
