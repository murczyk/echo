#!/usr/bin/env python3

import argparse
import copy
import json
import pathlib
import re

from bs4 import BeautifulSoup, NavigableString

import build_layout_outputs as outputs
import score_layout_suite as scoring

ROOT = pathlib.Path(__file__).resolve().parents[1]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=pathlib.Path, default=ROOT / "layout-suite-manifest.json")
    parser.add_argument("--selection", type=pathlib.Path, default=ROOT / "layout-selection.json")
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    return parser.parse_args()


def artifact_path(directory, document, page):
    candidates = sorted(directory.glob(f"{document['id']}__p{page['index']:02d}__*.json"))
    if len(candidates) != 1:
        raise RuntimeError(f"expected one artifact for {document['id']} page {page['index']}")
    return candidates[0]


def replace_text(soup, replacements):
    for node in list(soup.find_all(string=True)):
        if not isinstance(node, NavigableString):
            continue
        text = str(node)
        for source, target in replacements.items():
            text = text.replace(source, target)
        node.replace_with(text)


def table_at(soup, operation):
    tables = soup.find_all("table")
    return tables[operation.get("table", 1) - 1]


def plain_three_cell_header(soup, _operation):
    for cell in soup.find("table").find("tr").find_all(["th", "td"], recursive=False):
        cell.attrs.pop("rowspan", None)
        cell.attrs.pop("colspan", None)


def first_header_colspan(soup, operation):
    cell = soup.find("table").find("tr").find(["th", "td"])
    cell["colspan"] = str(operation["value"])


def single_cell_rows_colspan(soup, operation):
    for row in table_at(soup, operation).find_all("tr"):
        cells = row.find_all(["th", "td"], recursive=False)
        if len(cells) == 1:
            cells[0]["colspan"] = str(operation["columns"])


def header_cell_colspan(soup, operation):
    for cell in table_at(soup, operation).find("tr").find_all(["th", "td"], recursive=False):
        if operation["cell_contains"] in cell.get_text(" ", strip=True):
            cell["colspan"] = str(operation["value"])
            return
    raise RuntimeError(f"header cell not found: {operation['cell_contains']}")


def row_occupancy(rows):
    active = {}
    for row in rows:
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
        yield row, occupied
        active = {column: remaining - 1 for column, remaining in active.items() if remaining > 1}
        active.update(new_spans)


def append_short_rows(soup, operation):
    table = table_at(soup, operation)
    for row, occupied in row_occupancy(table.find_all("tr")):
        for _ in range(operation["columns"] - len(occupied)):
            row.append(soup.new_tag("td"))


def matching_row(table, text):
    for row in table.find_all("tr"):
        if text in row.get_text(" ", strip=True):
            return row
    raise RuntimeError(f"row not found: {text}")


def insert_blank_before(soup, operation):
    row = matching_row(table_at(soup, operation), operation["row_contains"])
    for cell in row.find_all(["th", "td"], recursive=False):
        if operation["cell_contains"] in cell.get_text(" ", strip=True):
            cell.insert_before(soup.new_tag("td"))
            return
    raise RuntimeError(f"cell not found: {operation['cell_contains']}")


def append_blank(soup, operation):
    matching_row(table_at(soup, operation), operation["row_contains"]).append(soup.new_tag("td"))


def insert_cell(soup, operation):
    row = matching_row(table_at(soup, operation), operation["row_contains"])
    cells = row.find_all(["th", "td"], recursive=False)
    cell = soup.new_tag("td")
    cell.string = operation.get("text", "")
    cells[operation["before"] - 1].insert_before(cell)


def insert_blank_before_all(soup, operation):
    pattern = re.compile(operation["cell_pattern"])
    for row in table_at(soup, operation).find_all("tr"):
        for cell in row.find_all(["th", "td"], recursive=False):
            if pattern.search(cell.get_text(" ", strip=True)):
                cell.insert_before(soup.new_tag("td"))
                break


OPERATIONS = {
    "plain_three_cell_header": plain_three_cell_header,
    "first_header_colspan": first_header_colspan,
    "single_cell_rows_colspan": single_cell_rows_colspan,
    "header_cell_colspan": header_cell_colspan,
    "append_short_rows": append_short_rows,
    "insert_blank_before": insert_blank_before,
    "append_blank": append_blank,
    "insert_cell": insert_cell,
    "insert_blank_before_all": insert_blank_before_all,
}


def selected_fragment(root, selection, document, page):
    choice = selection["documents"][document["id"]][str(page["index"])]
    directory = root / selection["models"][choice["model"]]
    artifact = artifact_path(directory, document, page)
    soup = BeautifulSoup(outputs.response_html(artifact), "lxml")
    replace_text(soup, choice.get("replacements", {}))
    for operation in choice.get("operations", []):
        OPERATIONS[operation["name"]](soup, operation)
    article = soup.find("article") or soup.body or soup
    return choice, artifact, str(article)


def score_fragment(document, page, fragment):
    soup = BeautifulSoup(fragment, "lxml")
    structure = scoring.table_structure(soup) if document["profile"] == "table" else scoring.document_structure(soup)
    expected = scoring.merged_expect(document, page)
    failures, missing = scoring.expectation_failures(document["profile"], expected, structure, fragment)
    return {
        "document_id": document["id"],
        "page_index": page["index"],
        "passed_structural_checks": not failures,
        "structure": structure,
        "missing_anchors": missing,
        "failures": failures,
    }


def write_derivatives(output_dir, document, html):
    html_path = output_dir / "html" / f"{document['id']}.html"
    html_path.write_text(html)
    if document["profile"] == "table":
        derivative = output_dir / "xlsx" / f"{document['id']}.xlsx"
        outputs.html_to_xlsx(html, derivative)
    else:
        derivative = output_dir / "markdown" / f"{document['id']}.md"
        derivative.write_text(outputs.html_to_markdown(html))
    return html_path, derivative


def write_combined_html(output_dir, manifest, documents):
    soup = BeautifulSoup(
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<title>14AUG26 OCR — combined result</title></head><body></body></html>',
        "lxml",
    )
    heading = soup.new_tag("h1")
    heading.string = "14AUG26 OCR — combined result"
    soup.body.append(heading)
    description = soup.new_tag("p")
    description.string = (
        "Canonical semantic HTML selected page by page. XLSX and Markdown files are "
        "generated derivatives; model selection and repairs are recorded in index.json."
    )
    soup.body.append(description)
    navigation = soup.new_tag("nav")
    document_by_id = {document["document_id"]: document for document in documents}
    for source_document in manifest["documents"]:
        document = document_by_id[source_document["id"]]
        paragraph = soup.new_tag("p")
        link = soup.new_tag("a", href=f"#{source_document['id']}")
        link.string = source_document["title"]
        paragraph.append(link)
        paragraph.append(" — ")
        html_link = soup.new_tag("a", href=document["html"])
        html_link.string = "standalone HTML"
        paragraph.append(html_link)
        paragraph.append(" / ")
        derivative_link = soup.new_tag("a", href=document["derivative"])
        derivative_link.string = pathlib.Path(document["derivative"]).suffix[1:].upper()
        paragraph.append(derivative_link)
        navigation.append(paragraph)
    soup.body.append(navigation)
    for source_document in manifest["documents"]:
        document = document_by_id[source_document["id"]]
        section = soup.new_tag(
            "section",
            id=source_document["id"],
            attrs={"data-profile": source_document["profile"]},
        )
        heading = soup.new_tag("h2")
        heading.string = source_document["title"]
        section.append(heading)
        standalone = BeautifulSoup(
            (output_dir / document["html"]).read_text(), "lxml"
        ).find("article")
        section.append(standalone.extract())
        soup.body.append(section)
    path = output_dir / "combined.html"
    path.write_text(str(soup))
    return path


def build_document(args, selection, document):
    fragments = []
    provenance = []
    checks = []
    for source_page in document["pages"]:
        page = copy.deepcopy(source_page)
        choice, artifact, fragment = selected_fragment(ROOT, selection, document, page)
        page["selected_model"] = choice["model"]
        fragments.append((page, fragment))
        provenance.append({
            "page_index": page["index"], "model": choice["model"],
            "artifact": str(artifact.relative_to(ROOT)),
            "replacements": choice.get("replacements", {}),
            "operations": choice.get("operations", []),
        })
        checks.append(score_fragment(document, page, fragment))
    html = outputs.canonical_document(document, fragments)
    html_path, derivative = write_derivatives(args.output_dir, document, html)
    return {
        "document_id": document["id"], "profile": document["profile"],
        "html": str(html_path.relative_to(args.output_dir)),
        "derivative": str(derivative.relative_to(args.output_dir)),
        "provenance": provenance, "checks": checks,
    }


def main():
    args = parse_args()
    manifest = json.loads(args.manifest.read_text())
    selection = json.loads(args.selection.read_text())
    for directory in ("html", "xlsx", "markdown"):
        (args.output_dir / directory).mkdir(parents=True, exist_ok=True)
    documents = [build_document(args, selection, document) for document in manifest["documents"]]
    combined_html = write_combined_html(args.output_dir, manifest, documents)
    checks = [check for document in documents for check in document["checks"]]
    index = {
        "suite_id": manifest["suite_id"], "selection_id": selection["selection_id"],
        "source_of_truth": "html", "combined_html": str(combined_html.relative_to(args.output_dir)),
        "documents": documents,
        "structural_summary": {
            "pages": len(checks),
            "passed": sum(check["passed_structural_checks"] for check in checks),
            "failed": sum(not check["passed_structural_checks"] for check in checks),
        },
        "audit_status": "Targeted visual audit and automated topology checks; not a full cell-by-cell human reference.",
    }
    (args.output_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(index["structural_summary"]))


if __name__ == "__main__":
    main()
