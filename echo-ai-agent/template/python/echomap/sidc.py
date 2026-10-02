"""APP-6(D) symbol identification codes (20-digit SIDC).

Layout: version(2) context(1) identity(1) symbol set(2) status(1)
HQ/task force/dummy(1) echelon or mobility(2) entity(6) modifier 1(2)
modifier 2(2).
"""

import json
import re
from functools import lru_cache
from pathlib import Path

CATALOG_FILE = Path(__file__).with_name("app6d-catalog.json")

_IDENTITY_NAMES = {
    "pending": "0", "очікує": "0",
    "unknown": "1", "невідомий": "1", "невідома": "1", "невідоме": "1",
    "assumed friend": "2", "ймовірно дружній": "2",
    "friend": "3", "friendly": "3", "дружній": "3", "дружня": "3", "дружнє": "3", "свої": "3", "наш": "3", "наші": "3",
    "neutral": "4", "нейтральний": "4", "нейтральна": "4",
    "suspect": "5", "підозрілий": "5", "ймовірно ворожий": "5",
    "hostile": "6", "enemy": "6", "ворожий": "6", "ворожа": "6", "вороже": "6", "противник": "6", "ворог": "6",
}
_STATUS_NAMES = {
    "present": "0", "наявний": "0",
    "planned": "1", "anticipated": "1", "запланований": "1", "ймовірний": "1",
    "capable": "2", "боєздатний": "2",
    "damaged": "3", "пошкоджений": "3",
    "destroyed": "4", "знищений": "4", "знищено": "4",
    "full": "5",
}
_HQ_NAMES = {"none": "0", "dummy": "1", "feint": "1", "hq": "2", "headquarters": "2", "штаб": "2", "task force": "4", "оперативна група": "4"}
_ECHELON_NAMES = {
    "team": "11", "crew": "11", "група": "11", "екіпаж": "11", "розрахунок": "11",
    "squad": "12", "відділення": "12",
    "section": "13", "секція": "13",
    "platoon": "14", "взвод": "14",
    "company": "15", "battery": "15", "рота": "15", "батарея": "15",
    "battalion": "16", "батальйон": "16", "дивізіон": "16",
    "regiment": "17", "полк": "17",
    "brigade": "18", "бригада": "18",
    "division": "21", "дивізія": "21",
    "corps": "22", "корпус": "22",
    "army": "23", "армія": "23",
}
_WORD = re.compile(r"[\w'’ʼ-]+", re.UNICODE)


@lru_cache(maxsize=1)
def catalog():
    return json.loads(CATALOG_FILE.read_text(encoding="utf-8"))


def _normalize(text):
    return " ".join(_WORD.findall((text or "").lower().replace("’", "'").replace("ʼ", "'")))


def _code(value, names, width, label):
    if value is None:
        return None
    text = str(value).strip().lower()
    if text.isdigit() and len(text) <= width:
        return text.zfill(width)
    if text in names:
        return names[text]
    raise ValueError(f"Unknown {label}: {value!r}; use one of {sorted(set(names))}")


def is_valid(code):
    return isinstance(code, str) and len(code) == 20 and code.isdigit()


def parts(code):
    """Splits a SIDC into named components."""
    if not is_valid(code):
        raise ValueError(f"SIDC must have 20 digits: {code!r}")
    return {
        "version": code[0:2], "context": code[2], "identity": code[3],
        "symbolSet": code[4:6], "status": code[6], "hq": code[7],
        "echelon": code[8:10], "entity": code[10:16],
        "modifier1": code[16:18], "modifier2": code[18:20],
    }


def build(symbol_set, entity, identity="unknown", status="present", hq="0",
          echelon="00", modifier1="00", modifier2="00", context="0"):
    """Assembles a SIDC from components; names such as identity="hostile"
    or echelon="взвод" are accepted."""
    code = "10{}{}{}{}{}{}{}{}{}".format(
        _code(context, {}, 1, "context"),
        _code(identity, _IDENTITY_NAMES, 1, "identity"),
        _code(symbol_set, {}, 2, "symbol set"),
        _code(status, _STATUS_NAMES, 1, "status"),
        _code(hq, _HQ_NAMES, 1, "hq"),
        _code(echelon, _ECHELON_NAMES, 2, "echelon"),
        _code(entity, {}, 6, "entity"),
        _code(modifier1, {}, 2, "modifier 1"),
        _code(modifier2, {}, 2, "modifier 2"),
    )
    assert is_valid(code), code
    return code


def set(code, identity=None, status=None, hq=None, echelon=None,
        symbol_set=None, entity=None, modifier1=None, modifier2=None):  # noqa: A001
    """Returns `code` with the given components replaced; others are kept."""
    current = parts(code)
    replacements = {
        "identity": _code(identity, _IDENTITY_NAMES, 1, "identity"),
        "status": _code(status, _STATUS_NAMES, 1, "status"),
        "hq": _code(hq, _HQ_NAMES, 1, "hq"),
        "echelon": _code(echelon, _ECHELON_NAMES, 2, "echelon"),
        "symbolSet": _code(symbol_set, {}, 2, "symbol set"),
        "entity": _code(entity, {}, 6, "entity"),
        "modifier1": _code(modifier1, {}, 2, "modifier 1"),
        "modifier2": _code(modifier2, {}, 2, "modifier 2"),
    }
    current.update({key: value for key, value in replacements.items() if value is not None})
    return "".join(current[key] for key in (
        "version", "context", "identity", "symbolSet", "status", "hq",
        "echelon", "entity", "modifier1", "modifier2"))


def retype(code, text):
    """Replaces the symbol type of `code` with the best alias match for
    `text`, keeping identity, status and echelon."""
    alias = match(text)
    if alias is None:
        raise LookupError(f"No APP-6D symbol matches {text!r}; try sidc.search()")
    return set(code, symbol_set=alias["symbolSet"], entity=alias["entity"],
               modifier1=alias["modifier1"], modifier2=alias["modifier2"],
               hq=alias["hq"] if alias["hq"] != "0" else None)


def match(text):
    """The Ukrainian alias whose longest term starts a word in `text`; ties go
    to the earliest occurrence."""
    normalized = " " + _normalize(text) + " "
    best = None
    for alias in catalog()["aliases"]:
        for term in alias["terms"]:
            needle = " " + _normalize(term)
            position = normalized.find(needle)
            if not needle.strip() or position < 0:
                continue
            score = (len(needle), -position)
            if best is None or score > best[0]:
                best = (score, alias)
    return best[1] if best else None


def find(text, identity="unknown", status="present", echelon="00", default=""):
    """A full SIDC for free text such as "ворожий танк" or "FPV дрон".
    Identity words in the text override `identity`. Returns `default` ("" lets
    Echo apply its standard symbol with a warning) when nothing matches."""
    alias = match(text)
    if alias is None:
        entity = _english_entity(text)
        if entity is None:
            return default
        symbol_set, entity_code, hq = entity[0], entity[1], "0"
        modifier1 = modifier2 = "00"
    else:
        symbol_set, entity_code, hq = alias["symbolSet"], alias["entity"], alias["hq"]
        modifier1, modifier2 = alias["modifier1"], alias["modifier2"]
    spoken = _identity_in(text)
    return build(symbol_set, entity_code, identity=spoken or identity, status=status,
                 hq=hq, echelon=echelon, modifier1=modifier1, modifier2=modifier2)


def _identity_in(text):
    words = " " + _normalize(text) + " "
    for name, code in sorted(_IDENTITY_NAMES.items(), key=lambda item: -len(item[0])):
        if " " + name + " " in words:
            return code
    return None


def _english_entity(text):
    query = _normalize(text)
    if not query:
        return None
    for symbol_set in catalog()["symbolSets"]:
        for entity in symbol_set["entities"]:
            if not _usable(entity):
                continue
            if query in (_normalize(entity["name"]), _normalize(entity.get("uk", ""))):
                return symbol_set["code"], entity["code"]
    return None


def _usable(entity):
    """Something can draw it: milsymbol, or Delta's exported icon."""
    return entity.get("drawable", True) or entity.get("deltaIcon", False)


def search(query, limit=10):
    """Catalog entries whose alias terms, Ukrainian labels or English names
    contain `query`: [(symbol set, entity, label)]."""
    needle = _normalize(query)
    results = []
    for alias in catalog()["aliases"]:
        haystack = _normalize(" ".join([alias["label"], alias["english"], *alias["terms"]]))
        if needle and needle in haystack:
            results.append((alias["symbolSet"], alias["entity"], f'{alias["label"]} ({alias["english"]})'))
    # Entities named like the query come before ones that only match a parent.
    ranked = []
    for symbol_set in catalog()["symbolSets"]:
        for entity in symbol_set["entities"]:
            if not needle or not _usable(entity):
                continue
            own = _normalize(" ".join([entity.get("uk", ""), entity["name"]]))
            names = _normalize(" ".join([*entity.get("ukPath", []), *entity["path"]]))
            if needle in own or needle in names:
                path = " / ".join(entity.get("ukPath") or entity["path"])
                ranked.append((0 if needle in own else 1, (symbol_set["code"], entity["code"], f'{symbol_set["uk"]}: {path}')))
    results.extend(item for _, item in sorted(ranked, key=lambda pair: pair[0]))
    unique = []
    for item in results:
        if item[:2] not in [seen[:2] for seen in unique]:
            unique.append(item)
    return unique[:limit]


def describe(code):
    """Human-readable Ukrainian/English description of a SIDC."""
    value = parts(code)
    data = catalog()
    identity = _label(data["identities"], value["identity"])
    symbol_set = next((item for item in data["symbolSets"] if item["code"] == value["symbolSet"]), None)
    entity = None
    if symbol_set:
        entity = next((item for item in symbol_set["entities"] if item["code"] == value["entity"]), None)
    pieces = [identity, symbol_set["uk"] if symbol_set else f"набір {value['symbolSet']}",
              " / ".join(entity.get("ukPath") or entity["path"]) if entity else f"сутність {value['entity']}"]
    if value["status"] != "0":
        pieces.append(_label(data["statuses"], value["status"]))
    if value["hq"] != "0":
        pieces.append(_label(data["hqTfDummy"], value["hq"]))
    if value["echelon"] != "00":
        pieces.append(_label(data["echelons"] + data["mobility"], value["echelon"]))
    return " · ".join(piece for piece in pieces if piece)


def _label(items, code):
    return next((item["uk"] for item in items if item["code"] == code), code)
