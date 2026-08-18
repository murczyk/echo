#!/usr/bin/env python3

import argparse
import collections
import json
import pathlib
import re
import sys
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from prompts.prompts import DOCUMENTS


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("raw", type=pathlib.Path)
    parser.add_argument("--reference-dir", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    return parser.parse_args()


def normalize(text):
    text = unicodedata.normalize("NFKC", text).casefold().replace("ё", "е")
    text = re.sub(r"[^\w%]+", " ", text, flags=re.UNICODE)
    return " ".join(text.split())


def levenshtein(left, right):
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for left_index, left_value in enumerate(left, 1):
        current = [left_index]
        for right_index, right_value in enumerate(right, 1):
            current.append(min(
                current[-1] + 1,
                previous[right_index] + 1,
                previous[right_index - 1] + (left_value != right_value),
            ))
        previous = current
    return previous[-1]


def error_rates(reference, candidate):
    reference_normalized = normalize(reference)
    candidate_normalized = normalize(candidate)
    character_distance = levenshtein(reference_normalized, candidate_normalized)
    reference_words = reference_normalized.split()
    candidate_words = candidate_normalized.split()
    word_distance = levenshtein(reference_words, candidate_words)
    return {
        "cer": character_distance / max(1, len(reference_normalized)),
        "wer": word_distance / max(1, len(reference_words)),
        "reference_characters": len(reference_normalized),
        "candidate_characters": len(candidate_normalized),
    }


def audited_section(path):
    text = path.read_text()
    match = re.search(r"^## Дослівн[^\n]*\n(.*?)(?=^## )", text, flags=re.MULTILINE | re.DOTALL)
    if not match:
        raise RuntimeError(f"cannot find audited transcription in {path}")
    return match.group(1).strip()


def response_content(artifact):
    if not artifact.get("response"):
        return ""
    return artifact["response"]["choices"][0]["message"].get("content") or ""


def repeated_lines(text):
    lines = [normalize(line) for line in text.splitlines()]
    counts = collections.Counter(line for line in lines if len(line) >= 8)
    return [{"line": line, "count": count} for line, count in counts.items() if count >= 4]


def repeated_token_patterns(text):
    tokens = normalize(text).split()
    patterns = []
    for size in range(3, min(20, len(tokens) // 4) + 1):
        index = 0
        while index + size * 4 <= len(tokens):
            pattern = tokens[index:index + size]
            count = 1
            while tokens[index + count * size:index + (count + 1) * size] == pattern:
                count += 1
            if count >= 4:
                patterns.append({"pattern": " ".join(pattern), "size": size, "count": count})
                index += count * size
            else:
                index += 1
    return patterns[:20]


def markdown_rows(text):
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("|") and line.endswith("|"):
            rows.append([cell.strip() for cell in line.split("|")[1:-1]])
    return rows


def table_metrics(document, text, reference):
    rows = markdown_rows(text)
    reference_rows = markdown_rows(reference)
    if document == "j5":
        structural_rows = [row for row in rows if len(row) == 5]
        valid = len(structural_rows) >= 6 and all(len(row) == 5 for row in structural_rows)
    else:
        two_column_rows = [row for row in rows if len(row) == 2]
        table_headers = [normalize(" ".join(row)) for row in two_column_rows]
        valid = (
            len(two_column_rows) >= 6
            and any("всего за сутки совершено вылетов" in row for row in table_headers)
            and any("за сутки уничтожено" in row for row in table_headers)
            and "ВЫГРУЖЕНО" in text
            and "ПО ФАКТУ" in text
        )
    reference_cells = " ".join(cell for row in reference_rows for cell in row)
    candidate_cells = " ".join(cell for row in rows for cell in row)
    return {
        "valid_structure": valid,
        "row_count": len(rows),
        "reference_row_count": len(reference_rows),
        "cell_text": error_rates(reference_cells, candidate_cells),
    }


def structured_json_metrics(artifact, content):
    if "response_format" not in artifact["request"]:
        return {"requested": False, "valid": None}
    try:
        json.loads(content)
        valid = True
    except (TypeError, json.JSONDecodeError):
        valid = False
    return {"requested": True, "valid": valid}


def score_artifact(path, references):
    artifact = json.loads(path.read_text())
    document = "l54" if artifact["source"]["filename"].startswith("l54") else "j5"
    content = response_content(artifact)
    reference = references[document]
    normalized_content = normalize(content)
    critical_missing = [
        entity for entity in DOCUMENTS[document]["critical_entities"]
        if normalize(entity) not in normalized_content
    ]
    missing_sections = [
        section for section in DOCUMENTS[document]["required_sections"]
        if normalize(section) not in normalized_content
    ]
    reference_numbers = set(re.findall(r"\d+(?:[.,:]\d+)*", reference))
    candidate_numbers = set(re.findall(r"\d+(?:[.,:]\d+)*", content))
    added_numbers = sorted(candidate_numbers - reference_numbers)
    line_repetition = repeated_lines(content)
    token_repetition = repeated_token_patterns(content)
    whitespace_padding = bool(re.search(r"[ \t]{64,}", content))
    finish_reason = artifact.get("finish_reason")
    json_metrics = structured_json_metrics(artifact, content)
    tables = table_metrics(document, content, reference)
    normal_stop = finish_reason == "stop"
    detector_activated = finish_reason in {"repetition", "repetition_detected"}
    no_added_facts_signal = not added_numbers
    accepted = all([
        normal_stop,
        not detector_activated,
        not line_repetition,
        not token_repetition,
        not whitespace_padding,
        not critical_missing,
        not missing_sections,
        tables["valid_structure"],
        no_added_facts_signal,
        json_metrics["valid"] is not False,
    ])
    return {
        "id": artifact["id"],
        "path": str(path),
        "document": document,
        "prompt_version": artifact["prompt_version"],
        "vision_budget": artifact["vision_budget"],
        "precision": artifact["precision"],
        "sampling": {
            key: artifact["request"].get(key)
            for key in ("temperature", "top_p", "top_k", "seed", "repetition_penalty", "repetition_detection")
        },
        "finish_reason": finish_reason,
        "latency_seconds": artifact["latency_seconds"],
        "usage": artifact.get("usage"),
        "ocr": error_rates(reference, content),
        "critical_retained": len(DOCUMENTS[document]["critical_entities"]) - len(critical_missing),
        "critical_total": len(DOCUMENTS[document]["critical_entities"]),
        "critical_missing": critical_missing,
        "missing_sections": missing_sections,
        "added_numbers": added_numbers,
        "repeated_lines": line_repetition,
        "repeated_token_patterns": token_repetition,
        "whitespace_padding": whitespace_padding,
        "structured_json": json_metrics,
        "table": tables,
        "automatic_acceptance": accepted,
        "human_audit_required_for_added_text": True,
    }


def main():
    args = parse_args()
    references = {
        "l54": audited_section(args.reference_dir / "l54dw_8gZt5foedpH-PY.md"),
        "j5": audited_section(args.reference_dir / "J5rHE_ZMsk1H_QDCCn3v.md"),
    }
    artifacts = []
    for path in sorted(args.raw.rglob("*.json")):
        candidate = json.loads(path.read_text())
        if "id" in candidate and "source" in candidate:
            artifacts.append(path)
    scores = [score_artifact(path, references) for path in artifacts]
    summary = {
        "runs": len(scores),
        "automatic_acceptances": sum(score["automatic_acceptance"] for score in scores),
        "scores": scores,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    for score in scores:
        print(json.dumps({
            "id": score["id"],
            "finish": score["finish_reason"],
            "cer": round(score["ocr"]["cer"], 4),
            "wer": round(score["ocr"]["wer"], 4),
            "critical": f"{score['critical_retained']}/{score['critical_total']}",
            "table": score["table"]["valid_structure"],
            "accepted": score["automatic_acceptance"],
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
