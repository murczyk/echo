import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import control


class MaintenanceProtocolTests(unittest.TestCase):
    def test_empty_namespace_upgrade_uses_maintenance_protocol_and_verifies_template(self):
        row = {'host':'local', 'namespace':'echo-test', 'enabled':True, 'containers':[],
               'dispatcher':{'host':control.AGENT_HOSTNAME}, 'template_id':'019fc7f7-9770-7f83-9c1a-211af29b02e6'}
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
            self.assertEqual(json.loads(journal.read_text())['agent_host'], control.AGENT_HOST)


    def test_3572_verification_error_keeps_the_maintenance_channel_open_for_recovery(self):
        row = {'host': 'local', 'namespace': 'echo-test', 'enabled': True,
               'containers': [], 'dispatcher': {'host': control.AGENT_HOSTNAME}, 'template_id': 'fixture'}
        release = '2026.10.29.4'
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            helper = directory / 'helper'
            requests = directory / 'requests.jsonl'
            helper.write_text('#!/usr/bin/env python3\n' + f"""
import json,sys
from pathlib import Path
print(json.dumps({{'ready':True,'inventory':{row!r},'required_release':{release!r}}}),flush=True)
for line in sys.stdin:
    request=json.loads(line)
    with Path({str(requests)!r}).open('a') as out: out.write(line)
    if request['action']=='verify_template':
        print(json.dumps({{'ok':False,'error':'fixture bootstrap rejected'}}),flush=True)
    else:
        print(json.dumps({{'ok':True}}),flush=True)
    if request['action']=='finish': break
""")
            helper.chmod(0o755)
            controller = control.Control(type('Options', (), {
                'repo': Path(__file__).resolve().parents[2], 'executable': helper, 'mode': 'debug'})())
            responses = {'replace': {'id': 'fixture', 'containers': []},
                         'job': {'phase': 'verifying'},
                         'inventory': {'pending': [{'namespace': 'echo-test'}]},
                         'recover': {'states': [], 'release': release}}
            journal = directory / 'journal.json'
            with mock.patch.object(controller, 'journal_path', return_value=journal), \
                 mock.patch.object(controller, 'host_action', side_effect=lambda action, request=None, **kwargs: responses[action]), \
                 mock.patch.object(control, 'emit'):
                with self.assertRaisesRegex(RuntimeError, 'bootstrap rejected'):
                    controller.upgrade_namespace(row, {'release': release})
            commands = [json.loads(line) for line in requests.read_text().splitlines()]
            self.assertEqual([command['action'] for command in commands], ['begin', 'verify_template', 'finish'])
            self.assertTrue(commands[-1]['enabled'])
            self.assertEqual(json.loads(journal.read_text())['phase'], 'complete')


def maintenance_helper(directory, row, release, *, fail_verify=False):
    """Fake `wdintel-rs --maintenance` that records every command it receives."""
    helper = directory / 'helper'
    requests = directory / 'requests.jsonl'
    helper.write_text('#!/usr/bin/env python3\n' + f"""
import json,sys
from pathlib import Path
print(json.dumps({{'ready':True,'inventory':{row!r},'required_release':{release!r}}}),flush=True)
for line in sys.stdin:
    request=json.loads(line)
    with Path({str(requests)!r}).open('a') as out: out.write(line)
    if request['action']=='verify_template' and {fail_verify!r}:
        print(json.dumps({{'ok':False,'error':'fixture bootstrap rejected'}}),flush=True)
    else:
        print(json.dumps({{'ok':True}}),flush=True)
    if request['action']=='finish': break
""")
    helper.chmod(0o755)
    return helper, requests


def controller_for(helper):
    return control.Control(type('Options', (), {
        'repo': Path(__file__).resolve().parents[2], 'executable': helper, 'mode': 'debug'})())


class AiFlagAcrossFailedRolloutTests(unittest.TestCase):
    release = '2026.11.07.2'

    def row(self, enabled):
        return {'host': 'local', 'namespace': 'echo-test', 'enabled': enabled, 'containers': [],
                'dispatcher': {'host': control.AGENT_HOSTNAME}, 'template_id': 'fixture'}

    def run_upgrade(self, directory, journal, row, responses, fail_verify=False):
        run = directory / f'run-{len(list(directory.glob("run-*")))}'
        run.mkdir()
        helper, requests = maintenance_helper(run, row, self.release, fail_verify=fail_verify)
        controller = controller_for(helper)
        with mock.patch.object(controller, 'journal_path', return_value=journal), \
             mock.patch.object(controller, 'host_action', side_effect=lambda action, request=None, **kwargs: responses[action]), \
             mock.patch.object(control, 'emit'):
            try:
                controller.upgrade_namespace(row, {'release': self.release})
                error = None
            except RuntimeError as raised:
                error = raised
        return [json.loads(line) for line in requests.read_text().splitlines()], error

    def test_4077_retry_restores_ai_left_disabled_by_an_incompatible_recovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            journal = directory / 'journal.json'
            # First attempt: verification fails and recovery restores the old harness,
            # which the running Echo build does not support, so AI has to stay off.
            failing = {'replace': {'id': 'job-1', 'containers': []},
                       'job': {'phase': 'verifying'},
                       'inventory': {'pending': [{'namespace': 'echo-test'}]},
                       'recover': {'states': [], 'release': '2026.11.07.1'}}
            commands, error = self.run_upgrade(directory, journal, self.row(True), failing, fail_verify=True)
            self.assertFalse(commands[-1]['enabled'])
            self.assertIn('AI stays disabled', str(error))
            self.assertIn('bootstrap rejected', str(error))
            saved = json.loads(journal.read_text())
            self.assertEqual((saved['phase'], saved['pending_enable']), ('complete', True))

            # Retry: the server now reports AI off, but the saved flag wins.
            passing = {'replace': {'id': 'job-2', 'containers': []}, 'finish': {'states': []}}
            commands, error = self.run_upgrade(directory, journal, self.row(False), passing)
            self.assertIsNone(error)
            self.assertEqual([command['action'] for command in commands], ['begin', 'verify_template', 'finish'])
            self.assertTrue(commands[-1]['enabled'])
            saved = json.loads(journal.read_text())
            self.assertEqual((saved['phase'], saved['enabled'], saved['pending_enable']), ('complete', True, False))

            # Later upgrades keep an administrator's choice to leave AI off.
            commands, error = self.run_upgrade(directory, journal, self.row(False), passing)
            self.assertIsNone(error)
            self.assertFalse(commands[-1]['enabled'])

    def test_4077_aborted_retry_keeps_the_saved_flag(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            journal = directory / 'journal.json'
            journal.write_text(json.dumps({'phase': 'complete', 'namespace': 'echo-test', 'agent_host': control.AGENT_HOST,
                                           'enabled': True, 'pending_enable': True}))
            changed = dict(self.row(False), template_id='other')
            run = directory / 'run-0'
            run.mkdir()
            helper, requests = maintenance_helper(run, changed, self.release)
            controller = controller_for(helper)
            with mock.patch.object(controller, 'journal_path', return_value=journal), \
                 mock.patch.object(control, 'emit'):
                with self.assertRaisesRegex(RuntimeError, 'AI stays disabled'):
                    controller.upgrade_namespace(self.row(False), {'release': self.release})
            self.assertEqual([json.loads(line)['action'] for line in requests.read_text().splitlines()], ['abort'])
            saved = json.loads(journal.read_text())
            self.assertEqual((saved['phase'], saved['pending_enable']), ('complete', True))


    def test_4077_failure_before_replacement_keeps_ai_disabled_and_the_saved_flag(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            journal = directory / 'journal.json'
            journal.write_text(json.dumps({'phase': 'complete', 'namespace': 'echo-test', 'agent_host': control.AGENT_HOST,
                                           'enabled': True, 'pending_enable': True}))

            def replace_fails(action, request=None, **kwargs):
                if action == 'replace':
                    raise RuntimeError(control.LOCK_BUSY_ERROR)
                return {'pending': []}
            run = directory / 'run-0'
            run.mkdir()
            helper, requests = maintenance_helper(run, self.row(False), self.release)
            controller = controller_for(helper)
            with mock.patch.object(controller, 'journal_path', return_value=journal), \
                 mock.patch.object(controller, 'host_action', side_effect=replace_fails), \
                 mock.patch.object(control, 'emit'):
                with self.assertRaisesRegex(RuntimeError, 'AI stays disabled'):
                    controller.upgrade_namespace(self.row(False), {'release': self.release})
            commands = [json.loads(line) for line in requests.read_text().splitlines()]
            self.assertEqual([command['action'] for command in commands], ['begin', 'finish'])
            self.assertFalse(commands[-1]['enabled'])
            self.assertTrue(json.loads(journal.read_text())['pending_enable'])

    def test_4077_saved_flag_only_applies_to_its_own_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            journal = directory / 'journal.json'
            journal.write_text(json.dumps({'phase': 'complete', 'namespace': 'echo-elsewhere', 'agent_host': control.AGENT_HOST,
                                           'enabled': True, 'pending_enable': True}))
            passing = {'replace': {'id': 'job-1', 'containers': []}, 'finish': {'states': []}}
            commands, error = self.run_upgrade(directory, journal, self.row(False), passing)
            self.assertIsNone(error)
            self.assertFalse(commands[-1]['enabled'])

    def test_4077_recovering_an_interrupted_start_keeps_the_saved_flag(self):
        controller = controller_for(Path('/bin/true'))
        maintenance = mock.Mock(ready={'required_release': self.release})
        journal = {'namespace': 'echo-test', 'enabled': False, 'observed_enabled': False,
                   'pending_enable': True, 'phase': 'starting'}
        with mock.patch.object(controller, 'host_action', return_value={'pending': []}), \
             mock.patch.object(control, 'emit'):
            controller.restore_namespace(journal, maintenance)
        maintenance.call.assert_called_once_with({'action': 'finish', 'states': [], 'enabled': False})
        self.assertTrue(journal['pending_enable'])


class HostActionLockRetryTests(unittest.TestCase):
    busy = control.CommandError('busy', json.dumps({'error': control.LOCK_BUSY_ERROR}) + '\n')

    def controller(self):
        controller = controller_for(Path('/bin/true'))
        controller.agent_host = control.AGENT_HOST
        return controller

    def test_4077_busy_lock_is_retried_for_actions_that_lock_first(self):
        controller = self.controller()
        with mock.patch.object(control, 'command', side_effect=[self.busy, self.busy, '{"ok": true}']) as command, \
             mock.patch.object(control.time, 'sleep') as sleep, mock.patch.object(control, 'emit'):
            self.assertEqual(controller.host_action('container', {'action': 'stop'}), {'ok': True})
        self.assertEqual(command.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2, 5])

    def test_4077_retries_stop_after_the_budget(self):
        controller = self.controller()
        attempts = len(control.LOCK_RETRY_DELAYS) + 1
        with mock.patch.object(control, 'command', side_effect=[self.busy] * attempts) as command, \
             mock.patch.object(control.time, 'sleep'), mock.patch.object(control, 'emit'):
            with self.assertRaisesRegex(RuntimeError, 'busy'):
                controller.host_action('container', {'action': 'start'})
        self.assertEqual(command.call_count, attempts)

    def test_4077_other_errors_and_unsafe_actions_are_not_retried(self):
        controller = self.controller()
        other = control.CommandError('failed', json.dumps({'error': 'incus stop failed: [Errno 11] Resource temporarily unavailable'}))
        for action, error in [('container', other), ('recover', self.busy), ('prepare', self.busy)]:
            with self.subTest(action=action), \
                 mock.patch.object(control, 'command', side_effect=[error, '{"ok": true}']) as command, \
                 mock.patch.object(control.time, 'sleep'), mock.patch.object(control, 'emit'):
                with self.assertRaises(RuntimeError):
                    controller.host_action(action, {})
                self.assertEqual(command.call_count, 1)


if __name__ == '__main__':
    unittest.main()
