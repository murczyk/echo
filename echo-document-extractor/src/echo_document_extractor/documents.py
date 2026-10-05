"""Native attachment extraction. Source locations survive every projection."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import subprocess
import tempfile
import zipfile
from dataclasses import asdict, dataclass, field
from html import escape
from pathlib import Path, PurePosixPath

from lxml import etree, html

MAX_CHARS = 20_000_000
CHUNK_CHARS = 12_000
MAX_MEMBERS = 1_000
MAX_EXPANDED_BYTES = 1024**3
MAX_INPUT_BYTES = 250 * 1024**2
MAX_ARCHIVE_DEPTH = 2
MAX_CELLS = 1_000_000
LEGACY = {
    ".doc": "docx",
    ".rtf": "docx",
    ".odt": "docx",
    ".xls": "xlsx",
    ".ods": "xlsx",
    ".ppt": "pptx",
    ".odp": "pptx",
}


@dataclass
class Section:
    member: str
    locator: str
    text: str
    html: str
    markdown: str


@dataclass
class Document:
    sections: list[Section] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    images: list[dict[str, str]] = field(default_factory=list)
    chars: int = 0
    expanded_bytes: int = 0
    members: int = 0

    def add(self, member: str, locator: str, text: str, markup: str | None = None) -> None:
        if not text.strip():
            return
        self.chars += len(text)
        if self.chars > MAX_CHARS:
            raise ValueError("document exceeds extracted text limit")
        # Row/paragraph locations are retained even when an unusually long cell is split.
        for offset in range(0, len(text), CHUNK_CHARS - 1000):
            part = text[offset : offset + CHUNK_CHARS]
            location = locator if offset == 0 else f"{locator}; character {offset}"
            self.sections.append(
                Section(
                    member,
                    location,
                    part,
                    markup if len(text) <= CHUNK_CHARS and markup else f"<p>{escape(part)}</p>",
                    part,
                )
            )
            if offset + CHUNK_CHARS >= len(text):
                break

    def write(self, directory: Path) -> None:
        self.sections = _pack_sections(self.sections)
        directory.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "sections": [asdict(section) for section in self.sections],
            "warnings": self.warnings,
            "images": self.images,
            "complete": not self.warnings and not self.images,
        }
        (directory / "document.json").write_text(json.dumps(payload, ensure_ascii=False))
        markup = "".join(
            f'<section data-source-page="{escape(s.locator, quote=True)}">'
            f"<h2>{escape(s.member)} — {escape(s.locator)}</h2>{s.html}</section>"
            for s in self.sections
        )
        (directory / "document.html").write_text(f"<article>{markup}</article>")
        (directory / "document.md").write_text(
            "\n\n".join(f"## {s.member} — {s.locator}\n\n{s.markdown}" for s in self.sections)
        )
        hashes = {
            p.relative_to(directory).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in directory.rglob("*")
            if p.is_file() and p.name != "manifest.json"
        }
        (directory / "manifest.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "format": "attachment_document_v1",
                    "file_hashes": hashes,
                    "status": "accepted" if payload["complete"] else "degraded",
                }
            )
        )


def _pack_sections(sections: list[Section]) -> list[Section]:
    packed: list[Section] = []
    for section in sections:
        if packed and packed[-1].member == section.member:
            previous = packed[-1]
            prefix = f"\n\n[{section.locator}]\n"
            if len(previous.text) + len(prefix) + len(section.text) <= CHUNK_CHARS:
                previous.text += prefix + section.text
                previous.markdown += f"\n\n### {section.locator}\n\n{section.markdown}"
                previous.html += f"<h3>{escape(section.locator)}</h3>{section.html}"
                previous.locator = previous.locator.split(" → ", 1)[0] + " → " + section.locator
                continue
        packed.append(Section(**asdict(section)))
    return packed


def decode_text(data: bytes) -> str:
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    if b"\0" in data:
        raise ValueError("binary content in text document")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("cp1251")


def extract(path: Path, output: Path) -> Document:
    document = Document()
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("attachment exceeds input limit")
    with tempfile.TemporaryDirectory(prefix="echo-native-") as temporary:
        _extract(path, path.name, document, Path(temporary), output, 0)
    document.write(output)
    return document


def _extract(path: Path, member: str, document: Document, temporary: Path, output: Path, depth: int) -> None:
    suffix = path.suffix.lower()
    if suffix in LEGACY:
        path = _convert(path, temporary, LEGACY[suffix])
        suffix = path.suffix.lower()
    if suffix in {".docx", ".xlsx", ".xlsm", ".pptx"}:
        _validate_office_archive(path)
    if suffix == ".docx":
        _word(path, member, document, output)
    elif suffix in {".xlsx", ".xlsm"}:
        _workbook(path, member, document)
    elif suffix == ".pptx":
        _slides(path, member, document, output)
    elif suffix in {".zip", ".rar", ".7z", ".kmz"}:
        _archive(path, member, document, temporary, output, depth)
    elif suffix in {".pdf", ".png", ".jpg", ".jpeg"}:
        _image(path.read_bytes(), member, "original", document, output, suffix)
    else:
        _text(path, member, document)


def _convert(path: Path, temporary: Path, extension: str) -> Path:
    destination = temporary / hashlib.sha256(str(path).encode()).hexdigest()
    destination.mkdir()
    profile = destination / "profile"
    profile.mkdir()
    (profile / "user").mkdir()
    (profile / "user/registrymodifications.xcu").write_text(
        '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">'
        '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
        '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
        '</item><item oor:path="/org.openoffice.Office.Calc/Content/Update">'
        '<prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>'
    )
    source_name = f"/work/source{path.suffix.lower()}"
    command = [
        "bwrap",
        "--die-with-parent",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-net",
        "--new-session",
        "--ro-bind",
        "/bin",
        "/bin",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--dir",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/work",
        "--ro-bind",
        str(path),
        source_name,
        "--bind",
        str(destination),
        "/work/output",
        "--setenv",
        "HOME",
        "/work/output",
    ]
    command += ["--setenv", "LD_LIBRARY_PATH", "/usr/lib/libreoffice/program"]
    for directory in (
        "/etc/fonts",
        "/etc/libreoffice",
        "/etc/ld.so.cache",
        "/var/cache/fontconfig",
        "/proc/version",
        "/proc/cpuinfo",
        "/proc/meminfo",
    ):
        command += ["--ro-bind-try", directory, directory]
    command += [
        "libreoffice",
        "-env:UserInstallation=file:///work/output/profile",
        "--headless",
        "--norestore",
        "--convert-to",
        extension,
        "--outdir",
        "/work/output",
        source_name,
    ]
    subprocess.run(command, check=True, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    converted = destination / f"source.{extension}"
    if not converted.is_file() or converted.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("Office conversion failed or exceeded input limit")
    return converted


def _word(path: Path, member: str, document: Document, output: Path) -> None:
    from docx import Document as WordDocument
    from docx.table import Table

    source = WordDocument(path)
    for index, block in enumerate(source.iter_inner_content(), 1):
        if isinstance(block, Table):
            _rows(
                [[cell.text for cell in row.cells] for row in block.rows], member, f"table {index}", document
            )
        else:
            document.add(member, f"paragraph {index}", block.text)
    for index, section in enumerate(source.sections, 1):
        for name, content in [("header", section.header), ("footer", section.footer)]:
            for paragraph in content.paragraphs:
                document.add(member, f"section {index} {name}", paragraph.text)
    for relationship in source.part.rels.values():
        if not relationship.is_external and "image" in relationship.reltype:
            part = relationship.target_part
            _image(part.blob, member, str(part.partname), document, output, Path(str(part.partname)).suffix)


def _rows(rows: list[list[str]], member: str, locator: str, document: Document) -> None:
    if sum(map(len, rows)) > MAX_CELLS:
        raise ValueError("table exceeds cell limit")
    header = rows[0] if rows else []
    for number, row in enumerate(rows, 1):
        text = " | ".join(
            f"{header[i] if number > 1 and i < len(header) else i + 1}: {value}"
            for i, value in enumerate(row)
        )
        markup = "<table><tr>" + "".join(f"<th>{escape(value)}</th>" for value in header)
        markup += "</tr><tr>" + "".join(f"<td>{escape(value)}</td>" for value in row) + "</tr></table>"
        document.add(member, f"{locator}; row {number}", text, markup)


def _workbook(path: Path, member: str, document: Document) -> None:
    from openpyxl import load_workbook
    from openpyxl.utils import get_column_letter

    formulas = load_workbook(path, read_only=True, data_only=False, keep_links=False)
    values = load_workbook(path, read_only=True, data_only=True, keep_links=False)
    cells = 0
    try:
        for sheet in formulas:
            cached = values[sheet.title]
            sheet.reset_dimensions()
            cached.reset_dimensions()
            for number, (row, cache) in enumerate(zip(sheet.rows, cached.rows, strict=True), 1):
                cells += len(row)
                if cells > MAX_CELLS:
                    raise ValueError("workbook exceeds cell limit")
                columns = []
                for index, (cell, value) in enumerate(zip(row, cache, strict=True), 1):
                    if cell.value is None:
                        continue
                    content = str(cell.value)
                    if cell.data_type == "f":
                        content = (
                            f"{content} [cached: {value.value if value.value is not None else 'unavailable'}]"
                        )
                    columns.append(f"{get_column_letter(index)}{number}: {content}")
                document.add(member, f"sheet {sheet.title}; row {number}", " | ".join(columns))
    finally:
        formulas.close()
        values.close()


def _slides(path: Path, member: str, document: Document, output: Path) -> None:
    from pptx import Presentation

    for index, slide in enumerate(Presentation(path).slides, 1):
        for number, shape in enumerate(slide.shapes, 1):
            locator = f"slide {index}; shape {number}"
            if shape.has_text_frame:
                document.add(member, locator, shape.text)
            if shape.has_table:
                _rows(
                    [[cell.text for cell in row.cells] for row in shape.table.rows], member, locator, document
                )
            if hasattr(shape, "image"):
                _image(shape.image.blob, member, locator, document, output, f".{shape.image.ext}")
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame
            if notes:
                document.add(member, f"slide {index}; notes", notes.text)


def _image(data: bytes, member: str, locator: str, document: Document, output: Path, suffix: str) -> None:
    digest = hashlib.sha256(data).hexdigest()
    name = f"assets/{digest}{suffix.lower()}"
    target = output / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_bytes(data)
    if len(document.images) >= MAX_MEMBERS:
        raise ValueError("embedded image limit")
    document.images.append({"member": member, "locator": locator, "path": name})


def _text(path: Path, member: str, document: Document) -> None:
    if path.suffix.lower() not in {
        ".txt",
        ".md",
        ".markdown",
        ".html",
        ".htm",
        ".csv",
        ".json",
        ".geojson",
        ".xml",
        ".kml",
        ".gpx",
    }:
        document.warnings.append(f"{member}: unsupported format")
        return
    text = decode_text(path.read_bytes())
    if path.suffix.lower() in {".html", ".htm", ".xml", ".kml", ".gpx"}:
        parser = (
            etree.XMLParser(resolve_entities=False, no_network=True)
            if path.suffix.lower() in {".xml", ".kml", ".gpx"}
            else html.HTMLParser(no_network=True)
        )
        root = etree.fromstring(text.encode(), parser)
        for element in root.xpath("//script|//style|//iframe|//object"):
            element.getparent().remove(element)
        text = "\n".join(root.itertext())
    elif path.suffix.lower() == ".csv":
        try:
            dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        _rows(list(csv.reader(io.StringIO(text), dialect)), member, "CSV", document)
        return
    for index, paragraph in enumerate(text.split("\n\n"), 1):
        document.add(member, f"section {index}", paragraph)


def _archive(path: Path, member: str, document: Document, temporary: Path, output: Path, depth: int) -> None:
    import libarchive

    if depth >= MAX_ARCHIVE_DEPTH:
        document.warnings.append(f"{member}: archive depth limit")
        return
    with libarchive.file_reader(str(path)) as archive:
        for entry in archive:
            document.members += 1
            if document.members > MAX_MEMBERS:
                document.warnings.append(f"{member}: archive member limit")
                return
            name = PurePosixPath(entry.pathname.replace("\\", "/"))
            if name.is_absolute() or ".." in name.parts or not entry.isfile:
                document.warnings.append(f"{member}: skipped unsafe/non-file member")
                continue
            target = temporary / f"member-{document.members}{name.suffix}"
            with target.open("xb") as destination:
                for block in entry.get_blocks():
                    document.expanded_bytes += len(block)
                    if (
                        document.expanded_bytes > MAX_EXPANDED_BYTES
                        or destination.tell() + len(block) > MAX_INPUT_BYTES
                    ):
                        raise ValueError("archive expanded size limit")
                    destination.write(block)
            try:
                _extract(target, f"{member}!/{name}", document, temporary, output, depth + 1)
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                document.warnings.append(f"{member}!/{name}: {type(error).__name__}")


def _validate_office_archive(path: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_MEMBERS or sum(entry.file_size for entry in entries) > MAX_EXPANDED_BYTES:
            raise ValueError("Office archive exceeds expanded size/member limit")
        if any(entry.flag_bits & 1 or entry.file_size > MAX_INPUT_BYTES for entry in entries):
            raise ValueError("encrypted or oversized Office member")


def load(directory: Path) -> Document:
    payload = json.loads((directory / "document.json").read_text())
    sections = [Section(**section) for section in payload["sections"]]
    return Document(
        sections=sections,
        warnings=payload["warnings"],
        images=payload["images"],
        chars=sum(len(section.text) for section in sections),
    )


def _run_isolated() -> None:
    import resource
    import sys

    from .native_sandbox import restrict_network

    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_EXPANDED_BYTES, MAX_EXPANDED_BYTES))
    restrict_network()
    extract(Path(sys.argv[1]), Path(sys.argv[2]))


if __name__ == "__main__":
    _run_isolated()
