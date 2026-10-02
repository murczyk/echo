#!/usr/bin/env python3
"""Generate the APP-6(D) symbol catalog shared by the backend, the map UI and
the agent's `echomap` Python library.

Source tables: the MIT-licensed `stanag-app6` package by the author of
milsymbol (https://github.com/spatialillusions/stanag-app6). The tarball is
downloaded and checksum-verified unless `--tsv-dir` points at its
`tsv-tables/app6d` directory. Ukrainian aliases live beside this script.

Ukrainian names come from Delta's object-type dictionary
(`delta-object-types.json`, exported from oblik-os `delta_object_type`):
every entity Delta knows gets its Ukrainian name and path, and Delta-only
entities are added.

Usage: scripts/symbology/gen_app6d_catalog.py [--tsv-dir DIR]
"""

import argparse
import hashlib
import io
import json
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ALIASES = Path(__file__).with_name("app6d-aliases.uk.json")
DELTA = Path(__file__).with_name("delta-object-types.json")
# Delta's own icons for codes milsymbol cannot draw (copied from oblik-os
# front/public/sidc-symbols), named by base SIDC with unknown/hostile identity.
ICON_DIR = ROOT / "wdintel-web/static/img/google_earth_icons"
DELTA_ICON_MODULE = ROOT / "wdintel-web/src/ts/react/routes/ai-agent-chat/delta-icons.ts"
OUTPUTS = [
    ROOT / "wdintel-web/static/data/app6d-catalog.json",
    ROOT / "echo-ai-agent/template/python/echomap/app6d-catalog.json",
]
PACKAGE = "stanag-app6@0.2.0"
TARBALL_URL = "https://registry.npmjs.org/stanag-app6/-/stanag-app6-0.2.0.tgz"
TARBALL_SHA256 = "273639456637794367b5136ef2a47ba3528ab331ec9c4ae8e5a99dfc4564f2c7"

# (code, English name, Ukrainian name, main icon table, modifier tables)
SYMBOL_SETS = [
    ("01", "Air", "Повітряні об'єкти", "Air", "Air sector 1", "Air sector 2"),
    ("02", "Air missile", "Ракети", "Air missile", "Air missile sector 1", "Air missile sector 2"),
    ("05", "Space", "Космос", "Space", "Space sector 1", "Space sector 2"),
    ("10", "Land unit", "Сухопутні підрозділи", "Land unit", "Land unit sector 1", "Land unit sector 2"),
    ("11", "Land civilian", "Цивільні організації", "Land civilian", "Land civilian sector 1", "Land civilian sector 2"),
    ("15", "Land equipment", "Техніка й озброєння", "Land equipment", "Land equipment sector 1", None),
    ("20", "Land installation", "Об'єкти й споруди", "Land installation", "Land installation sector 1", "Land installation sector 2"),
    ("25", "Control measure", "Тактичні знаки (точки)", "Control Measures", None, None),
    ("27", "Dismounted individual", "Особи", "Dismounted individual", "Dismounted individual sector 1", "Dismounted individual sector 2"),
    ("30", "Sea surface", "Надводні об'єкти", "Sea surface", "Sea surface sector 1", "Sea surface sector 2"),
    ("35", "Sea subsurface", "Підводні об'єкти", "Sea subsurface", "Sea subsurface sector 1", "Sea subsurface sector 2"),
    ("36", "Mine warfare", "Морські міни", "Mine warfare", None, None),
    ("40", "Activities", "Події", "Activities", "Activities sector 1", None),
]

IDENTITIES = [
    ("0", "Pending", "Очікує ідентифікації"),
    ("1", "Unknown", "Невідомий"),
    ("2", "Assumed friend", "Ймовірно дружній"),
    ("3", "Friend", "Дружній"),
    ("4", "Neutral", "Нейтральний"),
    ("5", "Suspect", "Підозрілий"),
    ("6", "Hostile", "Ворожий"),
]
STATUSES = [
    ("0", "Present", "Наявний"),
    ("1", "Planned/anticipated", "Запланований / ймовірний"),
    ("2", "Present/fully capable", "Повністю боєздатний"),
    ("3", "Present/damaged", "Пошкоджений"),
    ("4", "Present/destroyed", "Знищений"),
    ("5", "Present/full to capacity", "Заповнений"),
]
HQ_TF_DUMMY = [
    ("0", "None", "Немає"),
    ("1", "Feint/dummy", "Хибний (макет)"),
    ("2", "Headquarters", "Штаб"),
    ("3", "Feint/dummy headquarters", "Хибний штаб"),
    ("4", "Task force", "Оперативна група"),
    ("5", "Feint/dummy task force", "Хибна оперативна група"),
    ("6", "Task force headquarters", "Штаб оперативної групи"),
    ("7", "Feint/dummy task force headquarters", "Хибний штаб оперативної групи"),
]
ECHELONS = [
    ("00", "Unspecified", "Не вказано"),
    ("11", "Team/crew", "Група / екіпаж"),
    ("12", "Squad", "Відділення"),
    ("13", "Section", "Секція"),
    ("14", "Platoon/detachment", "Взвод"),
    ("15", "Company/battery/troop", "Рота / батарея"),
    ("16", "Battalion/squadron", "Батальйон / дивізіон"),
    ("17", "Regiment/group", "Полк"),
    ("18", "Brigade", "Бригада"),
    ("21", "Division", "Дивізія"),
    ("22", "Corps", "Корпус"),
    ("23", "Army", "Армія"),
    ("24", "Army group/front", "Група армій / фронт"),
    ("25", "Region/theatre", "Театр воєнних дій"),
    ("26", "Command", "Командування"),
]
MOBILITY = [
    ("31", "Wheeled limited cross country", "Колісна (обмежена прохідність)"),
    ("32", "Wheeled cross country", "Колісна (висока прохідність)"),
    ("33", "Tracked", "Гусенична"),
    ("34", "Wheeled and tracked", "Колісно-гусенична"),
    ("35", "Towed", "Буксирувана"),
    ("36", "Rail", "Залізнична"),
    ("37", "Pack animals", "В'ючна"),
    ("41", "Over snow", "Снігова"),
    ("42", "Sled", "Сани"),
    ("51", "Barge", "Баржа"),
    ("52", "Amphibious", "Амфібія"),
]


def coded(rows):
    return [{"code": code, "name": name, "uk": uk} for code, name, uk in rows]


def load_tables(tsv_dir):
    if tsv_dir:
        root = Path(tsv_dir)
        return lambda name: (root / f"{name}.tsv").read_text(encoding="utf-8")
    with urllib.request.urlopen(TARBALL_URL, timeout=60) as response:
        data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != TARBALL_SHA256:
        sys.exit(f"{PACKAGE} checksum mismatch: {digest}")
    archive = tarfile.open(fileobj=io.BytesIO(data))

    def read(name):
        member = archive.getmember(f"package/tsv-tables/app6d/{name}.tsv")
        return archive.extractfile(member).read().decode("utf-8")

    return read


def rows(text):
    lines = [line for line in text.replace("\r", "").split("\n") if line.strip()]
    header = lines[0].split("\t")
    for line in lines[1:]:
        values = line.split("\t")
        yield {key: (values[i].strip() if i < len(values) else "") for i, key in enumerate(header)}


def main_icons(text):
    """Entities with their Entity/Type/Subtype path. Control measures keep
    only point symbols, the only geometry a point map can draw."""
    entity = entity_type = ""
    result = []
    for row in rows(text):
        geometry = row.get("Geometric Rendering")
        if row.get("Entity"):
            entity, entity_type = row["Entity"], ""
            path = [entity]
        elif row.get("Entity Type"):
            entity_type = row["Entity Type"]
            path = [entity, entity_type]
        else:
            path = [entity, entity_type, row.get("Entity Subtype", "")]
        code = row.get("Code", "")
        if len(code) != 6 or not code.isdigit():
            continue
        if geometry is not None and geometry != "Point":
            continue
        path = [part for part in path if part]
        result.append({"code": code, "name": path[-1], "path": path})
    return result


def modifiers(text):
    result = []
    for row in rows(text):
        name = next(iter(row.values()))
        code = row.get("Code", "")
        if len(code) == 2 and code.isdigit():
            result.append({"code": code, "name": name})
    return result


def build_symbol_sets(read):
    symbol_sets = []
    for code, name, uk, main, first, second in SYMBOL_SETS:
        symbol_sets.append(
            {
                "code": code,
                "name": name,
                "uk": uk,
                "entities": main_icons(read(main)),
                "modifier1": modifiers(read(first)) if first else [],
                "modifier2": modifiers(read(second)) if second else [],
            }
        )
    return symbol_sets


def merge_delta(symbol_sets):
    """Adds Delta's Ukrainian names and paths, and Delta-only entities."""
    by_set = {item["code"]: item for item in symbol_sets}
    for item in json.loads(DELTA.read_text(encoding="utf-8")):
        sidc = item["sidc"]
        set_code, entity_code = sidc[4:6], sidc[10:16]
        path_uk, path_en = item["pathUa"].split("|"), item["pathEn"].split("|")
        symbol_set = by_set.get(set_code)
        if symbol_set is None:
            symbol_set = {"code": set_code, "name": path_en[0], "uk": path_uk[0],
                          "entities": [], "modifier1": [], "modifier2": []}
            by_set[set_code] = symbol_set
            symbol_sets.append(symbol_set)
        entity = next((e for e in symbol_set["entities"] if e["code"] == entity_code), None)
        if entity is None:
            entity = {"code": entity_code, "name": path_en[-1], "path": path_en[1:] or path_en}
            symbol_set["entities"].append(entity)
        entity["uk"] = path_uk[-1]
        entity["ukPath"] = path_uk[1:] or path_uk
        entity["delta"] = True
    for symbol_set in symbol_sets:
        symbol_set["entities"].sort(key=lambda entity: entity["code"])
    symbol_sets.sort(key=lambda item: item["code"])
    return symbol_sets


def mark_undrawable(symbol_sets):
    """Marks entities the app's milsymbol cannot draw (`drawable: false`); the
    picker and `sidc.find` skip them. Requires wdintel-web's node_modules."""
    pairs = [[item["code"], entity["code"]] for item in symbol_sets for entity in item["entities"]]
    result = subprocess.run(
        ["node", str(Path(__file__).with_name("drawable.mjs"))],
        input=json.dumps(pairs), capture_output=True, text=True, check=True,
    )
    undrawable = {tuple(pair) for pair in json.loads(result.stdout)}
    icons = []
    for item in symbol_sets:
        for entity in item["entities"]:
            if (item["code"], entity["code"]) in undrawable:
                entity["drawable"] = False
                for identity in "16":
                    base = f"100{identity}{item['code']}0000{entity['code']}0000"
                    if (ICON_DIR / f"{base}.png").exists():
                        entity["deltaIcon"] = True
                        icons.append(base)
    write_icon_module(sorted(icons))
    return symbol_sets


def write_icon_module(icons):
    """The renderer needs the icon list synchronously, without the catalog."""
    lines = ",\n".join(f"  '{icon}'" for icon in icons)
    DELTA_ICON_MODULE.write_text(
        "// Generated by scripts/symbology/gen_app6d_catalog.py: base SIDCs with a\n"
        "// Delta icon in static/img/google_earth_icons (milsymbol cannot draw them).\n"
        f"export const DELTA_ICON_SIDCS: ReadonlySet<string> = new Set([\n{lines},\n]);\n",
        encoding="utf-8",
    )


def resolve_aliases(symbol_sets):
    by_set = {item["code"]: item for item in symbol_sets}
    aliases = json.loads(ALIASES.read_text(encoding="utf-8"))["aliases"]
    resolved = []
    for alias in aliases:
        symbol_set = by_set[alias["set"]]
        entity = next(e for e in symbol_set["entities"] if e["code"] == alias["entity"])
        for key in ("m1", "m2"):
            if key in alias:
                table = symbol_set["modifier1" if key == "m1" else "modifier2"]
                assert any(m["code"] == alias[key] for m in table), alias
        terms = [term.strip().lower() for term in alias["terms"]]
        assert all(terms), alias
        resolved.append(
            {
                "label": alias["label"],
                "terms": terms,
                "symbolSet": alias["set"],
                "entity": alias["entity"],
                "modifier1": alias.get("m1", "00"),
                "modifier2": alias.get("m2", "00"),
                "hq": alias.get("hq", "0"),
                "english": " / ".join(entity["path"]),
            }
        )
    return resolved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tsv-dir")
    args = parser.parse_args()
    symbol_sets = mark_undrawable(merge_delta(build_symbol_sets(load_tables(args.tsv_dir))))
    catalog = {
        "standard": "APP-6(D)",
        "version": "10",
        "source": f"{PACKAGE} (MIT, https://github.com/spatialillusions/stanag-app6)",
        "identities": coded(IDENTITIES),
        "statuses": coded(STATUSES),
        "hqTfDummy": coded(HQ_TF_DUMMY),
        "echelons": coded(ECHELONS),
        "mobility": coded(MOBILITY),
        "symbolSets": symbol_sets,
        "aliases": resolve_aliases(symbol_sets),
    }
    text = json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + "\n"
    for output in OUTPUTS:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8")
        print(f"wrote {output.relative_to(ROOT)} ({len(text.encode())} bytes)")


if __name__ == "__main__":
    main()
