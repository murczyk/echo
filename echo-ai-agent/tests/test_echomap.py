import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PYTHON_ROOT = ROOT / 'echo-ai-agent/template/python'
sys.path.insert(0, str(PYTHON_ROOT))

from echomap import Record, current_map, emit_patch, emit_records, parse, sidc, state  # noqa: E402

REPORT = """[25.09.2026 0:54] БПС 3 дшб: Детали полета
Подразделение: 104 дшд 328 дшп 3 дшб
Дата: 24.09.2026
Время: 18:03
Координаты цели: 5272881, 6679505
Комментарий:
328/24
Е5, выполнено
[25.09.2026 0:54] БПС 3 дшб: Детали полета
Подразделение: 104 дшд 328 дшп 3 дшб
Дата: 24.09.2026
Время: 18:15
Координаты цели: 5272881, 6679505
Комментарий:
328/24
"""


def with_inputs(inputs):
    directory = tempfile.TemporaryDirectory()
    Path(directory.name, 'inputs.json').write_text(json.dumps(inputs, ensure_ascii=False), encoding='utf-8')
    state.load(directory.name)
    return directory


class ParseTest(unittest.TestCase):
    def test_reports_split_into_fields_with_multiline_comments(self):
        blocks = parse.split(REPORT, r'Детали полета')
        self.assertEqual(len(blocks), 2)
        fields = parse.kv(blocks[0])
        self.assertEqual(fields.first('подразделение'), '104 дшд 328 дшп 3 дшб')
        self.assertEqual(fields.first('Комментарий'), '328/24\nЕ5, выполнено')
        self.assertEqual(parse.pair(fields.first('Координаты цели')), ('5272881', '6679505'))
        self.assertEqual(parse.dt(fields.first('Дата'), fields.first('Время')), '2026-09-24T18:03:00')
        self.assertEqual(parse.dt('24.09.26'), '2026-09-24T00:00:00')
        self.assertIsNone(parse.dt('', '18:03'))

    def test_pairs_keep_malformed_components_unrepaired(self):
        self.assertEqual(parse.pair('X 52-15227 Y 65 48669'), ('52-15227', '65 48669'))
        self.assertEqual(parse.pairs('5215227/6548669; 521522, 6548669'),
                         [('5215227', '6548669'), ('521522', '6548669')])
        self.assertEqual(parse.pairs('5215227 6548669 5214301 6549102'),
                         [('5215227', '6548669'), ('5214301', '6549102')])
        self.assertEqual(parse.pair('-5215227, 6548669'), ('-5215227', '6548669'))
        self.assertEqual(parse.pair('-5215227 6548669'), ('-5215227', '6548669'))
        self.assertEqual(parse.pair('Координаты цели: 5272881, 6679505'), ('5272881', '6679505'))


class SidcTest(unittest.TestCase):
    def test_aliases_choose_symbol_and_spoken_identity(self):
        self.assertEqual(sidc.find('ворожий танк'), '10061500001202000000')
        self.assertEqual(sidc.find('FPV дрон', identity='friend'), '10030100001103000000')
        self.assertEqual(sidc.find('БПС 3 дшб', identity='3', echelon='взвод'), '10031000141219000000')
        self.assertEqual(sidc.find('щось незрозуміле'), '')

    def test_set_and_retype_preserve_other_components(self):
        code = '10061000141211020000'
        self.assertEqual(sidc.set(code, identity='дружній'), '10031000141211020000')
        self.assertEqual(sidc.set(code, status='знищений', echelon='рота'), '10061040151211020000')
        self.assertEqual(sidc.retype(code, 'РСЗО'), '10061500141116000000')
        with self.assertRaises(ValueError):
            sidc.set(code, identity='союзник')

    def test_describe_and_search_use_the_generated_catalog(self):
        self.assertIn('Ворожий', sidc.describe('10061000141211020000'))
        self.assertIn('Infantry', sidc.describe('10061000141211020000'))
        self.assertIn('Взвод', sidc.describe('10061000141211020000'))
        self.assertTrue(any(entity == '120200' for _, entity, _ in sidc.search('tank')))

    def test_catalog_copies_are_identical(self):
        web = ROOT / 'wdintel-web/static/data/app6d-catalog.json'
        self.assertEqual(web.read_bytes(), sidc.CATALOG_FILE.read_bytes())


class RecordsAndPatchTest(unittest.TestCase):
    def test_records_reference_sources_and_split_long_comments(self):
        directory = with_inputs({'prompt': REPORT})
        self.addCleanup(directory.cleanup)
        source = {'messageId': 7, 'messageIdentifier': 'abc'}
        emit_records([Record(name='3 дшб', x='1', y='2', comments=['я' * 4500], source=source, sources=[source])])
        record = state.result()['records'][0]
        self.assertEqual([len(cell) for cell in record['comments']], [2000, 2000, 500])
        self.assertEqual(record['sources'], [source])
        with self.assertRaises(ValueError):
            emit_records([Record(name='bad', x='1', y='2', sidc='123')])

    def test_patch_groups_symbol_changes_and_keeps_other_edits_separate(self):
        records = [
            {'id': f'id-{index}', 'name': f'Точка {index}', 'sidc': '10061000001211020000',
             'coordinateSystem': 'msk2000', 'originalX': '5215227', 'originalY': '6548669', 'comments': []}
            for index in range(4)
        ]
        directory = with_inputs({'map': {'id': 'm', 'title': 'Мапа', 'records': records},
                                 'selectedPointIds': ['id-0', 'id-1']})
        self.addCleanup(directory.cleanup)
        edited = current_map()
        for record in edited.selected():
            record.sidc = sidc.set(record.sidc, identity='friend')
        edited.where(name='Точка 2')[0].name = 'Перейменована'
        edited.remove(edited.records[3])
        edited.title = 'Нова'
        emit_patch(edited, summary='Оновлено')
        operations = state.result()['operations']
        self.assertEqual([operation['op'] for operation in operations], ['setTitle', 'remove', 'setSidc', 'update'])
        self.assertEqual(operations[2]['selector']['ids'], ['id-0', 'id-1'])
        self.assertEqual(operations[3]['fields'], {'name': 'Перейменована'})
        self.assertEqual(state.result()['summary'], 'Оновлено')


class RunEntryTest(unittest.TestCase):
    def test_entry_runs_a_script_and_writes_the_result(self):
        with tempfile.TemporaryDirectory() as work:
            Path(work, 'inputs.json').write_text(json.dumps({'prompt': REPORT}, ensure_ascii=False), encoding='utf-8')
            Path(work, 'script.py').write_text(
                'from echomap import inputs, parse, Record, emit_records\n'
                'for block in parse.split(inputs.prompt(), "Детали полета"):\n'
                '    f = parse.kv(block)\n'
                '    x, y = parse.pair(f.first("Координаты цели"))\n'
                '    emit_records([Record(name=f.first("Подразделение"), x=x, y=y, comments=[block])])\n'
                'print("done")\n', encoding='utf-8')
            completed = subprocess.run(
                [sys.executable, '-I', '-B', str(PYTHON_ROOT / 'echomap/run.py'), work],
                capture_output=True, text=True, timeout=60, env={'PATH': '/usr/bin:/bin'})
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout.strip(), 'done')
            result = json.loads(Path(work, 'result.json').read_text(encoding='utf-8'))
            self.assertEqual(len(result['records']), 2)
            self.assertIn('Е5, выполнено', result['records'][0]['comments'][0])

    def test_entry_reports_script_errors_without_a_result(self):
        with tempfile.TemporaryDirectory() as work:
            Path(work, 'script.py').write_text('raise ValueError("broken")\n', encoding='utf-8')
            completed = subprocess.run(
                [sys.executable, '-I', '-B', str(PYTHON_ROOT / 'echomap/run.py'), work],
                capture_output=True, text=True, timeout=60, env={'PATH': '/usr/bin:/bin'})
            self.assertEqual(completed.returncode, 1)
            self.assertIn('ValueError: broken', completed.stderr)
            self.assertFalse(Path(work, 'result.json').exists())


if __name__ == '__main__':
    unittest.main()
