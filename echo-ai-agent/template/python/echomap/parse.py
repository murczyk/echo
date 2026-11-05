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
_DEGREES = r"[-+]?\d{1,3}[.,]\d{3,}"
# Two decimal numbers side by side. Dates and times have shorter fractions.
_DEGREE_PAIR = re.compile(rf"(?<![\d.])({_DEGREES})\s*[,;/]?\s*({_DEGREES})(?!\d)")
# The region's WGS-84 box; other decimal pairs are not coordinates.
_LATITUDES = (40.0, 60.0)
_LONGITUDES = (20.0, 50.0)
# Ten digits complete a reference, and a time or date after it is another
# field. Any other following number stays with it: dropping «68848» from
# «7958 68848» would leave a valid reference to the wrong place, while Echo
# rejects the whole value as malformed.
_MGRS_DIGITS = r"\d{10,}|\d{2,9}(?:\s\d+(?![:.]\d))?"
# A two-digit zone, band and square. Cyrillic look-alikes must be uppercase and
# I/O never occur, so unit designations such as «1 мср 120» do not match.
_MGRS = re.compile(
    r"(?<![\w.])\d{2}\s?[C-HJ-NP-Xc-hj-np-xСЕНКМРТХ]\s?"
    rf"[A-HJ-NP-Za-hj-np-zАВСЕНКМРТХУЗ]{{2}}\s?(?:{_MGRS_DIGITS})(?![\w.])"
)


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
    pattern = re.compile(marker, re.IGNORECASE | re.MULTILINE)
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


def _in_region(latitude, longitude):
    return (
        _LATITUDES[0] <= float(latitude.replace(",", ".")) <= _LATITUDES[1]
        and _LONGITUDES[0] <= float(longitude.replace(",", ".")) <= _LONGITUDES[1]
    )


def mgrs(text):
    """Every MGRS reference in text, as written."""
    return [match.group(0) for match in _MGRS.finditer(text or "")]


def degrees(text):
    """Every WGS-84 (latitude, longitude) decimal pair in text, as written."""
    return [
        (match.group(1), match.group(2))
        for match in _DEGREE_PAIR.finditer(text or "")
        if _in_region(match.group(1), match.group(2))
    ]


def pairs(text):
    """Every position in text, as written and in order: (x, y) for a grid pair
    (signs, dashes and spaces inside a component are kept; nothing is
    repaired), (latitude, longitude) for WGS-84 decimal degrees and
    (reference, "") for MGRS."""
    found = []

    def take(match, position):
        found.append((match.start(), position))
        return " " * len(match.group(0))

    def take_degrees(match):
        if not _in_region(match.group(1), match.group(2)):
            return match.group(0)
        return take(match, (match.group(1), match.group(2)))

    rest = _MGRS.sub(lambda match: take(match, (match.group(0), "")), text or "")
    rest = _DEGREE_PAIR.sub(take_degrees, rest)
    components = [
        (match.start(), component)
        for match in _RUN.finditer(rest)
        for component in _components(match.group(0))
        if sum(ch.isdigit() for ch in component) >= _MIN_COMPONENT_DIGITS
    ]
    found += [
        (components[i][0], (components[i][1], components[i + 1][1]))
        for i in range(0, len(components) - 1, 2)
    ]
    return [position for _, position in sorted(found, key=lambda item: item[0])]


def pair(text):
    """The first position in text, or ("", "")."""
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
