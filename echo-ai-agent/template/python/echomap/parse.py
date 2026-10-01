"""Parsing helpers for semi-structured reports ("Key: value" tickets, tables).

They never repair values: coordinates and other fields are returned exactly as
written so Echo can normalize them and keep the original text.
"""

import re

_KEY_LINE = re.compile(r"^\s*([^:\n]{1,80}?)\s*:\s?(.*)$")
# Digit runs joined by single spaces or dashes ("52-15227", "65 48669"), with
# an optional leading sign kept as written.
_RUN = re.compile(r"(?<![\w.])[-+]?\d+(?:[ \-]\d+)*")
_COMPONENT_DIGITS = 7
_MIN_COMPONENT_DIGITS = 5
_DATE = re.compile(r"(\d{1,2})[./](\d{1,2})[./](\d{2,4})|(\d{4})-(\d{2})-(\d{2})")
_TIME = re.compile(r"(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?")


class Fields(dict):
    """Ordered "Key: value" fields with case-insensitive lookup."""

    def first(self, *names, default=""):
        lowered = {key.lower(): value for key, value in self.items()}
        for name in names:
            value = lowered.get(name.lower())
            if value:
                return value
        return default


def split(text, marker):
    """Splits text into blocks, each starting at a line that matches the
    `marker` regular expression. Returns [text] when nothing matches."""
    pattern = re.compile(marker, re.IGNORECASE)
    lines = text.splitlines(keepends=True)
    starts = [index for index, line in enumerate(lines) if pattern.search(line)]
    if not starts:
        return [text.strip()] if text.strip() else []
    starts[0] = 0 if not "".join(lines[: starts[0]]).strip() else starts[0]
    bounds = starts + [len(lines)]
    return [
        "".join(lines[start:end]).strip()
        for start, end in zip(bounds, bounds[1:])
        if "".join(lines[start:end]).strip()
    ]


def kv(block):
    """Parses "Key: value" lines. Lines without a key continue the previous
    value (e.g. a multi-line comment)."""
    fields = Fields()
    key = None
    for line in block.splitlines():
        match = _KEY_LINE.match(line)
        if match and not re.match(r"^\s*\[", line):
            key = match.group(1).strip()
            fields[key] = match.group(2).strip()
        elif key is not None and line.strip():
            fields[key] = (fields[key] + "\n" + line.strip()).strip()
    return fields


def _components(run):
    """Splits one run into coordinate components. A component closes once it
    holds seven digits, so "5215227 6548669" is two components while a
    malformed "52-15227" stays one."""
    components = []
    current = ""
    digits = 0
    for piece in re.findall(r"[-+]?\d+|[ \-]", run):
        if piece in (" ", "-"):
            if current:
                current += piece
            continue
        if digits >= _COMPONENT_DIGITS:
            components.append(current.rstrip(" -"))
            current, digits = "", 0
        current += piece
        digits += sum(ch.isdigit() for ch in piece)
    if current.rstrip(" -"):
        components.append(current.rstrip(" -"))
    return components


def pairs(text):
    """Every coordinate-like pair of numeric components, as written (signs,
    dashes and spaces inside a component are kept; nothing is repaired)."""
    components = [
        component
        for match in _RUN.finditer(text or "")
        for component in _components(match.group(0))
        if sum(ch.isdigit() for ch in component) >= _MIN_COMPONENT_DIGITS
    ]
    return [(components[i], components[i + 1]) for i in range(0, len(components) - 1, 2)]


def pair(text):
    """The first coordinate pair in text, or ("", "")."""
    found = pairs(text)
    return found[0] if found else ("", "")


def dt(date, time=None):
    """Combines a date (dd.mm.yyyy, dd.mm.yy or yyyy-mm-dd) and an optional
    time into Echo's YYYY-MM-DDTHH:MM:SS. A time without a date gives None."""
    match = _DATE.search(date or "")
    if not match:
        return None
    if match.group(4):
        year, month, day = match.group(4), match.group(5), match.group(6)
    else:
        day, month, year = match.group(1), match.group(2), match.group(3)
        if len(year) == 2:
            year = "20" + year
    clock = _TIME.search(time or "") if time else None
    hours, minutes, seconds = (
        (clock.group(1), clock.group(2), clock.group(3) or "00") if clock else ("0", "00", "00")
    )
    return f"{int(year):04d}-{int(month):02d}-{int(day):02d}T{int(hours):02d}:{minutes}:{seconds}"


def lines(text):
    """Non-empty stripped lines."""
    return [line.strip() for line in (text or "").splitlines() if line.strip()]
