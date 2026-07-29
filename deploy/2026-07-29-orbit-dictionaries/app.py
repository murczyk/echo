#!/usr/bin/env python3
import argparse
import json
import uuid
from pathlib import Path
from typing import Any


DICTIONARIES_FILE = Path("dictionaries.json")
DICTIONARY_FIELDS = (
    "grouping_of_forces",
    "combat_unit_type",
    "unit_echelon",
)

# Known source fields intentionally not collected yet:
# - unit_alternate_numbers: string of alternate unit numbers.
# - unit_alternate_names: comma-separated string of alternate unit names.
# - unit_name_original: original-language unit name string.


def stringify(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def require_entries(data: Any) -> list[dict[str, Any]]:
    if not isinstance(data, list):
        raise SystemExit("Data file must contain a JSON array of objects.")

    for index, entry in enumerate(data, start=1):
        if not isinstance(entry, dict):
            raise SystemExit(f"Entry {index} must be a JSON object.")

    return data


def format_path(path: list[str]) -> str:
    return "".join(path) or "$"


def iter_objects(node: Any, path: list[str]):
    if isinstance(node, dict):
        yield node, path
        for key, value in node.items():
            yield from iter_objects(value, [*path, f".{key}"])
    elif isinstance(node, list):
        for index, item in enumerate(node):
            yield from iter_objects(item, [*path, f"[{index}]"])


def normalize_dictionary_value(value: Any, value_path: str) -> list[dict[str, str]]:
    if value is None:
        return []

    values = value if isinstance(value, list) else [value]
    normalized: list[dict[str, str]] = []

    for index, item in enumerate(values):
        item_path = f"{value_path}[{index}]" if isinstance(value, list) else value_path
        if not isinstance(item, dict):
            raise SystemExit(
                f"{item_path} must be an object with key and name; "
                f"got {type(item).__name__}: {item!r}"
            )
        if "key" not in item or "name" not in item:
            raise SystemExit(f"{item_path} must contain key and name.")

        normalized.append({"key": stringify(item["key"]), "name": stringify(item["name"])})

    return normalized


def collect_dictionary_values(entries: list[dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
    collected: dict[str, list[dict[str, str]]] = {field: [] for field in DICTIONARY_FIELDS}
    seen: dict[str, set[tuple[str, str]]] = {field: set() for field in DICTIONARY_FIELDS}

    for index, entry in enumerate(entries):
        for node, path in iter_objects(entry, [f"$[{index}]"]):
            for field in DICTIONARY_FIELDS:
                if field not in node:
                    continue

                value_path = format_path([*path, f".{field}"])
                for value in normalize_dictionary_value(node[field], value_path):
                    value_key = (value["key"], value["name"])
                    if value_key in seen[field]:
                        continue

                    seen[field].add(value_key)
                    collected[field].append(value)

    return collected


def load_dictionaries(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {field: [] for field in DICTIONARY_FIELDS}

    dictionaries = read_json(path)
    if not isinstance(dictionaries, dict):
        raise SystemExit("dictionaries.json must contain a JSON object.")

    for field in DICTIONARY_FIELDS:
        dictionaries.setdefault(field, [])
        if not isinstance(dictionaries[field], list):
            raise SystemExit(f"dictionaries.json {field} must be an array.")

    return dictionaries


def normalize_existing_entries(dictionaries: dict[str, Any], field: str) -> set[tuple[str, str]]:
    existing: set[tuple[str, str]] = set()

    for index, entry in enumerate(dictionaries[field], start=1):
        if not isinstance(entry, dict):
            raise SystemExit(f"dictionaries.json {field} entry {index} must be an object.")
        if "key" not in entry or "name" not in entry:
            raise SystemExit(f"dictionaries.json {field} entry {index} must contain key and name.")
        if "id" not in entry:
            entry["id"] = str(uuid.uuid4())

        entry["key"] = stringify(entry["key"])
        entry["name"] = stringify(entry["name"])
        existing.add((entry["key"], entry["name"]))

    return existing


def merge_dictionary_values(
    dictionaries: dict[str, Any], collected: dict[str, list[dict[str, str]]]
) -> dict[str, int]:
    added_by_field: dict[str, int] = {}

    for field in DICTIONARY_FIELDS:
        existing = normalize_existing_entries(dictionaries, field)
        added = 0

        for value in collected[field]:
            value_key = (value["key"], value["name"])
            if value_key in existing:
                continue

            dictionaries[field].append(
                {
                    "id": str(uuid.uuid4()),
                    "key": value["key"],
                    "name": value["name"],
                }
            )
            existing.add(value_key)
            added += 1

        added_by_field[field] = added

    return added_by_field


def format_added_summary(added_by_field: dict[str, int]) -> str:
    return ", ".join(f"{field}: {added}" for field, added in added_by_field.items())


def main() -> None:
    parser = argparse.ArgumentParser(description="Collect ORBIT dictionaries.")
    parser.add_argument("data_file", type=Path, help="Path to a JSON data file.")
    args = parser.parse_args()

    entries = require_entries(read_json(args.data_file))
    dictionaries = load_dictionaries(DICTIONARIES_FILE)
    collected = collect_dictionary_values(entries)
    added_by_field = merge_dictionary_values(dictionaries, collected)
    write_json(DICTIONARIES_FILE, dictionaries)

    print(f"Wrote {DICTIONARIES_FILE} ({format_added_summary(added_by_field)}).")


if __name__ == "__main__":
    main()
