"""Helpers for agent-written map scripts.

A script reads the request's source text, builds records or edits the open
map, and emits them. Echo validates, normalizes and projects everything the
script emits, exactly like records passed to the map tools directly.

    from echomap import inputs, parse, sidc, Record, emit_records
    for message in inputs.messages():
        for block in parse.split(message.text, r"Детали полета"):
            fields = parse.kv(block)
            x, y = parse.pair(fields.first("Координаты цели"))
            emit_records([Record(
                name=fields.first("Подразделение"), x=x, y=y,
                when=parse.dt(fields.first("Дата"), fields.first("Время")),
                comments=[block], source=message,
                sidc=sidc.find("доставка провізії", identity="friend"),
            )])

    from echomap import current_map, emit_patch
    m = current_map()
    for record in m.selected():
        record.sidc = sidc.set(record.sidc, identity="hostile")
    emit_patch(m, summary="Вибрані точки позначено ворожими")
"""

from . import inputs, parse, sidc
from .mapdoc import Map, MapRecord, current_map, emit_patch
from .records import Record, emit_records
from .state import log

__all__ = [
    "Map",
    "MapRecord",
    "Record",
    "current_map",
    "emit_patch",
    "emit_records",
    "inputs",
    "log",
    "parse",
    "sidc",
]
