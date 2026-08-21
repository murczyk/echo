#!/usr/bin/env python3
import hashlib
import json
import pathlib
import subprocess
from collections import defaultdict
from datetime import datetime

EVAL_DIR = pathlib.Path(__file__).resolve().parent.parent
CONFIG_PATH = EVAL_DIR / "datasets.json"
PREPARED_DIR = EVAL_DIR / "raw" / "prepared"


def checksum(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as input_file:
        for chunk in iter(lambda: input_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_zstd_jsonl(path: pathlib.Path) -> list[dict]:
    process = subprocess.Popen(
        ["zstd", "-q", "-dc", str(path)],
        stdout=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    assert process.stdout is not None
    rows = []
    for line_number, line in enumerate(process.stdout, start=1):
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise SystemExit(f"{path}:{line_number}: invalid JSON: {error}") from error
        source = " ".join(str(row.get("source", "")).split())
        report = " ".join(str(row.get("report", "")).split())
        if source and report:
            row["source"] = source
            row["report"] = report
            rows.append(row)
    if process.wait() != 0:
        raise SystemExit(f"zstd failed while reading {path}")
    return rows


def parsed_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def deduplicate(rows: list[dict]) -> list[dict]:
    selected = {}
    for row in sorted(rows, key=lambda item: (parsed_time(item["reportAt"]), item["sourceMessageId"])):
        key = (row["source"].casefold(), row["report"].casefold())
        selected.setdefault(key, row)
    return list(selected.values())


def author_segments(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    by_author = defaultdict(list)
    for row in rows:
        by_author[row["authorKey"]].append(row)
    development = []
    validation = []
    for author_rows in by_author.values():
        author_rows.sort(key=lambda item: (parsed_time(item["reportAt"]), item["sourceMessageId"]))
        split_at = max(1, (len(author_rows) * 2) // 3)
        development.extend(author_rows[:split_at])
        validation.extend(author_rows[split_at:])
    return development, validation


def preceding_examples(target: dict, rows: list[dict]) -> list[dict]:
    target_at = parsed_time(target["reportAt"])
    candidates = [
        row
        for row in rows
        if row["authorKey"] == target["authorKey"]
        and parsed_time(row["reportAt"]) < target_at
        and row["sourceMessageId"] != target["sourceMessageId"]
    ]
    candidates.sort(
        key=lambda item: (parsed_time(item["reportAt"]), item["sourceMessageId"]),
        reverse=True,
    )
    examples = []
    seen_reports = set()
    for row in candidates:
        normalized_report = row["report"].casefold()
        if normalized_report in seen_reports:
            continue
        seen_reports.add(normalized_report)
        examples.append({"source": row["source"][:1500], "report": row["report"]})
        if len(examples) == 6:
            break
    return examples


def choose_targets(rows: list[dict], count: int, split: str) -> list[dict]:
    rows.sort(key=lambda item: (parsed_time(item["reportAt"]), item["sourceMessageId"]))
    if len(rows) < count:
        raise SystemExit(f"{split}: requires {count} targets, only {len(rows)} are available")
    if split == "development":
        return rows[-count:]
    return rows[:count]


def case_value(dataset: str, split: str, target: dict, all_rows: list[dict]) -> dict:
    case_key = f"{dataset}\0{target['sourceMessageId']}\0{target['reportAt']}"
    return {
        "caseId": hashlib.sha256(case_key.encode()).hexdigest(),
        "dataset": dataset,
        "split": split,
        "authorKey": target["authorKey"],
        "sourceMessageId": target["sourceMessageId"],
        "reportAt": target["reportAt"],
        "sourceMaterials": [target["source"][:12000]],
        "styleExamples": preceding_examples(target, all_rows),
        "expected": target["report"],
    }


def write_jsonl(path: pathlib.Path, values: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as output_file:
        for value in values:
            output_file.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def main() -> None:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    PREPARED_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {"version": config["version"], "inputs": {}, "outputs": {}}
    for dataset in config["datasets"]:
        input_path = EVAL_DIR / dataset["path"]
        rows = deduplicate(read_zstd_jsonl(input_path))
        development_rows, validation_rows = author_segments(rows)
        targets = {
            "development": choose_targets(
                development_rows, dataset["developmentTargets"], "development"
            ),
            "validation": choose_targets(
                validation_rows, dataset["validationTargets"], "validation"
            ),
        }
        manifest["inputs"][dataset["name"]] = {
            "path": dataset["path"],
            "sha256": checksum(input_path),
            "deduplicatedRows": len(rows),
        }
        for split, split_targets in targets.items():
            cases = [case_value(dataset["name"], split, row, rows) for row in split_targets]
            output_path = PREPARED_DIR / f"{dataset['name']}-{split}.jsonl"
            write_jsonl(output_path, cases)
            manifest["outputs"][f"{dataset['name']}-{split}"] = {
                "path": str(output_path.relative_to(EVAL_DIR)),
                "rows": len(cases),
                "sha256": checksum(output_path),
            }
    manifest_path = PREPARED_DIR / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
