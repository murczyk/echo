import io
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from docx import Document as WordDocument
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches

from echo_document_extractor.documents import extract, load
from echo_document_extractor.package_archive import create_package_zip, validate_package_zip


def test_office_archive_preserves_names_formulas_notes_and_text(tmp_path: Path) -> None:
    word = WordDocument()
    word.add_paragraph("Позиція Береза 36UXV1234567890")
    table = word.add_table(rows=2, cols=2)
    table.cell(0, 0).text, table.cell(0, 1).text = "Назва", "Значення"
    table.cell(1, 0).text, table.cell(1, 1).text = "Сосна", "42"
    word.sections[0].footer.paragraphs[0].text = "Примітка до наказу"
    word.save(tmp_path / "order.docx")
    workbook = Workbook()
    workbook.active.title = "Позиції"
    workbook.active.append(["Імʼя", "Сума"])
    workbook.active.append(["Клен", "=2+3"])
    workbook.save(tmp_path / "points.xlsx")
    slides = Presentation()
    slide = slides.slides.add_slide(slides.slide_layouts[6])
    slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(2)).text = "Огляд позицій"
    slide.notes_slide.notes_text_frame.text = "Примітки доповідача"
    slides.save(tmp_path / "brief.pptx")
    source = tmp_path / "bundle.zip"
    with zipfile.ZipFile(source, "w") as archive:
        for name in ("order.docx", "points.xlsx", "brief.pptx"):
            archive.write(tmp_path / name, f"folder/{name}")
        archive.writestr("utf16.txt", "Координати Берези".encode("utf-16"))
        archive.writestr("../escape.txt", b"unsafe")
    output = tmp_path / "package"
    document = extract(source, output)
    text = "\n".join(section.text for section in document.sections)
    assert all(
        value in text
        for value in (
            "Береза",
            "Сосна",
            "Примітка до наказу",
            "B2: =2+3",
            "cached: unavailable",
            "Примітки доповідача",
            "Координати Берези",
        )
    )
    assert any(
        section.member == "bundle.zip!/folder/points.xlsx" and "sheet Позиції" in section.locator
        for section in document.sections
    )
    assert document.warnings and not (tmp_path / "escape.txt").exists()
    create_package_zip(output, tmp_path / "result.zip", native=True)
    validate_package_zip(tmp_path / "result.zip")


def test_native_process_extracts_csv_and_cannot_open_network_socket(tmp_path: Path) -> None:
    source = tmp_path / "notes.csv"
    source.write_text('Назва,Опис\nБереза,"рядок один\nрядок два"\n')
    output = tmp_path / "package"
    subprocess.run(
        [sys.executable, "-m", "echo_document_extractor.documents", str(source), str(output)], check=True
    )
    assert "рядок один\nрядок два" in "\n".join(section.text for section in load(output).sections)
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from echo_document_extractor.native_sandbox import restrict_network; "
            "import socket; restrict_network(); socket.socket(socket.AF_INET)",
        ],
        capture_output=True,
    )
    assert result.returncode != 0 and b"Operation not permitted" in result.stderr


def test_nested_archive_and_binary_text_are_explicitly_incomplete(tmp_path: Path) -> None:
    data = b"deep file"
    for _ in range(3):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("nested.zip", data)
        data = stream.getvalue()
    source = tmp_path / "nested.zip"
    source.write_bytes(data)
    document = extract(source, tmp_path / "nested-result")
    assert any("depth limit" in warning for warning in document.warnings)
    source = tmp_path / "binary.txt"
    source.write_bytes(b"abc\x00def")
    with pytest.raises(ValueError, match="binary"):
        extract(source, tmp_path / "binary-result")


def test_office_zip_bomb_is_rejected_before_parser(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from echo_document_extractor import documents

    monkeypatch.setattr(documents, "MAX_EXPANDED_BYTES", 100)
    source = tmp_path / "bomb.docx"
    with zipfile.ZipFile(source, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", "x" * 1000)
    with pytest.raises(ValueError, match="expanded size"):
        extract(source, tmp_path / "result")


def test_legacy_rtf_is_converted_in_filesystem_sandbox(tmp_path: Path) -> None:
    import shutil

    if not shutil.which("libreoffice"):
        pytest.skip("LibreOffice system package required")
    source = tmp_path / "legacy.rtf"
    source.write_bytes(b"{\\rtf1\\ansi Position BEREZA 36UXV1234567890}")
    output = tmp_path / "package"
    subprocess.run(
        [sys.executable, "-m", "echo_document_extractor.documents", str(source), str(output)], check=True
    )
    assert "BEREZA" in " ".join(section.text for section in load(output).sections)


def test_original_pdf_inspection_preserves_selected_page_3662(tmp_path: Path) -> None:
    from contextlib import closing

    import pypdfium2 as pdfium

    from echo_document_extractor.worker import _inspection_page

    path = tmp_path / "original.pdf"
    with closing(pdfium.PdfDocument.new()) as original:
        original.new_page(200, 300).close()
        original.new_page(400, 500).close()
        original.save(str(path))
    selected, offset = _inspection_page(path, tmp_path, {"inspection_locator": "page 2"})
    assert offset == 1
    with closing(pdfium.PdfDocument(str(selected))) as document:
        assert len(document) == 1
        with closing(document[0]) as page:
            assert page.get_size() == (400, 500)
    with pytest.raises(ValueError, match="outside"):
        _inspection_page(path, tmp_path, {"inspection_locator": "page 3"})
