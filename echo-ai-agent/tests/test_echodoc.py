import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PYTHON_ROOT = ROOT / 'echo-ai-agent/template/python'
sys.path.insert(0, str(PYTHON_ROOT))

try:
    import docx
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt
except ImportError:  # the template installs python3-docx; CI hosts may not
    docx = None

if docx is not None:
    import echodoc
    from echodoc import state


def report():
    """A small report: title, a paragraph with split runs, a list item, a
    table with a header, two data rows and a totals row, and a header."""
    document = docx.Document()
    document.add_heading('Звіт за вересень 2026', 0)
    paragraph = document.add_paragraph()
    first = paragraph.add_run('Період: вере')
    first.bold = True
    first.font.size = Pt(14)
    paragraph.add_run('сень 2026').italic = True
    document.add_paragraph('перший пункт', style='List Bullet')
    table = document.add_table(rows=4, cols=3)
    table.style = 'Table Grid'
    for row, values in enumerate([['Дата', 'Подія', 'Кількість'], ['01.09', 'А', '1'], ['02.09', 'Б', '2'], ['Всього', '', '3']]):
        for column, value in enumerate(values):
            table.rows[row].cells[column].text = value
    data_run = table.rows[1].cells[1].paragraphs[0].runs[0]
    data_run.italic = True
    data_run.font.size = Pt(9)
    document.add_paragraph('Кінець звіту')
    document.sections[0].header.paragraphs[0].text = 'Для службового користування · вересень 2026'
    return document


def reopen(document, directory):
    path = Path(directory) / 'reopened.docx'
    document.save(str(path))
    return docx.Document(str(path))


@unittest.skipUnless(docx, 'python-docx is not installed')
class EditTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = directory.name

    def test_replace_across_runs_keeps_the_first_run_formatting(self):
        document = report()
        self.assertEqual(echodoc.replace_text(document, 'вересень 2026', 'жовтень 2026'), 3)
        document = reopen(document, self.directory)
        paragraph = echodoc.block(document, 1)
        self.assertEqual(paragraph.text, 'Період: жовтень 2026')
        changed = next(run for run in paragraph.runs if 'жовтень' in run.text)
        self.assertTrue(changed.bold)
        self.assertEqual(changed.font.size, Pt(14))
        self.assertEqual(echodoc.block(document, 0).text, 'Звіт за жовтень 2026')
        self.assertEqual(document.sections[0].header.paragraphs[0].text, 'Для службового користування · жовтень 2026')

    def test_replace_handles_several_matches_in_one_run_and_skips_headers_on_request(self):
        document = report()
        echodoc.set_text(echodoc.block(document, 4), 'X і X і X')
        self.assertEqual(echodoc.replace_text(document, 'X', 'Y', headers=False), 3)
        self.assertEqual(echodoc.block(document, 4).text, 'Y і Y і Y')
        self.assertEqual(echodoc.replace_text(document, 'вересень', 'жовтень', headers=False), 2)
        self.assertIn('вересень', document.sections[0].header.paragraphs[0].text)

    def test_set_text_keeps_paragraph_and_run_formatting(self):
        document = report()
        echodoc.set_text(echodoc.block(document, 1), 'Новий період\nдругий рядок')
        document = reopen(document, self.directory)
        paragraph = echodoc.block(document, 1)
        self.assertEqual(paragraph.text, 'Новий період\nдругий рядок')
        self.assertEqual(len(paragraph.runs), 1)
        self.assertTrue(paragraph.runs[0].bold)
        self.assertEqual(paragraph.runs[0].font.size, Pt(14))

    def test_set_text_on_a_cell_keeps_one_paragraph(self):
        document = report()
        table = echodoc.block(document, 3)
        cell = table.rows[1].cells[1]
        cell.add_paragraph('зайвий абзац')
        echodoc.set_text(cell, 'В')
        self.assertEqual(len(cell.paragraphs), 1)
        self.assertEqual(cell.text, 'В')
        self.assertTrue(cell.paragraphs[0].runs[0].italic)

    def test_fill_table_copies_the_template_row_and_keeps_the_totals_row(self):
        document = report()
        written = echodoc.fill_table(echodoc.block(document, 3), [
            ['03.10', 'Нова', 4],
            ['04.10', None],
            ['05.10', 'Третя', 6],
        ], header_rows=1, footer_rows=1)
        self.assertEqual(written, 3)
        document = reopen(document, self.directory)
        table = echodoc.block(document, 3)
        self.assertEqual([[cell.text for cell in row.cells] for row in table.rows], [
            ['Дата', 'Подія', 'Кількість'],
            ['03.10', 'Нова', '4'],
            ['04.10', '', ''],
            ['05.10', 'Третя', '6'],
            ['Всього', '', '3'],
        ])
        copied = table.rows[3].cells[1].paragraphs[0].runs[0]
        self.assertTrue(copied.italic)
        self.assertEqual(copied.font.size, Pt(9))

    def test_fill_table_rows_copied_from_a_repeating_header_do_not_repeat(self):
        document = echodoc.blank()
        table = document.add_table(rows=1, cols=2)
        table.rows[0].cells[0].text = 'Дата'
        table.rows[0]._tr.get_or_add_trPr().append(OxmlElement('w:tblHeader'))
        echodoc.fill_table(table, [['01.10', 'a'], ['02.10', 'b']])
        table = reopen(document, self.directory).tables[0]
        self.assertEqual([row._tr.trPr is not None and row._tr.trPr.find(qn('w:tblHeader')) is not None
                          for row in table.rows], [True, False, False])

    def test_fill_table_rejects_rows_wider_than_the_template(self):
        document = report()
        with self.assertRaisesRegex(ValueError, 'row 0 has 4 values but the template row has 3 cells'):
            echodoc.fill_table(echodoc.block(document, 3), [[1, 2, 3, 4]])

    def test_insert_paragraph_after_copies_formatting_but_not_content(self):
        document = report()
        new = echodoc.insert_paragraph_after(echodoc.block(document, 2), 'другий пункт')
        self.assertEqual(new.text, 'другий пункт')
        self.assertEqual(new.style.name, 'List Bullet')
        self.assertEqual([block['text'] for block in echodoc.outline(document)['blocks']][2:4], ['перший пункт', 'другий пункт'])
        after_table = echodoc.insert_paragraph_after(echodoc.block(document, 4), 'Після таблиці', like=echodoc.block(document, 5))
        self.assertEqual(echodoc.find(document, 'після таблиці'), [5])
        self.assertEqual(after_table.style.name, 'Normal')

    def test_copy_and_delete_blocks_shift_indices(self):
        document = report()
        self.assertEqual(echodoc.copy_blocks(document, 1, 2, 4), (5, 6))
        texts = [block['text'] for block in echodoc.outline(document)['blocks']]
        self.assertEqual(texts[5:7], ['Період: вересень 2026', 'перший пункт'])
        self.assertEqual(echodoc.copy_blocks(document, 0, 0, -1), (0, 0))
        self.assertEqual(echodoc.outline(document)['total'], 8)
        self.assertEqual(echodoc.delete_blocks(document, 0, 7), 8)
        self.assertEqual(echodoc.outline(document)['total'], 1)
        with self.assertRaises(IndexError):
            echodoc.copy_blocks(document, 0, 3, 0)


@unittest.skipUnless(docx, 'python-docx is not installed')
class OutlineTest(unittest.TestCase):
    def test_outline_renders_blocks_and_headers(self):
        text = echodoc.outline(report())['text'].splitlines()
        self.assertEqual(text[0], '[0] ¶ Title: Звіт за вересень 2026')
        self.assertEqual(text[2], '[2] • List Bullet (1): перший пункт')
        self.assertTrue(text[3].startswith('[3] ▦ table 4×3 (Table Grid): Дата | Подія | Кількість / 01.09 | А | 1 /'))
        self.assertEqual(text[-1], 'headers: «Для службового користування · вересень 2026»')

    def test_outline_pages_with_after(self):
        document = report()
        first = echodoc.outline(document, after=0, limit=2)
        self.assertEqual((first['total'], first['nextAfter']), (5, 2))
        self.assertTrue(first['text'].endswith('… 3 more blocks; continue with after=2'))
        last = echodoc.outline(document, after=4, limit=2)
        self.assertEqual([block['i'] for block in last['blocks']], [4])
        self.assertIsNone(last['nextAfter'])
        self.assertNotIn('headers:', last['text'])


@unittest.skipUnless(docx, 'python-docx is not installed')
class SaveTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.work = Path(directory.name)
        (self.work / 'sources').mkdir()
        report().save(str(self.work / 'sources/1.docx'))
        report().save(str(self.work / 'sources/2.docx'))
        (self.work / 'inputs.json').write_text(json.dumps({
            'mode': 'script',
            'maxOutputs': 2,
            'sources': [
                {'index': 1, 'path': 'sources/1.docx', 'kind': 'upload', 'uploadId': 'u-1', 'documentId': None,
                 'revision': None, 'title': 'Шаблон', 'fileName': 'template.docx'},
                {'index': 2, 'path': 'sources/2.docx', 'kind': 'document', 'uploadId': None, 'documentId': 'd-1',
                 'revision': 3, 'title': 'Звіт', 'fileName': 'zvit.docx'},
            ],
        }), encoding='utf-8')
        state.load(self.work)

    def test_save_records_new_documents_and_versions(self):
        from_template = echodoc.save(echodoc.open('template.docx'), summary='  перша   версія ')
        self.assertEqual({key: from_template[key] for key in ('path', 'source', 'documentId', 'title', 'summary')}, {
            'path': 'out/1.docx', 'source': 1, 'documentId': None, 'title': 'Шаблон', 'summary': 'перша версія',
        })
        self.assertTrue(from_template['outline'].startswith('[0] ¶ Title: Звіт за вересень 2026'))
        version = echodoc.save(echodoc.open(2), title='Звіт за жовтень')
        self.assertEqual((version['documentId'], version['title']), ('d-1', 'Звіт за жовтень'))
        self.assertTrue((self.work / 'out/2.docx').exists())
        with self.assertRaisesRegex(RuntimeError, 'at most 2 documents'):
            echodoc.save(echodoc.blank())

    def test_as_new_and_duplicate_saves(self):
        document = echodoc.open('d-1')
        self.assertIsNone(echodoc.save(document, as_new=True, title='Копія')['documentId'])
        self.assertIsNone(echodoc.save(document)['title'])
        state.reset()
        echodoc.save(document)
        with self.assertRaisesRegex(RuntimeError, 'already saved'):
            echodoc.save(document)

    def test_open_needs_a_known_source(self):
        with self.assertRaisesRegex(ValueError, 'pass which source'):
            echodoc.open()
        with self.assertRaisesRegex(LookupError, 'unknown source'):
            echodoc.open(5)
        (self.work / 'sources/1.docx').write_bytes(b'not a zip')
        with self.assertRaisesRegex(ValueError, 'template.docx is not a readable .docx file'):
            echodoc.open(1)

    def test_charts_are_inline_pictures(self):
        try:
            import matplotlib  # noqa: F401
        except ImportError:
            self.skipTest('matplotlib is not installed')
        document = echodoc.open(1)
        fig, ax = echodoc.figure(12, 6)
        ax.bar(['А', 'Б'], [1, 2])
        anchor = echodoc.insert_paragraph_after(echodoc.block(document, 4), '')
        echodoc.add_chart(anchor, fig, width_cm=12)
        self.assertEqual(echodoc.outline(document)['blocks'][5]['kind'], 'image')
        echodoc.save(document)


@unittest.skipUnless(docx, 'python-docx is not installed')
class RunEntryTest(unittest.TestCase):
    def run_entry(self, inputs, script=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        work = Path(directory.name)
        (work / 'sources').mkdir()
        (work / 'out').mkdir()
        report().save(str(work / 'sources/1.docx'))
        (work / 'inputs.json').write_text(json.dumps({
            'sources': [{'index': 1, 'path': 'sources/1.docx', 'kind': 'upload', 'uploadId': 'u-1',
                         'documentId': None, 'revision': None, 'title': 'Шаблон', 'fileName': 'template.docx'}],
            **inputs,
        }, ensure_ascii=False), encoding='utf-8')
        if script is not None:
            (work / 'script.py').write_text(script, encoding='utf-8')
        completed = subprocess.run(
            [sys.executable, '-I', '-B', '-X', 'utf8', str(PYTHON_ROOT / 'echodoc/run.py'), str(work)],
            capture_output=True, text=True, timeout=120, env={'PATH': '/usr/bin:/bin', 'HOME': str(work)},
            cwd=str(work))
        result = work / 'result.json'
        return completed, (json.loads(result.read_text(encoding='utf-8')) if result.exists() else None), work

    def test_outline_mode_runs_without_a_script(self):
        completed, result, _ = self.run_entry({'mode': 'outline', 'outline': {'source': 1, 'after': 3, 'limit': 1}})
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(result['outline']['text'], '[3] ▦ table 4×3 (Table Grid): Дата | Подія | Кількість / 01.09 | А | 1 / 02.09 | Б | 2\n… 1 more blocks; continue with after=4')
        self.assertEqual(result['outputs'], [])

    def test_script_mode_saves_outputs_and_logs(self):
        completed, result, work = self.run_entry({'mode': 'script'}, (
            'import echodoc\n'
            'doc = echodoc.open()\n'
            'echodoc.log("заміни:", echodoc.replace_text(doc, "вересень", "жовтень"))\n'
            'echodoc.save(doc, title="Звіт за жовтень")\n'
            'print("готово")\n'))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), 'готово')
        self.assertEqual(result['logs'], ['заміни: 3'])
        self.assertEqual(result['outputs'][0]['title'], 'Звіт за жовтень')
        self.assertEqual(docx.Document(str(work / 'out/1.docx')).paragraphs[0].text, 'Звіт за жовтень 2026')

    def test_script_errors_exit_1_without_a_result(self):
        completed, result, _ = self.run_entry({'mode': 'script'}, 'import echodoc\necho = echodoc.block(echodoc.open(), 99)\n')
        self.assertEqual(completed.returncode, 1)
        self.assertIn('IndexError: block 99 is outside 0..4', completed.stderr)
        self.assertIsNone(result)


if __name__ == '__main__':
    unittest.main()
