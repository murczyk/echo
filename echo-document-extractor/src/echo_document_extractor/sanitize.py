from __future__ import annotations

import re

from lxml import etree, html

ALLOWED_TAGS = {
    "article",
    "section",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "ul",
    "ol",
    "li",
    "table",
    "caption",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "br",
    "figure",
    "figcaption",
}
UNSAFE_CONTENT_TAGS = {
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "svg",
    "math",
    "form",
    "input",
    "button",
    "link",
    "meta",
    "template",
}
ALLOWED_STYLE = {
    "text-align": {"left", "center", "right"},
    "vertical-align": {"top", "middle", "bottom"},
    "font-weight": {"bold", "700"},
    "font-style": {"italic"},
}
COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
NON_FATAL_SANITIZATION_REASONS = frozenset(
    {"malformed_table", "unsupported_style_removed", "unsupported_tag_removed"}
)


def has_fatal_sanitization_reason(reasons: list[str]) -> bool:
    return any(reason not in NON_FATAL_SANITIZATION_REASONS for reason in reasons)


def sanitize_candidate(value: str) -> tuple[str, list[str]]:
    reasons: list[str] = []
    value = re.sub(r"^```(?:html)?\s*|\s*```$", "", value.strip(), flags=re.IGNORECASE)
    try:
        fragments = html.fragments_fromstring(value)
    except (etree.ParserError, ValueError):
        return "", ["malformed_html"]
    root = html.Element("article")
    for fragment in fragments:
        if isinstance(fragment, str):
            if fragment.strip():
                paragraph = html.Element("p")
                paragraph.text = fragment
                root.append(paragraph)
        else:
            root.append(fragment)
    for element in list(root.iterdescendants()):
        tag = element.tag.casefold() if isinstance(element.tag, str) else ""
        if tag in UNSAFE_CONTENT_TAGS:
            element.drop_tree()
            reasons.append("unsafe_content_removed")
            continue
        if tag in {"img", "a"}:
            if element.get("src") or element.get("href"):
                reasons.append("external_or_invented_url")
            element.drop_tree() if tag == "img" else element.drop_tag()
            continue
        if tag not in ALLOWED_TAGS:
            element.drop_tag()
            reasons.append("unsupported_tag_removed")
            continue
        _sanitize_attributes(element, reasons)
        if tag in {"td", "th"}:
            for span in ("rowspan", "colspan"):
                if span in element.attrib and (
                    not element.attrib[span].isdigit() or not 1 <= int(element.attrib[span]) <= 10_000
                ):
                    reasons.append("invalid_span")
                    del element.attrib[span]
    text_nodes = [part for part in root.itertext()]
    if _has_whitespace_padding(text_nodes):
        reasons.append("whitespace_padding")
    text = "\n".join(text_nodes)
    if _has_repetition(text, root):
        reasons.append("repetition")
    if _malformed_table(root):
        reasons.append("malformed_table")
    markup = html.tostring(root, encoding="unicode", method="html")
    return markup, sorted(set(reasons))


def _sanitize_attributes(element: html.HtmlElement, reasons: list[str]) -> None:
    for attribute in list(element.attrib):
        value = element.attrib[attribute]
        if attribute in {"rowspan", "colspan"} and element.tag in {"td", "th"}:
            continue
        if attribute == "data-image" and element.tag in {"figure", "td", "th"} and value == "present":
            continue
        if attribute == "style":
            style = _safe_style(value)
            if style:
                element.attrib[attribute] = style
            else:
                del element.attrib[attribute]
            if style != value.strip().rstrip(";"):
                reasons.append("unsupported_style_removed")
            continue
        if attribute.casefold() in {"src", "href", "xlink:href"}:
            reasons.append("external_or_invented_url")
        del element.attrib[attribute]


def _safe_style(value: str) -> str:
    result = []
    for declaration in value.split(";"):
        if ":" not in declaration:
            continue
        name, raw = (part.strip().casefold() for part in declaration.split(":", 1))
        if name in ALLOWED_STYLE and raw in ALLOWED_STYLE[name]:
            result.append(f"{name}: {raw}")
        elif name in {"color", "background-color"} and COLOR_PATTERN.fullmatch(raw):
            result.append(f"{name}: {raw.upper()}")
    return "; ".join(result)


def _has_whitespace_padding(parts: list[str]) -> bool:
    meaningful = [part for part in parts if part.strip()]
    return any(
        (len(part) - len(part.lstrip()) >= 4 or len(part) - len(part.rstrip()) >= 4) and "\n" not in part[:4]
        for part in meaningful
    )


def _has_repetition(text: str, root: html.HtmlElement) -> bool:
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines() if line.strip()]
    if _has_consecutive_repeats(lines, 3, 20):
        return True
    tokens = re.findall(r"\w+|[^\w\s]", text.casefold(), flags=re.UNICODE)
    for size in (12, 8):
        for index in range(len(tokens) - size * 3 + 1):
            phrase = tokens[index : index + size]
            if (
                phrase
                == tokens[index + size : index + size * 2]
                == tokens[index + size * 2 : index + size * 3]
            ):
                return True
    rows = [re.sub(r"\s+", " ", " ".join(row.itertext())).strip() for row in root.xpath(".//tr")]
    return _has_consecutive_repeats(rows, 3, 20)


def _has_consecutive_repeats(values: list[str], count: int, minimum_length: int) -> bool:
    for index in range(len(values) - count + 1):
        value = values[index]
        if len(value) >= minimum_length and all(
            candidate == value for candidate in values[index + 1 : index + count]
        ):
            return True
    return False


def _malformed_table(root: html.HtmlElement) -> bool:
    for table in root.iter("table"):
        rows = table.xpath("./thead/tr|./tbody/tr|./tr")
        if not rows:
            return True
        occupied: set[tuple[int, int]] = set()
        row_widths = []
        for row_index, row in enumerate(rows):
            column = 0
            cells = row.xpath("./th|./td")
            if not cells:
                return True
            for cell in cells:
                while (row_index, column) in occupied:
                    column += 1
                try:
                    rowspan = int(cell.get("rowspan", "1"))
                    colspan = int(cell.get("colspan", "1"))
                except ValueError:
                    return True
                if rowspan * colspan > 10_000:
                    return True
                positions = {
                    (target_row, target_column)
                    for target_row in range(row_index, row_index + rowspan)
                    for target_column in range(column, column + colspan)
                }
                if occupied & positions:
                    return True
                occupied |= positions
                column += colspan
            while (row_index, column) in occupied:
                column += 1
            row_widths.append(column)
        expected = max(row_widths)
        if any(width != expected for width in row_widths):
            return True
        if any(row >= len(rows) for row, _ in occupied):
            return True
    return False
