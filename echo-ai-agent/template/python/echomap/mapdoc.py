"""The map open for editing, and conversion of script changes to Echo patch
operations (one revision)."""

import copy

from . import sidc as sidc_codes
from . import state
from .records import Record, comment_cells

_EDITABLE = ("name", "sidc", "when", "comments", "crs", "x", "y")


class MapRecord:
    """An existing record. Assign name, sidc, when, comments, crs, x or y to
    change it; id, latitude, longitude, sources and warnings are read-only."""

    def __init__(self, raw, selected):
        self.id = raw["id"]
        self.latitude = raw.get("latitude")
        self.longitude = raw.get("longitude")
        self.sources = raw.get("sources", [])
        self.warnings = raw.get("warnings", [])
        self.selected = selected
        self.name = raw["name"]
        self.sidc = raw["sidc"]
        self.when = raw.get("observationDatetime")
        self.comments = list(raw.get("comments", []))
        self.crs = raw.get("coordinateSystem", "msk2000")
        self.x = raw.get("originalX", raw.get("x", ""))
        self.y = raw.get("originalY", raw.get("y", ""))
        self._original = {key: copy.deepcopy(getattr(self, key)) for key in _EDITABLE}

    @property
    def text(self):
        """Name and comments, for matching with `in` or regular expressions."""
        return "\n".join([self.name, *self.comments])

    def describe(self):
        return sidc_codes.describe(self.sidc)

    def changes(self):
        return {key: getattr(self, key) for key in _EDITABLE if getattr(self, key) != self._original[key]}

    def __repr__(self):
        return f"MapRecord({self.id[:8]}, {self.name!r}, {self.sidc})"


class Map:
    def __init__(self, document, selected_ids):
        self.id = document["id"]
        self.title = document["title"]
        self._title = document["title"]
        selected = set(selected_ids)
        self.records = [MapRecord(raw, raw["id"] in selected) for raw in document["records"]]
        self._ids = [record.id for record in self.records]
        self._added = []

    def selected(self):
        return [record for record in self.records if record.selected]

    def where(self, predicate=None, *, name=None, text=None, sidc=None, identity=None,
              symbol_set=None, entity=None, selected=None):
        """Records matching every given filter: name/text substrings
        (case-insensitive), exact sidc, SIDC components, selection."""
        found = []
        for record in self.records:
            parts = sidc_codes.parts(record.sidc)
            if name is not None and name.lower() not in record.name.lower():
                continue
            if text is not None and text.lower() not in record.text.lower():
                continue
            if sidc is not None and record.sidc != sidc:
                continue
            if identity is not None and parts["identity"] != sidc_codes.set(record.sidc, identity=identity)[3]:
                continue
            if symbol_set is not None and parts["symbolSet"] != str(symbol_set).zfill(2):
                continue
            if entity is not None and parts["entity"] != str(entity).zfill(6):
                continue
            if selected is not None and record.selected != selected:
                continue
            if predicate is not None and not predicate(record):
                continue
            found.append(record)
        return found

    def remove(self, *records):
        ids = {record.id if isinstance(record, MapRecord) else record for record in records}
        self.records = [record for record in self.records if record.id not in ids]

    def add(self, record):
        if not isinstance(record, Record):
            record = Record(**record)
        self._added.append(record)

    def operations(self):
        """Patch operations turning the loaded map into this one."""
        operations = []
        if self.title != self._title:
            operations.append({"op": "setTitle", "title": self.title})
        kept = {record.id for record in self.records}
        removed = [record_id for record_id in self._ids if record_id not in kept]
        if removed:
            operations.append({"op": "remove", "selector": {"ids": removed, "expect": "many"}})
        operations.extend(_update_operations(self.records))
        operations.extend({"op": "add", "record": record.to_input()} for record in self._added)
        return operations


def _update_operations(records):
    """Groups pure symbol changes by target SIDC; other changes become one
    update per record."""
    by_sidc = {}
    operations = []
    for record in records:
        changes = record.changes()
        if not changes:
            continue
        sidc = changes.pop("sidc", None)
        if not changes and sidc:
            by_sidc.setdefault(sidc, []).append(record.id)
            continue
        fields = {}
        if "name" in changes:
            fields["name"] = changes["name"]
        if "when" in changes:
            fields["observationDatetime"] = changes["when"]
        if "comments" in changes:
            fields["comments"] = comment_cells(changes["comments"])
        if "crs" in changes:
            fields["coordinateSystem"] = changes["crs"]
        for key in ("x", "y"):
            if key in changes:
                fields[key] = str(changes[key])
        operation = {"op": "update", "selector": {"ids": [record.id], "expect": "one"}, "fields": fields}
        if sidc:
            operation["sidc"] = sidc
        operations.append(operation)
    for sidc, ids in by_sidc.items():
        operations.insert(0, {"op": "setSidc", "selector": {"ids": ids, "expect": "many"}, "sidc": sidc})
    return operations


def current_map():
    """The map the user has open, with their selection."""
    document = state.inputs().get("map")
    if not document:
        raise RuntimeError("No map is open for editing in this request")
    return Map(document, state.inputs().get("selectedPointIds", []))


def emit_patch(edited, summary=None):
    """Queues the changes made to `edited` as one revision."""
    operations = edited.operations()
    state.result()["operations"] = operations
    if summary:
        state.result()["summary"] = str(summary)[:200]
    return len(operations)
