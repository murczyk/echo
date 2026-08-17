#!/usr/bin/env python3

import argparse
import collections
import itertools
import json
import pathlib
import re

import markdown
from bs4 import BeautifulSoup

ROOT = pathlib.Path(__file__).resolve().parents[1]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=pathlib.Path, default=ROOT / "layout-suite-manifest.json")
    parser.add_argument("--input-dir", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    return parser.parse_args()


def response_text(artifact):
    if artifact.get("answer"):
        return artifact["answer"]
    try:
        text = artifact["response"]["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return ""
    if "</think>" in text:
        text = text.split("</think>", 1)[1]
    return re.sub(r"^\s*<answer>|</answer>\s*$", "", text, flags=re.IGNORECASE).strip()


def strip_wrappers(text):
    text = text.strip().replace("<!-- END_OCR -->", "").strip()
    match = re.fullmatch(r"```(?:html)?\s*(.*?)\s*```", text, flags=re.DOTALL | re.IGNORECASE)
    return match.group(1) if match else text


def normalized_html(text):
    text = strip_wrappers(text)
    if re.search(r"<article(?:\s|>)", text, flags=re.IGNORECASE):
        return text
    converted = markdown.markdown(text, extensions=["extra", "sane_lists"])
    return f'<article><section data-region="source-page">{converted}</section></article>'


def repeated_lines(text):
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    runs = []
    for line, group in itertools.groupby(lines):
        count = sum(1 for _ in group)
        if len(line) >= 12 and count >= 4:
            runs.append({"line": line, "count": count})
    return runs


def repeated_rows(soup):
    rows = [re.sub(r"\s+", " ", str(row)).strip() for row in soup.find_all("tr")]
    runs = []
    for row, group in itertools.groupby(rows):
        count = sum(1 for _ in group)
        if count >= 4:
            runs.append({"row": row, "count": count})
    return runs


def table_grid(table):
    active = {}
    widths = []
    for row in table.find_all("tr"):
        occupied = {column for column, remaining in active.items() if remaining > 0}
        column = 1
        new_spans = {}
        for cell in row.find_all(["th", "td"], recursive=False):
            while column in occupied:
                column += 1
            rowspan = max(1, int(cell.get("rowspan", 1)))
            colspan = max(1, int(cell.get("colspan", 1)))
            for target in range(column, column + colspan):
                occupied.add(target)
                if rowspan > 1:
                    new_spans[target] = rowspan - 1
            column += colspan
        widths.append(max(occupied, default=0))
        active = {
            column: remaining - 1
            for column, remaining in active.items()
            if remaining > 1
        }
        active.update(new_spans)
    return widths


def merged_expect(document, page):
    expected = dict(document.get("expect", {}))
    expected.update(page.get("expect", {}))
    expected["anchors"] = document.get("expect", {}).get("anchors", []) + page.get("anchors", [])
    return expected


def table_structure(soup):
    tables = soup.find_all("table")
    rows = [row for table in tables for row in table.find_all("tr")]
    table_row_widths = [table_grid(table) for table in tables]
    table_widths = [max(widths, default=0) for widths in table_row_widths]
    widths = [width for table_width in table_row_widths for width in table_width]
    return {
        "tables": len(tables),
        "rows": len(rows),
        "max_columns": max(widths, default=0),
        "table_columns": table_widths,
        "table_rows": [len(table.find_all("tr")) for table in tables],
        "table_row_widths": table_row_widths,
        "row_widths": dict(sorted(collections.Counter(widths).items())),
        "empty_cells": sum(not cell.get_text(strip=True) for cell in soup.find_all(["th", "td"])),
        "merged_cells": sum(cell.has_attr("rowspan") or cell.has_attr("colspan") for cell in soup.find_all(["th", "td"])),
        "formatted_cells": sum(any(key in cell.attrs for key in ("data-fill", "data-font-color", "data-bold")) for cell in soup.find_all(["th", "td"])),
        "image_cells": len(soup.select('[data-image="present"], figure, img')),
    }


def document_structure(soup):
    return {
        "articles": len(soup.find_all("article")),
        "sections": len(soup.find_all("section")),
        "paragraphs": len(soup.find_all("p")),
        "headings": len(soup.find_all(re.compile(r"^h[1-6]$"))),
        "lists": len(soup.find_all(["ul", "ol"])),
        "tables": len(soup.find_all("table")),
    }


def expectation_failures(profile, expected, structure, text):
    failures = []
    mappings = {
        "table": (("min_tables", "tables"), ("min_rows", "rows"), ("min_columns", "max_columns")),
        "document": (("min_articles", "articles"), ("min_sections", "sections"), ("min_paragraphs", "paragraphs")),
    }
    for expected_key, actual_key in mappings[profile]:
        if structure[actual_key] < expected.get(expected_key, 0):
            failures.append(f"{actual_key}={structure[actual_key]}<{expected[expected_key]}")
    expected_columns = expected.get("table_columns")
    if expected_columns and structure.get("table_columns") != expected_columns:
        failures.append(
            f"table_columns={structure.get('table_columns')}!={expected_columns}"
        )
    if expected_columns:
        for table_index, (actual_rows, expected_width) in enumerate(
            zip(structure.get("table_row_widths", []), expected_columns), start=1
        ):
            unexpected = sorted({width for width in actual_rows if width != expected_width})
            if unexpected:
                failures.append(
                    f"table_{table_index}_row_columns={unexpected}; expected={expected_width}"
                )
    expected_rows = expected.get("table_rows")
    if expected_rows and structure.get("table_rows") != expected_rows:
        failures.append(f"table_rows={structure.get('table_rows')}!={expected_rows}")
    if structure.get("image_cells", 0) < expected.get("min_image_cells", 0):
        failures.append(
            f"image_cells={structure.get('image_cells', 0)}<{expected['min_image_cells']}"
        )
    folded_text = text.casefold()
    missing_anchors = [anchor for anchor in expected.get("anchors", []) if anchor.casefold() not in folded_text]
    failures.extend(f"missing anchor: {anchor}" for anchor in missing_anchors)
    return failures, missing_anchors


def score_artifact(path, document, page):
    artifact = json.loads(path.read_text())
    text = strip_wrappers(response_text(artifact))
    soup = BeautifulSoup(normalized_html(text), "lxml")
    structure = table_structure(soup) if document["profile"] == "table" else document_structure(soup)
    expected = merged_expect(document, page)
    failures, missing_anchors = expectation_failures(document["profile"], expected, structure, text)
    duplicates = repeated_rows(soup) if document["profile"] == "table" else repeated_lines(text)
    finish_reason = artifact.get("finish_reason")
    if finish_reason != "stop":
        failures.append(f"finish_reason={finish_reason}")
    if artifact.get("error"):
        failures.append("request error")
    if not soup.find("article"):
        failures.append("missing article")
    if duplicates:
        failures.append("repeated lines")
    if re.search(r"[ \t]{80,}", text):
        failures.append("whitespace padding")
    return {
        "artifact": path.name,
        "document_id": document["id"],
        "page_index": page["index"],
        "profile": document["profile"],
        "passed_automated_checks": not failures,
        "finish_reason": finish_reason,
        "latency_seconds": artifact.get("latency_seconds"),
        "usage": artifact.get("usage"),
        "structure": structure,
        "missing_anchors": missing_anchors,
        "repeated_lines": duplicates,
        "failures": failures,
    }


def artifact_for(input_dir, document, page):
    pattern = f"{document['id']}__p{page['index']:02d}__*.json"
    candidates = sorted(input_dir.glob(pattern))
    if len(candidates) != 1:
        raise RuntimeError(f"expected one artifact for {pattern}, found {len(candidates)}")
    return candidates[0]


def main():
    args = parse_args()
    manifest = json.loads(args.manifest.read_text())
    results = []
    for document in manifest["documents"]:
        for page in document["pages"]:
            results.append(score_artifact(artifact_for(args.input_dir, document, page), document, page))
    summary = {
        "suite_id": manifest["suite_id"],
        "pages": len(results),
        "passed": sum(result["passed_automated_checks"] for result in results),
        "failed": sum(not result["passed_automated_checks"] for result in results),
        "results": results,
        "limitations": [
            "Structural checks and manifest anchors do not replace visual auditing.",
            "CER/WER require an audited reference transcription and are not fabricated for new pages.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: summary[key] for key in ("pages", "passed", "failed")}))


if __name__ == "__main__":
    main()
