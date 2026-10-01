"""New map records emitted by a script."""

from dataclasses import dataclass, field

from . import state
from .inputs import Message

MAX_COMMENT_CHARS = 2000
MAX_COMMENTS = 32
MAX_RECORDS = 512


def comment_cells(comments):
    """Splits long text into comment cells of at most 2000 characters,
    preferring line breaks; extra cells are merged into the last one."""
    if isinstance(comments, str):
        comments = [comments]
    cells = []
    for comment in comments or []:
        text = str(comment).strip()
        while len(text) > MAX_COMMENT_CHARS:
            cut = text.rfind("\n", 0, MAX_COMMENT_CHARS)
            cut = cut if cut > MAX_COMMENT_CHARS // 2 else MAX_COMMENT_CHARS
            cells.append(text[:cut].strip())
            text = text[cut:].strip()
        if text:
            cells.append(text)
    if len(cells) > MAX_COMMENTS:
        raise ValueError(f"A record allows {MAX_COMMENTS} comment cells of {MAX_COMMENT_CHARS} characters")
    return cells


def citation(source):
    if source is None:
        return None
    if isinstance(source, Message):
        return source.citation()
    return {"messageId": int(source["messageId"]), "messageIdentifier": str(source["messageIdentifier"])}


@dataclass
class Record:
    """One map point. Copy coordinates exactly as written; Echo normalizes
    and projects them and keeps invalid rows in CSV."""

    name: str
    x: str
    y: str
    crs: str = "msk2000"
    sidc: str = ""
    when: str | None = None
    comments: list = field(default_factory=list)
    source: object = None
    sources: list = field(default_factory=list)

    def to_input(self):
        if not str(self.name).strip():
            raise ValueError("Record name is required")
        if self.sidc and not (len(self.sidc) == 20 and self.sidc.isdigit()):
            raise ValueError(f"SIDC must have 20 digits: {self.sidc!r}")
        citations = [citation(item) for item in [self.source, *self.sources] if item is not None]
        return {
            "sidc": self.sidc or "",
            "name": str(self.name).strip(),
            "observationDatetime": self.when,
            "coordinateSystem": self.crs,
            "x": str(self.x).strip(),
            "y": str(self.y).strip(),
            "comments": comment_cells(self.comments),
            "sources": [item for index, item in enumerate(citations) if item not in citations[:index]],
        }


def emit_records(records):
    """Queues records for the map being built, in order."""
    queued = state.result()["records"]
    for record in records:
        queued.append(record.to_input() if isinstance(record, Record) else Record(**record).to_input())
    if len(queued) > MAX_RECORDS:
        raise ValueError(f"A map holds at most {MAX_RECORDS} records")
    return len(queued)
