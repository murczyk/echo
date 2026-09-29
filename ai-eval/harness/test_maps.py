"""#3064 regressions ensure grading rejects data loss and malformed map downloads."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import io
import zipfile
from unittest.mock import patch

import cli
from maps import grade_maps

ROOT = Path(__file__).resolve().parents[2]
BINARY = ROOT / 'target/debug/wdintel-rs'


def production(operation):
    result = subprocess.run([str(BINARY), '--mode', 'debug', 'ai-eval-maps'], input=json.dumps(operation),
                            text=True, capture_output=True, check=True, cwd=ROOT)
    return json.loads(result.stdout)


class MapDocumentGrading(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.case = next(case for case in json.loads((ROOT / 'ai-eval/2026-09-29-ai-maps/cases.json').read_text())
                        if case['id'] == 'batch-and-invalid')
        inputs = [{'sidc': row['sidc'], 'name': row['name'], 'observationDatetime': row['observationDatetime'],
                   'coordinateSystem': 'msk2000', 'x': row['originalX'], 'y': row['originalY'],
                   'comments': row['commentTokens'], 'sources': row['sources']} for row in cls.case['expect']['records']]
        records = []
        cls.events = []
        for offset in range(0, len(inputs), 16):
            batch = inputs[offset:offset + 16]
            records.extend(production({'operation': 'prepare', 'records': batch})['records'])
            cls.events.append({'type': 'eval_retrieval', 'path': '/api/ai-agent/maps/prepare', 'body': {'records': batch}})
        identifier = '11111111-1111-4111-8111-111111111111'
        document = {'id': identifier, 'title': 'Regression map', 'isMain': True, 'records': records,
                    'warnings': [], 'totalCount': 0, 'validCount': 0, 'invalidCount': 0}
        export = production({'operation': 'export', 'document': document})
        cls.events += [{'type': 'map_artifact', 'document': export['document']},
                       {'type': 'eval_map_export', 'id': identifier, **export},
                       {'type': 'eval_answer', 'text': f'[мапа](echo-map:{identifier})'}]

    def test_production_records_and_parsed_downloads_pass(self):
        self.assertEqual(grade_maps(self.case, self.events)['failures'], [])

    def test_incomplete_or_foreign_records_and_references_fail(self):
        events = copy.deepcopy(self.events)
        document = next(event['document'] for event in events if event['type'] == 'map_artifact')
        document['records'].pop()
        self.assertIn('record_completeness', grade_maps(self.case, events)['failures'])
        events[-1]['text'] = '[мапа](echo-map:invented)'
        self.assertIn('map_references', grade_maps(self.case, events)['failures'])
        document['records'][0]['sources'] = [{'messageId': 777, 'messageIdentifier': 'foreign'}]
        self.assertIn('source_citations', grade_maps(self.case, events)['failures'])

    def test_corrupted_csv_kmz_and_oversized_batches_fail(self):
        events = copy.deepcopy(self.events)
        export = next(event for event in events if event['type'] == 'eval_map_export')
        export['csv'] = '\n'.join(export['csv'].splitlines()[:-1])
        export['kmz'] = 'bm90IGEgemlw'
        events[0]['body']['records'] *= 2
        failures = grade_maps(self.case, events)['failures']
        self.assertIn('csv_structure', failures)
        self.assertIn('download_parse', failures)
        self.assertIn('batching', failures)

    def test_kmz_rejects_missing_or_unrenderable_embedded_icons(self):
        events = copy.deepcopy(self.events)
        export = next(event for event in events if event['type'] == 'eval_map_export')
        output = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(export['kmz']))) as original:
            with zipfile.ZipFile(output, 'w') as archive:
                for name in original.namelist():
                    archive.writestr(name, b'broken icon' if name.endswith('.png') else original.read(name))
        export['kmz'] = base64.b64encode(output.getvalue()).decode()
        self.assertIn('kmz_icon', grade_maps(self.case, events)['failures'])


class MapDatasetAvailability(unittest.TestCase):
    def test_development_runs_without_private_data_while_validation_and_corruption_fail_closed(self):
        source = (ROOT / 'ai-eval/2026-09-29-ai-maps/cases.json').read_bytes()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / 'ai-eval/maps'
            directory.mkdir(parents=True)
            (directory / 'cases.json').write_bytes(source)
            (root / 'ai-eval/catalog.json').write_text(json.dumps({'suites': [{'id': 'maps', 'runner': 'harness', 'path': 'ai-eval/maps'}]}))
            (directory / 'dataset.json').write_text(json.dumps({
                'schemaVersion': 1, 'caseFiles': ['cases.json', 'raw/private.json'],
                'artifacts': {'cases.json': hashlib.sha256(source).hexdigest(), 'raw/private.json': '0' * 64},
            }))
            with patch.object(cli, 'ROOT', root):
                self.assertEqual(len(cli.load_suite('maps', development_only=True)[2]), 3)
                with self.assertRaises(ValueError):
                    cli.load_suite('maps')
                (directory / 'cases.json').write_text('[]')
                with self.assertRaises(ValueError):
                    cli.load_suite('maps', development_only=True)


if __name__ == '__main__':
    unittest.main()
