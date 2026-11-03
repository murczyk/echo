"""Helpers for agent-written document scripts (python-docx).

A script opens a source .docx (an uploaded template or an earlier version of
a conversation document), changes it while keeping its formatting, and saves
the result. Echo stores every save as a document or as its next version.
Block numbers are the ones `echo_document_outline` shows (`outline(doc)`).

    import echodoc
    doc = echodoc.open()                     # the only source; or open(1), open("<uploadId>")
    echodoc.replace_text(doc, "вересень 2026", "жовтень 2026")   # body, tables, headers
    echodoc.set_text(echodoc.block(doc, 4), "Підсумок: 12 подій за місяць.")
    echodoc.fill_table(echodoc.block(doc, 7), [
        ["01.10", "Подія А", 3],
        ["02.10", "Подія Б", 5],
    ], header_rows=1)
    echodoc.save(doc, title="Звіт за жовтень 2026", summary="Дані за жовтень")

A document opened from an earlier version is saved as its next version; pass
`as_new=True` to create a separate document instead. Use `log(...)` or print()
for notes the agent should see.
"""

from pathlib import Path

import docx

from . import ooxml, state
from .edit import (
    add_chart,
    copy_blocks,
    delete_blocks,
    figure,
    fill_table,
    insert_paragraph_after,
    replace_text,
    set_text,
)
from .outline import outline
from .state import inputs, log, sources

OUTPUT_OUTLINE_BLOCKS = 30
TITLE_MAX_CHARS = 200
SUMMARY_MAX_CHARS = 500

__all__ = [
    "add_chart",
    "blank",
    "block",
    "copy_blocks",
    "delete_blocks",
    "figure",
    "fill_table",
    "find",
    "inputs",
    "insert_paragraph_after",
    "log",
    "open",
    "outline",
    "replace_text",
    "save",
    "set_text",
    "sources",
]

# id(Document) -> (Document, source dict or None); the Document is kept alive
# so ids are never reused during a script.
_opened = {}


def _describe_sources():
    if not sources:
        return "no sources were passed to this script"
    return "; ".join(
        f"{source.get('index')}: {source.get('fileName') or source.get('title')} "
        f"({source.get('kind')} {source.get('documentId') or source.get('uploadId')})"
        for source in sources
    )


def _resolve(source):
    if source is None:
        if len(sources) != 1:
            raise ValueError(f"pass which source to open: {_describe_sources()}")
        return sources[0]
    for candidate in sources:
        if isinstance(source, int) and not isinstance(source, bool) and candidate.get("index") == source:
            return candidate
        if isinstance(source, str) and source in (
            candidate.get("uploadId"), candidate.get("documentId"), candidate.get("fileName"), candidate.get("title"),
        ):
            return candidate
    raise LookupError(f"unknown source {source!r}; available: {_describe_sources()}")


def open(source=None):  # noqa: A001 - the public name the agent is told to use
    """Opens a source .docx and returns a python-docx Document.

    `source` is the 1-based source number, an uploadId/documentId, or the file
    name; it may be omitted when the script has exactly one source.
    """
    resolved = _resolve(source)
    location = state.path(resolved.get("path") or "")
    try:
        document = docx.Document(str(location))
    except Exception as error:  # noqa: BLE001 - explain to the agent which file failed
        name = resolved.get("fileName") or resolved.get("title") or location.name
        raise ValueError(f"{name} is not a readable .docx file: {error}") from None
    _opened[id(document)] = (document, resolved)
    return document


def blank():
    """Returns a new empty document with Word's default styles
    ("Normal", "Title", "Heading 1".."Heading 9", "List Bullet", "Table Grid")."""
    document = docx.Document()
    _opened[id(document)] = (document, None)
    return document


def block(doc, index):
    """Returns block `index` of the outline: a Paragraph, a Table, or the raw
    element of a content control."""
    blocks = ooxml.body_blocks(doc)
    if not isinstance(index, int) or not 0 <= index < len(blocks):
        raise IndexError(f"block {index!r} is outside 0..{len(blocks) - 1}")
    return ooxml.wrap(blocks[index], doc._body)


def find(doc, text):
    """Indices of top-level blocks (paragraphs, tables, content controls)
    whose text contains `text` (case-insensitive)."""
    needle = str(text).casefold()
    return [index for index, element in enumerate(ooxml.body_blocks(doc)) if needle in ooxml.text_of(element).casefold()]


def _source_of(doc):
    entry = _opened.get(id(doc))
    return entry[1] if entry and entry[0] is doc else None


def _cut(value, limit):
    if value is None:
        return None
    value = " ".join(str(value).split())
    return value[:limit] or None


def save(doc, *, title=None, file_name=None, summary=None, as_new=False):
    """Saves `doc` for Echo and returns the output entry.

    A document opened from an earlier version of a conversation document is
    saved as that document's next version unless `as_new` is true; everything
    else becomes a new document titled `title` (default: the source title).
    `summary` is a short note shown in the version list. Each document can be
    saved once per script, and at most `inputs["maxOutputs"]` (default 4)
    files per script.
    """
    outputs = state.result()["outputs"]
    limit = state.max_outputs()
    if len(outputs) >= limit:
        raise RuntimeError(f"at most {limit} documents can be saved per script")
    source = _source_of(doc)
    document_id = None
    if source is not None and source.get("kind") == "document" and not as_new:
        document_id = source.get("documentId")
    if document_id and any(output["documentId"] == document_id for output in outputs):
        raise RuntimeError("this document is already saved in this script; save each document once")
    number = len(outputs) + 1
    relative = f"{state.OUTPUT_DIR}/{number}.docx"
    target = state.path(relative)
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(target))
    preview = outline(docx.Document(str(target)), 0, OUTPUT_OUTLINE_BLOCKS)["text"]
    output = {
        "path": relative,
        "source": source.get("index") if source else None,
        "documentId": document_id,
        "title": _cut(title, TITLE_MAX_CHARS) or (_cut(source.get("title"), TITLE_MAX_CHARS) if source else None) or "Документ",
        "fileName": _cut(file_name, TITLE_MAX_CHARS),
        "summary": _cut(summary, SUMMARY_MAX_CHARS),
        "outline": preview,
    }
    outputs.append(output)
    return dict(output)
