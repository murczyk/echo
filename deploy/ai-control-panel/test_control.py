import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import control


class MaintenanceProtocolTests(unittest.TestCase):
    def test_empty_namespace_upgrade_uses_maintenance_protocol_and_verifies_template(self):
        row = {'host':'local', 'namespace':'echo-test', 'enabled':True, 'containers':[],
               'dispatcher':{}, 'template_id':'019fc7f7-9770-7f83-9c1a-211af29b02e6'}
        release = '2026.09.27.1'
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            helper = directory / 'echo-helper'
            requests = directory / 'requests.jsonl'
            helper.write_text('#!/usr/bin/env python3\n' + f'''
import json, sys
from pathlib import Path
row = {row!r}
if sys.argv[-1] == '--probe':
    print(json.dumps(row), flush=True)
    sys.exit(0)
assert sys.argv[-1] == '--maintenance'
print(json.dumps({{'ready':True, 'inventory':row, 'required_release':{release!r}}}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    with Path({str(requests)!r}).open('a') as output:
        output.write(line)
    print(json.dumps({{'ok':True}}), flush=True)
    if request['action'] == 'finish':
        break
''')
            helper.chmod(0o755)
            controller = control.Control(type('Options', (), {
                'repo':Path(__file__).resolve().parents[2], 'executable':helper, 'mode':'debug'})())
            journal = directory / 'journal.json'
            responses = {'replace':{'id':'echo-test-1','containers':[], 'orphans':[]},
                         'finish':{'states':[]}}
            with mock.patch.object(controller, 'journal_path', return_value=journal), \
                 mock.patch.object(controller, 'host_action', side_effect=lambda action, request, **kwargs:responses[action]), \
                 mock.patch.object(control, 'emit'):
                controller.upgrade_namespace(row, {'release':release}, True)
            commands = [json.loads(line)['action'] for line in requests.read_text().splitlines()]
            self.assertEqual(commands, ['begin', 'verify_template', 'finish'])
            self.assertEqual(json.loads(journal.read_text())['phase'], 'complete')


if __name__ == '__main__':
    unittest.main()
