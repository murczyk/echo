"""Deterministic parsers for recurring report formats.

A recipe turns source text into map records without model-written code, so
small models only choose the recipe. Every source report becomes exactly one
record, in input order; reports without usable coordinates are kept (Echo
retains them as invalid CSV rows) and listed in `skipped` for the agent.
"""

import re
from datetime import datetime, timedelta, timezone

from . import inputs, parse, state
from . import sidc as sidc_codes
from .records import Record, emit_records

# A report header line: an optional «[date time] author:» prefix, then the
# format name ending the line. Comments that mention the format do not match.
FLIGHT_MARKER = r"^\s*(?:\[[^\]\n]*\][^\n:]*:\s*)?(?:Детали полета|Деталі польоту)\s*:?\s*$"
_NUMBER = re.compile(r"^\d+(?:-\w{1,3})?$")
_QUALIFIER = re.compile(r"^[^\s\d()]+\.$|^(гв|окр|окрема|окремий)$", re.IGNORECASE)
# Division and larger formations are omitted from record names.
_DIVISION_OR_LARGER = re.compile(
    r"^(\d+\s*)?(дшд|десд|пдд|вдд|мсд|омсд|мд|тд|сд|ад|гв\.?\s*\w*д|ак|ак\s*\w+|ок|арм\w*|корпус\w*|дивізі\w*|дивизи\w*)$",
    re.IGNORECASE,
)


def unit_name(unit):
    """«104 дшд 328 дшп 2 дшб» → «2 дшб 328 дшп»: smallest unit first, up to
    the regiment/brigade, without divisions or larger formations."""
    parts = [part for part in _designations(unit) if not _DIVISION_OR_LARGER.match(part) and _level(part) != 5]
    return " ".join(_smallest_first(parts))


def _word_level(word):
    """1 platoon/team … 4 regiment/brigade, 5 division or larger; None for a
    word that names no unit level."""
    word = word.lower().rstrip(".")
    if _DIVISION_OR_LARGER.match(word):
        return 5
    if "бр" in word or "полк" in word or "бригад" in word or word.endswith("п"):
        return 4
    if word.endswith("б") or word.endswith("дн") or word.startswith(("батальйон", "батальон", "дивізіон", "дивизион")):
        return 3
    if (word.endswith("р") and len(word) <= 5) or word.startswith(("рот", "батаре")):
        return 2
    if word.startswith(("взвод", "вз", "відділ", "отделен", "груп", "розрахун", "расчет", "екіпаж", "экипаж")):
        return 1
    return None


def _level(designation):
    """The level of a designation's last unit word, if any."""
    words = [word for word in re.sub(r"\([^)]*\)", "", designation).split() if not _NUMBER.match(word)]
    levels = [_word_level(word) for word in words]
    return next((level for level in reversed(levels) if level is not None), None)


def _smallest_first(parts):
    """Orders designations from the smallest unit to the regiment, whichever
    order the report lists them in."""
    levels = [_level(part) for part in parts]
    if all(level is not None for level in levels):
        return [part for _, part in sorted(zip(levels, parts), key=lambda item: item[0])]
    known = [level for level in levels if level is not None]
    largest_first = len(known) >= 2 and known[0] > known[-1]
    return list(reversed(parts)) if largest_first or len(known) < 2 else parts


def _designations(unit):
    """Splits «76 гв. дшд 104 гв. дшп ШР (В)» into complete designations.
    A designation is an optional number and qualifiers, any descriptive words,
    and a unit word (one with a known level); words without a level that
    follow a complete designation continue it («группа БПЛА»)."""
    designations, current = [], []
    for word in re.findall(r"\([^)]*\)|[^\s(),;]+", unit or ""):
        level = _word_level(word)
        if word.startswith("("):
            if current:
                current.append(word)
            elif designations:
                designations[-1] += f" {word}"
            else:
                designations.append(word)
        elif _NUMBER.match(word) or _QUALIFIER.match(word):
            current.append(word)
        elif current:
            current.append(word)
            if level is not None:
                designations.append(" ".join(current))
                current = []
        elif level is not None or not designations:
            designations.append(word)
        else:
            designations[-1] += f" {word}"
    if current:
        designations.append(" ".join(current))
    return designations


_REPORT_FIELDS = (
    "Подразделение", "Підрозділ", "Позывной", "Позивний", "Дата", "Время", "Час",
    "Координаты цели", "Координати цілі", "Координаты", "Координати",
    "Тип устройства", "Тип пристрою", "Результат полета", "Результат польоту",
)
_HEADER_DATE = re.compile(r"^\s*\[(\d{1,2}\.\d{1,2}\.\d{2,4})")


def _is_flight_report(block):
    """A report has its fields, not merely the format's name (an instruction
    such as «нанеси звіти «Детали полета»» is not a report)."""
    keys = {key.lower() for key in parse.kv(block)}
    return sum(field.lower() in keys for field in _REPORT_FIELDS) >= 2


def _kyiv_date(timestamp):
    """The Kyiv civil date of a UTC ISO timestamp (EET/EEST: UTC+3 from the
    last Sunday of March to the last Sunday of October, 01:00 UTC)."""
    moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(timezone.utc)

    def last_sunday(month):
        day = datetime(moment.year, month + 1, 1, 1, tzinfo=timezone.utc) - timedelta(days=1)
        return day - timedelta(days=(day.weekday() + 1) % 7)

    summer = last_sunday(3) <= moment < last_sunday(10)
    return (moment + timedelta(hours=3 if summer else 2)).strftime("%d.%m.%Y")


def _report_date(fields, block, source, posting_date=""):
    """Event date; otherwise the posting header's (this block's or the last
    one seen in the same text) or the message's Kyiv date."""
    date = fields.first("Дата")
    if date:
        return date
    header = _HEADER_DATE.match(block)
    if header:
        return header.group(1)
    if posting_date:
        return posting_date
    if source is not None and source.datetime:
        try:
            return _kyiv_date(source.datetime)
        except ValueError:
            return ""
    return ""


def _target_coordinates(value):
    """X and Y exactly as written: split at the explicit delimiter so
    malformed components (e.g. «5272881abc») reach Echo's validation intact;
    only undelimited pairs fall back to numeric extraction."""
    # Brackets around the whole pair are not part of either component.
    value = (value or "").strip().strip("()[]{}").strip()
    parts = [part.strip() for part in re.split(r"[,;/]", value, maxsplit=1)]
    if len(parts) == 2 and all(parts):
        return parts[0], parts[1]
    words = [word for word in (value or "").split() if re.search(r"\d", word)]
    if len(words) == 2 or any(re.search(r"[^\d\-]", word) for word in words[:2]):
        return (words + ["", ""])[0], (words + ["", ""])[1]
    x, y = parse.pair(value)
    if x and y:
        return x, y
    return (parts + ["", ""])[0], (parts + ["", ""])[1]


_HEADER_AUTHOR = re.compile(r"^\s*(?:\[[^\]\n]*\]\s*)?([^\n:\[\]]+?)\s*:\s*(?:\n\s*)?(?:Детали полета|Деталі польоту)", re.IGNORECASE)


def _header_unit(block):
    """Units named in the posting header («2 дшб 328 дшп: Детали полета»),
    used only when the report has no unit field. Only designations with a
    known unit level count, so a poster's name is never used."""
    header = _HEADER_AUTHOR.match(block)
    if not header:
        return ""
    parts = [part for part in _designations(header.group(1)) if _level(part) in (1, 2, 3, 4)]
    return " ".join(_smallest_first(parts))


_COMMENT_START = re.compile(r"^\s*(Комментарий|Коментар)\s*:", re.IGNORECASE | re.MULTILINE)


def _flight_record(block, source, default_sidc="", posting_date=""):
    # Structured fields come only from above the comment, so a comment quoting
    # another date or target cannot replace them; the whole block stays in
    # the record's comments.
    comment = _COMMENT_START.search(block)
    fields = parse.kv(block[: comment.start()] if comment else block)
    # Only the coordinate line; continuation lines belong to other prose.
    coordinates = fields.first("Координаты цели", "Координати цілі", "Координаты", "Координати").split("\n")[0]
    x, y = _target_coordinates(coordinates)
    # Callsigns name the operator, not the unit, so they are never used here.
    name = unit_name(fields.first("Подразделение", "Підрозділ")) or _header_unit(block)
    supplied = fields.first("SIDC", "APP6D", "APP-6D").replace(" ", "")
    sidc = supplied if len(supplied) == 20 and supplied.isdigit() else default_sidc
    record = Record(
        name=name or "Політ",
        sidc=sidc,
        x=x,
        y=y,
        when=parse.dt(_report_date(fields, block, source, posting_date), fields.first("Время", "Час")),
        comments=[block],
        source=source,
    )
    problem = None if x and y else "немає координат цілі"
    if supplied and sidc != supplied:
        problem = "некоректний SIDC у звіті"
    return record, problem


RECIPES = {
    "flight_reports": {
        "label": "Деталі польоту (БпЛА)",
        "marker": FLIGHT_MARKER,
        "record": _flight_record,
        "is_report": _is_flight_report,
    },
}


def _blocks(name, text):
    recipe = RECIPES[name]
    marker = re.compile(recipe["marker"], re.IGNORECASE)
    lines = (text or "").splitlines(keepends=True)
    header = re.compile(r"^\s*\[[^\]\n]*\][^\n]*:\s*$")
    # A posting header alone on the line before the marker belongs to the report.
    starts = [index - 1 if index > 0 and header.match(lines[index - 1]) else index
              for index, line in enumerate(lines) if marker.match(line)]
    bounds = list(zip(starts, starts[1:] + [len(lines)]))
    blocks = []
    for start, end in bounds:
        block = "".join(lines[start:end])
        if recipe["is_report"](block):
            blocks.append(block)
        elif blocks:
            # A marker line that is not followed by a report stays in the
            # previous report (e.g. inside its comment).
            blocks[-1] += block
    return [block.strip() for block in blocks]


def detect(texts=None):
    """{recipe: number of reports} over the prompt and retrieved messages."""
    texts = inputs.texts() if texts is None else texts
    counts = {}
    for name in RECIPES:
        total = sum(len(_blocks(name, text)) for text, _ in texts)
        if total:
            counts[name] = total
    return counts


def records(name=None, symbol=None):
    """The recipe's records without emitting them, for scripts that filter,
    rename or split reports: `emit_records([r for r in recipes.records() if ...])`."""
    return _parse(name, symbol)[1]


def _parse(name, symbol):
    detected = detect()
    if name is None:
        if not detected:
            raise LookupError("Жоден відомий формат звітів не знайдено; використайте echo_map_script.")
        name = max(detected, key=detected.get)
    if name not in RECIPES:
        raise LookupError(f"Невідомий рецепт {name!r}; доступні: {sorted(RECIPES)}")
    default_sidc = ""
    if symbol:
        default_sidc = symbol if len(symbol) == 20 and symbol.isdigit() else sidc_codes.find(symbol)
        if not default_sidc:
            raise LookupError(f"Не знайдено позначку для «{symbol}»")
    found, skipped = [], []
    for text, source in inputs.texts():
        posting_date = ""
        for block in _blocks(name, text):
            header = _HEADER_DATE.match(block)
            posting_date = header.group(1) if header else posting_date
            record, problem = RECIPES[name]["record"](block, source, default_sidc, posting_date)
            if problem:
                skipped.append({"index": len(found) + 1, "reason": problem})
            found.append(record)
    return name, found, skipped, detected


def run(name=None, symbol=None):
    """Emits one record per detected report and records the counts the runner
    uses to verify the published map. `symbol` (a SIDC or words such as
    «дружній БпЛА») applies to reports that do not supply their own SIDC."""
    name, records, skipped, detected = _parse(name, symbol)
    emit_records(records)
    state.result()["stats"] = {
        "recipe": name,
        "label": RECIPES[name]["label"],
        "sourceCount": detected.get(name, 0),
        "emittedCount": len(records),
        "skipped": skipped[:50],
    }
    return state.result()["stats"]
