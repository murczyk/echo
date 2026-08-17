#!/usr/bin/env python3

import argparse
import json
import pathlib
import re

import markdown
from bs4 import BeautifulSoup, NavigableString, Tag
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILL_COLORS = {"red": "FFFF0000", "yellow": "FFFFFF00", "gray": "FFD9D9D9", "grey": "FFD9D9D9"}
FONT_COLORS = {"red": "FFFF0000", "black": "FF000000", "blue": "FF0000FF", "white": "FFFFFFFF"}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=pathlib.Path, default=ROOT / "layout-suite-manifest.json")
    parser.add_argument("--input-dir", type=pathlib.Path, required=True)
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    return parser.parse_args()


def response_html(path):
    artifact = json.loads(path.read_text())
    text = artifact.get("answer")
    if not text:
        try:
            text = artifact["response"]["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exception:
            raise RuntimeError(f"missing response content in {path}") from exception
    if "</think>" in text:
        text = text.split("</think>", 1)[1]
    text = re.sub(r"^\s*<answer>|</answer>\s*$", "", text, flags=re.IGNORECASE).strip()
    text = text.strip().replace("<!-- END_OCR -->", "").strip()
    match = re.fullmatch(r"```(?:html)?\s*(.*?)\s*```", text, flags=re.DOTALL | re.IGNORECASE)
    text = match.group(1) if match else text
    if re.search(r"<article(?:\s|>)", text, flags=re.IGNORECASE):
        return text
    converted = markdown.markdown(text, extensions=["extra", "sane_lists"])
    return f'<article><section data-region="source-page">{converted}</section></article>'


def artifact_for(input_dir, document, page):
    candidates = sorted(input_dir.glob(f"{document['id']}__p{page['index']:02d}__*.json"))
    if len(candidates) != 1:
        raise RuntimeError(f"expected one artifact for {document['id']} page {page['index']}")
    return candidates[0]


def canonical_document(document, fragments):
    soup = BeautifulSoup("<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><title></title></head><body></body></html>", "lxml")
    soup.title.string = document["title"]
    article = soup.new_tag("article", attrs={"data-document-id": document["id"], "data-profile": document["profile"]})
    soup.body.append(article)
    for page, fragment in fragments:
        section = soup.new_tag("section", attrs={
            "data-source-page": str(page["index"]),
            "data-source-filename": page["filename"],
            "data-source-sha256": page["sha256"],
        })
        if page.get("selected_model"):
            section["data-source-model"] = page["selected_model"]
        parsed = BeautifulSoup(fragment, "lxml")
        source = parsed.find("article") or parsed.body or parsed
        for child in list(source.contents):
            section.append(child.extract())
        article.append(section)
    return str(soup)


def text_with_breaks(tag):
    for br in tag.find_all("br"):
        br.replace_with("\n")
    return tag.get_text(" ", strip=True).replace(" \n ", "\n")


def markdown_table(table):
    rows = []
    for row in table.find_all("tr"):
        cells = [text_with_breaks(cell).replace("|", "\\|").replace("\n", "<br>") for cell in row.find_all(["th", "td"], recursive=False)]
        if cells:
            rows.append(cells)
    if not rows:
        return ""
    width = max(map(len, rows))
    rows = [row + [""] * (width - len(row)) for row in rows]
    return "\n".join([
        "| " + " | ".join(rows[0]) + " |",
        "| " + " | ".join(["---"] * width) + " |",
        *("| " + " | ".join(row) + " |" for row in rows[1:]),
    ])


def node_markdown(node, depth=0):
    if isinstance(node, NavigableString):
        return str(node)
    if not isinstance(node, Tag):
        return ""
    if node.name == "br":
        return "\n"
    if node.name == "table":
        return "\n\n" + markdown_table(node) + "\n\n"
    content = "".join(node_markdown(child, depth + 1) for child in node.children).strip()
    if node.name in {"h1", "h2", "h3", "h4", "h5", "h6"}:
        return f"\n\n{'#' * int(node.name[1])} {content}\n\n"
    if node.name == "p":
        return f"\n\n{content}\n\n"
    if node.name == "li":
        return f"\n- {content}"
    if node.name in {"section", "article", "ul", "ol", "div", "address", "header", "footer"}:
        return f"\n{content}\n"
    if node.name in {"strong", "b"}:
        return f"**{content}**"
    if node.name in {"em", "i"}:
        return f"*{content}*"
    return content


def html_to_markdown(html):
    soup = BeautifulSoup(html, "lxml")
    article = soup.find("article") or soup.body
    markdown = node_markdown(article)
    return re.sub(r"\n{3,}", "\n\n", markdown).strip() + "\n"


def next_free_column(occupied, row_index, start):
    column = start
    while (row_index, column) in occupied:
        column += 1
    return column


def cell_style(target, source):
    fill_name = source.get("data-fill", "").lower()
    font_name = source.get("data-font-color", "").lower()
    if not font_name:
        styled = source.find(style=re.compile(r"color\s*:\s*red", re.IGNORECASE))
        font_name = "red" if styled else ""
    if fill_name in FILL_COLORS:
        target.fill = PatternFill("solid", fgColor=FILL_COLORS[fill_name])
    target.font = Font(
        bold=source.get("data-bold", "").lower() == "true" or source.name == "th",
        color=FONT_COLORS.get(font_name),
    )
    target.alignment = Alignment(wrap_text=True, vertical="top")


def add_html_table(workbook, table, title):
    worksheet = workbook.create_sheet(title=title[:31])
    occupied = set()
    for row_index, row in enumerate(table.find_all("tr"), start=1):
        column = 1
        for source in row.find_all(["th", "td"], recursive=False):
            column = next_free_column(occupied, row_index, column)
            rowspan = max(1, int(source.get("rowspan", 1)))
            colspan = max(1, int(source.get("colspan", 1)))
            target = worksheet.cell(row_index, column, text_with_breaks(source))
            cell_style(target, source)
            for occupied_row in range(row_index, row_index + rowspan):
                for occupied_column in range(column, column + colspan):
                    occupied.add((occupied_row, occupied_column))
            if rowspan > 1 or colspan > 1:
                worksheet.merge_cells(
                    start_row=row_index,
                    start_column=column,
                    end_row=row_index + rowspan - 1,
                    end_column=column + colspan - 1,
                )
            column += colspan
    worksheet.freeze_panes = "A2"
    for column in range(1, worksheet.max_column + 1):
        width = max((len(str(worksheet.cell(row, column).value or "")) for row in range(1, worksheet.max_row + 1)), default=0)
        worksheet.column_dimensions[get_column_letter(column)].width = min(max(width + 2, 8), 60)


def html_to_xlsx(html, output_path):
    soup = BeautifulSoup(html, "lxml")
    workbook = Workbook()
    workbook.remove(workbook.active)
    for page_index, page in enumerate(soup.select("section[data-source-page]"), start=1):
        for table_index, table in enumerate(page.find_all("table"), start=1):
            add_html_table(workbook, table, f"p{page_index:02d}_t{table_index:02d}")
    if not workbook.worksheets:
        workbook.create_sheet("no_tables")
    workbook.save(output_path)


def build_document(args, document):
    fragments = []
    sources = []
    for page in document["pages"]:
        artifact = artifact_for(args.input_dir, document, page)
        fragments.append((page, response_html(artifact)))
        sources.append(artifact.name)
    html = canonical_document(document, fragments)
    html_path = args.output_dir / "html" / f"{document['id']}.html"
    html_path.write_text(html)
    derivative = None
    if document["profile"] == "table":
        derivative = args.output_dir / "xlsx" / f"{document['id']}.xlsx"
        html_to_xlsx(html, derivative)
    else:
        derivative = args.output_dir / "markdown" / f"{document['id']}.md"
        derivative.write_text(html_to_markdown(html))
    return {"document_id": document["id"], "profile": document["profile"], "html": str(html_path.relative_to(args.output_dir)), "derivative": str(derivative.relative_to(args.output_dir)), "artifacts": sources}


def main():
    args = parse_args()
    manifest = json.loads(args.manifest.read_text())
    for directory in ("html", "xlsx", "markdown"):
        (args.output_dir / directory).mkdir(parents=True, exist_ok=True)
    outputs = [build_document(args, document) for document in manifest["documents"]]
    index = {
        "suite_id": manifest["suite_id"],
        "source_of_truth": "html",
        "notes": [
            "XLSX and Markdown files are generated derivatives of canonical HTML.",
            "Each XLSX source page/table has a separate worksheet to avoid inventing cross-page joins.",
        ],
        "outputs": outputs,
    }
    (args.output_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
