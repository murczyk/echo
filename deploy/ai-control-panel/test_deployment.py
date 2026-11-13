import contextlib
import copy
import importlib.util
import io
import json
import os
import signal
import textwrap
from pathlib import Path
from types import SimpleNamespace
import subprocess
import tempfile
import unittest
from unittest import mock

import control

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('deploy_notice', Path(__file__).with_name('deploy-notice.py'))
NOTICE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(NOTICE)
RELEASE = json.loads((ROOT / 'echo-ai-agent/release.json').read_text())
NEW = RELEASE['release']
OLD = '2026.10.11.2'
DEFAULT = control.AGENT_HOST
UA = 'echo@echo-ai-agents-ua.eagle-atria.ts.net'
AGENT = 'echo-ai-agent-019fd2bb-e21c-7b62-b9f9-1cf29dd6082e'
TEMPLATE = 'echo-ai-agent-template-' + NEW.replace('.', '-')


def probe(host='echo-cbr', connection=DEFAULT):
    return {'host': host, 'namespace': host, 'protocol': 1, 'running_match': True,
            'required_release': NEW, 'active_requests': 0, 'enabled': True,
            'dispatcher': {'host': connection.split('@')[1], 'port': 22031, 'ssh_user': 'restricted'},
            'template_id': '019fc7f7-9770-7f83-9c1a-211af29b02e6',
            'migrations': RELEASE['requiredMigrations'], 'containers': []}


def inventory(namespace='echo-cbr', selected=OLD, versions=()):
    name = 'echo-ai-agent-template-' + selected.replace('.', '-')
    return {'dispatcher_release': NEW, 'template_release': NEW, 'namespace_templates': True,
            'pending': [], 'releases': [{'release': NEW, 'manifest': RELEASE, 'digest': 'fixture', 'source': 'retained'}],
            'selections': {namespace: {'release': selected, 'template': name}},
            'instances': [{'name': name, 'template': True, 'managed': False, 'namespace': None,
                           'state': 'stopped', 'release': selected}] + [
                {'name': AGENT[:-1] + str(index), 'namespace': namespace, 'release': version,
                 'managed': True, 'template': False, 'state': 'stopped'} for index, version in enumerate(versions)]}


class DeploymentFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.controller = control.Control(SimpleNamespace(repo=ROOT, executable=Path('/fixture/wdintel-rs'), mode='debug'))
        self.controller.repo = Path(self.temporary.name)
        self.rows = {'echo-cbr': probe(), 'echo-kharkiv2': probe('echo-kharkiv2', UA)}
        self.inventories = {DEFAULT: inventory(), UA: inventory('echo-kharkiv2')}
        self.actions = []
        self.patch(self.controller, 'aliases', side_effect=lambda extra: list(self.rows))
        self.patch(self.controller, 'probe', side_effect=lambda host: copy.deepcopy(self.rows[host]))
        self.patch(self.controller, 'host_action', side_effect=self.action)
        self.patch(self.controller.shared, 'manifest', return_value=RELEASE)
        self.patch(self.controller.shared, 'digest', return_value='fixture')
        self.patch(control, 'command', return_value='')
        self.patch(control, 'emit')

    def patch(self, target, name, **kwargs):
        patcher = mock.patch.object(target, name, **kwargs)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def action(self, action, request=None, timeout=None, agent_host=None):
        connection = agent_host or self.controller.agent_host
        self.actions.append((connection, action, copy.deepcopy(request)))
        if action == 'inventory':
            return copy.deepcopy(self.inventories[connection])
        if action == 'replace':
            return {'id': request['namespace'] + '-fixture', 'containers': []}
        if action == 'finish':
            return {'states': []}
        return {}

    def scan(self):
        return self.controller.scan({'hosts': list(self.rows)})

    def notice(self, host='echo-cbr'):
        return NOTICE.deployment_notice(self.controller, host)


class Routing(DeploymentFixture):
    def test_two_database_dispatchers_have_independent_inventories_and_catalogs(self):
        self.inventories[UA]['releases'][0]['digest'] = 'different-bytes'
        data = self.scan()
        self.assertCountEqual([entry[:2] for entry in self.actions], [(DEFAULT, 'inventory'), (UA, 'inventory')])
        rows = {row['host']: row for row in data['hosts']}
        self.assertEqual(rows['echo-cbr']['eligibility'][NEW], 'Ready')
        self.assertIn('different bundle bytes', rows['echo-kharkiv2']['eligibility'][NEW])
        self.assertEqual(data['shared'], {})
        self.assertEqual(rows['echo-kharkiv2']['agent_host'], UA)
        self.assertIn(DEFAULT, data['releases'][0]['agent_hosts'])
        self.assertIn(UA, data['releases'][0]['agent_hosts'])

    def test_same_vm_is_inventoried_once_and_other_vm_failure_is_isolated(self):
        self.rows['echo-extra'] = probe('echo-extra')
        self.inventories[UA] = {'error': 'unreachable', 'releases': [], 'instances': []}
        data = self.scan()
        self.assertEqual(sum(action[0] == DEFAULT for action in self.actions), 1)
        rows = {row['host']: row for row in data['hosts']}
        self.assertEqual(rows['echo-cbr']['eligibility'][NEW], 'Ready')
        self.assertEqual(rows['echo-kharkiv2']['eligibility'][NEW], 'Shared host unavailable')

    def test_explicit_override_and_unknown_dispatcher_never_contact_the_wrong_vm(self):
        self.controller.agent_override = DEFAULT
        self.rows['echo-cbr']['dispatcher']['host'] = 'unknown.example'
        data = self.scan()
        self.assertFalse(self.actions)
        self.assertIn('unsupported', data['hosts'][0]['routing_error'])
        self.assertIn('does not match', data['hosts'][1]['routing_error'])
        self.controller.agent_override = UA
        data = self.scan()
        self.assertEqual([entry[:2] for entry in self.actions], [(UA, 'inventory')])
        self.assertEqual(data['hosts'][1]['eligibility'][NEW], 'Ready')

    def test_single_vm_json_keeps_existing_shared_and_release_fields(self):
        self.rows.pop('echo-kharkiv2')
        data = self.scan()
        self.assertEqual(data['shared']['dispatcher_release'], NEW)
        self.assertEqual(data['releases'][0]['digest'], 'fixture')

    def test_dry_run_routing_and_changed_preview_never_mutate(self):
        data = self.scan()
        self.controller.upgrade({'release': NEW, 'selected': list(self.rows), 'snapshot': data, 'dry_run': True})
        self.assertTrue(all(action[1] == 'inventory' for action in self.actions))
        self.rows['echo-kharkiv2']['dispatcher']['host'] = DEFAULT.split('@')[1]
        with self.assertRaisesRegex(RuntimeError, 'changed after preview'):
            self.controller.upgrade({'release': NEW, 'selected': list(self.rows), 'snapshot': data})
        self.assertTrue(all(action[1] == 'inventory' for action in self.actions))

    def test_mixed_vm_rollout_routes_actual_replacement_and_saves_destination(self):
        self.rows['echo-cbr-staging'] = probe('echo-cbr-staging')
        self.inventories[DEFAULT]['selections']['echo-cbr-staging'] = self.inventories[DEFAULT]['selections']['echo-cbr']
        prepared = self.patch(self.controller, 'prepare')
        calls = []
        def maintenance(args):
            host = next(host for host in self.rows if host in args)
            helper = mock.Mock()
            helper.ready = {'inventory': copy.deepcopy(self.rows[host]), 'required_release': NEW}
            helper.call.side_effect = lambda request, **kwargs: calls.append((host, request)) or {'ok': True}
            return helper
        self.patch(control, 'Maintenance', side_effect=maintenance)
        data = self.scan()
        self.controller.upgrade({'release': NEW, 'selected': list(self.rows), 'snapshot': data})
        self.assertEqual(prepared.call_count, 2)
        replacements = [(connection, request['namespace']) for connection, action, request in self.actions if action == 'replace']
        self.assertEqual(replacements, [(DEFAULT, 'echo-cbr-staging'), (DEFAULT, 'echo-cbr'), (UA, 'echo-kharkiv2')])
        for host, connection in [('echo-cbr', DEFAULT), ('echo-kharkiv2', UA)]:
            journal = json.loads(self.controller.journal_path(host).read_text())
            self.assertEqual(journal['agent_host'], connection)
            self.assertEqual(journal['phase'], 'complete')

    def test_one_selected_namespace_does_not_prepare_or_replace_the_other_vm(self):
        data = self.scan()
        prepared = self.patch(self.controller, 'prepare')
        replaced = self.patch(self.controller, 'upgrade_namespace')
        self.controller.upgrade({'release': NEW, 'selected': ['echo-kharkiv2'], 'snapshot': data})
        self.assertEqual(prepared.call_count, 1)
        self.assertEqual(replaced.call_args.args[0]['agent_host'], UA)
        self.assertEqual(self.controller.agent_host, UA)

    def test_destination_changes_after_scan_stop_before_shared_preparation(self):
        data = self.scan()
        self.patch(self.controller, 'scan', return_value=data)
        prepared = self.patch(self.controller, 'prepare')
        self.rows['echo-cbr']['dispatcher']['host'] = UA.split('@')[1]
        with self.assertRaisesRegex(RuntimeError, 'destination changed'):
            self.controller.upgrade({'release': NEW, 'selected': ['echo-cbr'], 'snapshot': data})
        prepared.assert_not_called()
        self.assertTrue(all(action[1] == 'inventory' for action in self.actions))

    def test_failed_first_vm_stops_before_preparing_or_replacing_second(self):
        data = self.scan()
        prepared = self.patch(self.controller, 'prepare')
        replaced = self.patch(self.controller, 'upgrade_namespace', side_effect=RuntimeError('fixture failure'))
        with self.assertRaisesRegex(RuntimeError, 'fixture failure'):
            self.controller.upgrade({'release': NEW, 'selected': list(self.rows), 'snapshot': data})
        self.assertEqual(prepared.call_count, 1)
        self.assertEqual(replaced.call_count, 1)
        self.assertEqual(replaced.call_args.args[0]['host'], 'echo-cbr')

    def test_cancellation_during_shared_preparation_stops_before_replacement(self):
        data = self.scan()
        cancel = Path(self.temporary.name) / 'cancel'
        self.patch(self.controller, 'prepare', side_effect=lambda *args: cancel.write_text('cancel'))
        replaced = self.patch(self.controller, 'upgrade_namespace')
        self.controller.upgrade({'release': NEW, 'selected': list(self.rows), 'snapshot': data, 'cancel_file': str(cancel)})
        replaced.assert_not_called()

    def test_recovery_blocks_changed_vm_and_requires_explicit_legacy_destination(self):
        journal = {'namespace': 'echo-cbr', 'agent_host': DEFAULT}
        with self.assertRaisesRegex(RuntimeError, 'different agent host'):
            self.controller.bind_recovery(journal, self.rows['echo-kharkiv2'])
        journal.pop('agent_host')
        with self.assertRaisesRegex(RuntimeError, 'Legacy rollout'):
            self.controller.bind_recovery(journal, self.rows['echo-cbr'])
        self.controller.agent_override = DEFAULT
        self.controller.bind_recovery(journal, self.rows['echo-cbr'])
        self.assertEqual(self.controller.agent_host, DEFAULT)
        self.assertFalse(self.actions)


class Notice(DeploymentFixture):
    def test_current_empty_namespace_and_disabled_configured_instance_are_checked(self):
        self.inventories[DEFAULT] = inventory(selected=NEW)
        self.rows['echo-cbr']['enabled'] = False
        self.assertIn('is current', self.notice())
        self.assertEqual(self.actions[0][:2], (DEFAULT, 'inventory'))

    def test_old_template_and_mixed_agents_print_remote_requirement_without_host_flag(self):
        self.rows['echo-cbr']['required_release'] = '2099.01.01.1'
        text = self.notice()
        self.assertIn('upgrade needed', text)
        self.assertIn('--release 2099.01.01.1 --dry-run', text)
        self.assertNotIn('--agent-host', text)
        self.inventories[DEFAULT] = inventory(selected=NEW, versions=(NEW, OLD))
        self.rows['echo-cbr']['required_release'] = NEW
        self.rows['echo-cbr']['containers'] = [{'name': AGENT[:-1] + str(index)} for index in range(2)]
        self.assertIn('upgrade needed', self.notice())

    def test_old_agents_need_upgrade_even_with_current_template(self):
        self.inventories[DEFAULT] = inventory(selected=NEW, versions=(OLD,))
        self.rows['echo-cbr']['containers'] = [{'name': AGENT[:-1] + '0'}]
        self.assertIn('upgrade needed', self.notice())

    def test_backups_and_other_namespaces_do_not_trigger_notice(self):
        self.inventories[DEFAULT] = inventory(selected=NEW)
        self.inventories[DEFAULT]['instances'] += [
            {'name': 'ai-rollout-backup', 'managed': False, 'namespace': 'echo-cbr', 'release': OLD},
            {'name': AGENT, 'managed': True, 'namespace': 'echo-unselected', 'release': OLD}]
        self.assertIn('is current', self.notice())

    def test_legacy_default_template_is_used_without_a_namespace_pin(self):
        self.inventories[DEFAULT] = inventory(selected=NEW)
        self.inventories[DEFAULT]['selections'] = {}
        self.inventories[DEFAULT]['instances'][0]['name'] = 'echo-ai-agent-019fc7f7-9770-7f83-9c1a-211af29b02e6'
        self.assertIn('is current', self.notice())

    def test_failed_checks_warn_without_claiming_upgrade_status(self):
        for damage in ['version', 'template', 'build', 'connection']:
            with self.subTest(damage=damage):
                self.inventories[DEFAULT] = inventory(selected=NEW)
                self.rows['echo-cbr'] = probe()
                if damage == 'version':
                    self.rows['echo-cbr'].pop('required_release')
                elif damage == 'template':
                    self.inventories[DEFAULT]['instances'] = []
                elif damage == 'build':
                    self.rows['echo-cbr']['running_match'] = False
                else:
                    self.rows['echo-cbr']['dispatcher']['host'] = 'unsupported.example'
                text = self.notice()
                self.assertIn('WARNING:', text)
                self.assertIn('scan --host echo-cbr --json', text)
                self.assertNotIn('upgrade needed', text)
                self.assertNotIn('is current', text)

    def test_unconfigured_skips_inventory_and_ua_uses_its_own_connection(self):
        self.rows['echo-cbr'].update(namespace=None, dispatcher=None)
        self.assertIn('skipped', self.notice())
        self.assertFalse(self.actions)
        self.assertIn(UA, self.notice('echo-kharkiv2'))
        self.assertEqual(self.actions[0][:2], (UA, 'inventory'))

    def test_notice_cli_keeps_zero_exit_status_when_ssh_fails(self):
        directory = Path(self.temporary.name)
        fake_ssh = directory / 'ssh'
        fake_ssh.write_text('#!/bin/sh\nexit 42\n')
        fake_ssh.chmod(0o755)
        result = subprocess.run(['python3', str(Path(NOTICE.__file__)), 'echo-fixture'],
                                env={**os.environ, 'PATH': str(directory) + ':' + os.environ['PATH']},
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('WARNING:', result.stdout)
        result = subprocess.run(['python3', str(Path(NOTICE.__file__)), '--sync', 'echo-fixture'],
                                env={**os.environ, 'PATH': str(directory) + ':' + os.environ['PATH']},
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('WARNING:', result.stdout)


class Sync(DeploymentFixture):
    def panel(self, *results, upgrade_to=NEW):
        calls = []
        def run(repo, host, release, dry_run):
            calls.append((host, release, dry_run))
            ok = results[len(calls) - 1]
            if ok and not dry_run and upgrade_to:
                self.inventories[DEFAULT] = inventory(selected=upgrade_to)
            return ok
        return calls, run

    def sync(self, run):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            synced = NOTICE.sync_deployment(self.controller, 'echo-cbr', run=run)
        return synced, output.getvalue()

    def test_needed_upgrade_previews_upgrades_and_confirms(self):
        calls, run = self.panel(True, True)
        synced, text = self.sync(run)
        self.assertTrue(synced, text)
        self.assertEqual(calls, [('echo-cbr', NEW, True), ('echo-cbr', NEW, False)])
        self.assertIn('upgrade needed', text)
        self.assertTrue(text.rstrip().endswith(f'AI harness: echo-cbr is current ({NEW}; {DEFAULT}).'), text)

    def test_current_and_unconfigured_hosts_never_run_the_panel(self):
        calls, run = self.panel()
        self.inventories[DEFAULT] = inventory(selected=NEW)
        self.assertTrue(self.sync(run)[0])
        self.rows['echo-cbr'].update(namespace=None, dispatcher=None)
        synced, text = self.sync(run)
        self.assertTrue(synced)
        self.assertIn('skipped', text)
        self.assertEqual(calls, [])

    def test_failed_preview_skips_the_upgrade(self):
        calls, run = self.panel(False)
        synced, text = self.sync(run)
        self.assertFalse(synced)
        self.assertEqual(calls, [('echo-cbr', NEW, True)])
        self.assertIn('nothing was changed', text)

    def test_failed_or_incomplete_upgrade_is_not_in_sync(self):
        for results, upgrade_to in [((True, False), NEW), ((True, True), None)]:
            with self.subTest(results=results):
                self.inventories[DEFAULT] = inventory()
                calls, run = self.panel(*results, upgrade_to=upgrade_to)
                synced, text = self.sync(run)
                self.assertFalse(synced, text)
                self.assertEqual(len(calls), 2)

    def test_unknown_status_fails_without_running_the_panel(self):
        calls, run = self.panel()
        self.rows['echo-cbr'].pop('required_release')
        synced, text = self.sync(run)
        self.assertFalse(synced)
        self.assertIn('WARNING:', text)
        self.assertEqual(calls, [])

    def test_interrupted_rollout_is_never_reported_current(self):
        calls, run = self.panel()
        self.inventories[DEFAULT] = inventory(selected=NEW)
        self.inventories[DEFAULT]['pending'] = [{'namespace': 'echo-cbr', 'phase': 'replaced'}]
        synced, text = self.sync(run)
        self.assertFalse(synced)
        self.assertIn('Interrupted rollout', text)
        self.assertIn('recover --host echo-cbr', text)
        self.assertNotIn('is current', text)
        self.assertEqual(calls, [])
        self.inventories[DEFAULT]['pending'] = [{'namespace': 'echo-other', 'phase': 'replaced'}]
        self.assertTrue(self.sync(run)[0])



class PanelRun(unittest.TestCase):
    """run_panel against a stand-in control.py that speaks the same protocol."""
    def run_panel(self, body, dry_run=False, lost_terminal=False):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            panel = repo / 'deploy/ai-control-panel'
            panel.mkdir(parents=True)
            (panel / 'control.py').write_text(textwrap.dedent('''
                import json, os, signal, sys, time
                from pathlib import Path
                request = json.load(sys.stdin)
                Path(os.environ['PANEL_SEEN']).write_text(json.dumps({'argv': sys.argv[1:], 'request': request,
                                                             'own_session': os.getsid(0) == os.getpid()}))
                def emit(value): print(json.dumps(value), flush=True)
            ''') + textwrap.dedent(body))
            seen = repo / 'seen.json'
            logs = repo / 'logs'
            logs.mkdir()
            output, errors = io.StringIO(), io.StringIO()
            capture = contextlib.ExitStack()
            if not lost_terminal:
                capture.enter_context(contextlib.redirect_stdout(output))
                capture.enter_context(contextlib.redirect_stderr(errors))
            with mock.patch.dict(os.environ, {'PANEL_SEEN': str(seen)}), \
                    mock.patch.object(NOTICE.tempfile, 'tempdir', str(logs)), capture:
                ok = NOTICE.run_panel(repo, 'echo-cbr', NEW, dry_run)
            [log] = logs.glob('echo-ai-control-panel-*.log')
            leftover = list((repo / '.dev-runtime/ai-control-panel').iterdir())
            return ok, output.getvalue() + errors.getvalue(), json.loads(seen.read_text()), log.read_text(), leftover

    def test_success_prints_messages_and_the_target_row(self):
        ok, text, seen, log, leftover = self.run_panel('''
            emit({'message': 'Preview passed; no changes made. Selected: echo-cbr'})
            emit({'hosts': [{'host': 'echo-other'}, {'host': 'echo-cbr', 'agent_host': 'vm', 'namespace': 'echo-cbr',
                  'deployed': 'old', 'required_release': 'new', 'eligibility': {request['release']: 'Ready'}}]})
            emit({'diagnostic': 'only in the log'})
            print('plain text')
        ''', dry_run=True)
        self.assertTrue(ok, text)
        self.assertEqual(seen['argv'][:2], ['upgrade', '--repo'])
        self.assertEqual(seen['request']['selected'], ['echo-cbr'])
        self.assertEqual(seen['request']['release'], NEW)
        self.assertTrue(seen['request']['dry_run'])
        self.assertTrue(seen['own_session'])
        self.assertIn('Preview passed', text)
        self.assertIn(f'echo-cbr | vm | echo-cbr | old | requires new | target {NEW}: Ready', text)
        self.assertNotIn('echo-other', text)
        self.assertNotIn('only in the log', text)
        self.assertIn('plain text', text)
        self.assertIn('only in the log', log)
        self.assertEqual(leftover, [])

    def test_error_event_or_exit_status_fails(self):
        for body in ["emit({'message': 'boom', 'error': True})\n", "sys.exit(3)\n"]:
            with self.subTest(body=body):
                self.assertFalse(self.run_panel(body)[0])

    def test_termination_signals_ask_the_panel_to_stop_and_wait_for_it(self):
        for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            with self.subTest(signal=number.name):
                ok, text, seen, log, leftover = self.run_panel(f'''
                    os.kill(os.getppid(), {int(number)})
                    os.kill(os.getppid(), {int(number)})
                    cancel = Path(request['cancel_file'])
                    deadline = time.monotonic() + 5
                    while not cancel.exists() and time.monotonic() < deadline:
                        time.sleep(0.05)
                    emit({{'message': 'Cancelled at a safe boundary' if cancel.exists() else 'never cancelled'}})
                ''')
                self.assertFalse(ok)
                self.assertIn('Cancelled at a safe boundary', text)
                self.assertEqual(text.count('Cancellation requested'), 1)
                self.assertEqual(leftover, [])
        for number, handler in [(signal.SIGINT, signal.default_int_handler), (signal.SIGTERM, signal.SIG_DFL),
                                (signal.SIGHUP, signal.SIG_DFL)]:
            self.assertIs(signal.getsignal(number), handler)

    def test_lost_terminal_keeps_draining_the_panel_until_it_stops(self):
        class Gone(io.StringIO):
            def write(self, text):
                raise OSError(5, 'Input/output error')
        with contextlib.redirect_stdout(Gone()), contextlib.redirect_stderr(Gone()):
            ok, text, seen, log, leftover = self.run_panel('''
                os.kill(os.getppid(), signal.SIGHUP)
                cancel = Path(request['cancel_file'])
                deadline = time.monotonic() + 5
                while not cancel.exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                for index in range(200):
                    emit({'message': f'step {index}'})
                emit({'message': 'Cancelled at a safe boundary' if cancel.exists() else 'never cancelled'})
            ''', lost_terminal=True)
        self.assertFalse(ok)
        self.assertEqual(text, '')
        self.assertIn('step 199', log)
        self.assertIn('Cancelled at a safe boundary', log)


class RecipeAdvisory(unittest.TestCase):
    def run_recipe(self, recipe, fail=False, notice_exit=0):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            binary = directory / 'bin'
            binary.mkdir()
            log = directory / 'actions'
            for name in ['ssh', 'git', 'tq', 'curl', 'scp', 'just', 'cargo']:
                script = binary / name
                script.write_text('#!/usr/bin/env python3\n' + """
import os,sys
from pathlib import Path
name=Path(sys.argv[0]).name
with open(os.environ['RECIPE_LOG'],'a') as out: out.write(name+'\\n')
if name=='git': print('stable')
if name=='tq': print('fixture')
if name=='ssh':
    if 'redis-cli' in sys.argv: print('1')
    if os.environ.get('RECIPE_FAIL') and any(' migrate' in arg for arg in sys.argv): sys.exit(42)
""")
                script.chmod(0o755)
            deploy = directory / 'deploy'
            deploy.mkdir()
            for name in ['prepare-sigint-inbox-callsign-iggy-index.sh', 'stage-packages.sh']:
                (deploy / name).write_text('#!/bin/bash\nexit 0\n')
            (deploy / 'deployment-maintenance.sh').write_text(
                '#!/bin/bash\nif [ "$1" = keepalive ]; then exec sleep 30; fi\nprintf "%s\\n" "$1" >> "$RECIPE_LOG"\n')
            panel = deploy / 'ai-control-panel'
            panel.mkdir()
            (panel / 'deploy-notice.py').write_text(
                'import os,sys\nwith open(os.environ["RECIPE_LOG"],"a") as out: out.write("notice "+" ".join(sys.argv[1:])+"\\n")\n'
                'raise SystemExit(int(os.environ["NOTICE_EXIT"]))\n')
            debian = directory / 'target/debian'
            debian.mkdir(parents=True)
            (debian / 'wdintel-rs_fixture_amd64.deb').touch()
            source = (ROOT / 'justfile').read_text()
            body = source.split(recipe + ' _server_pos="" server silent="false":\n', 1)[1].split("\n[arg(", 1)[0]
            body = textwrap.dedent(body)
            for expression, value in [('justfile_directory()', str(directory)), ('_server_pos', ''),
                                      ('server', 'echo-fixture'), ('silent', 'false'),
                                      ('discord_webhook_infra', 'https://fixture.invalid')]:
                body = body.replace('{{ ' + expression + ' }}', value)
            self.assertNotIn('{{', body)
            script = directory / 'recipe.sh'
            script.write_text(body)
            result = subprocess.run(['bash', str(script)], cwd=directory,
                                    env={**os.environ, 'PATH': str(binary) + ':' + os.environ['PATH'],
                                         'RECIPE_LOG': str(log), 'RECIPE_FAIL': '1' if fail else '',
                                         'NOTICE_EXIT': str(notice_exit)},
                                    capture_output=True, text=True, timeout=10)
            return result, log.read_text().splitlines()

    def test_both_recipes_sync_the_harness_after_cleanup(self):
        for recipe in ['deploy', 'deploy-from-local']:
            with self.subTest(recipe=recipe):
                result, actions = self.run_recipe(recipe)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual([action for action in actions if action.startswith('notice')], ['notice --sync echo-fixture'])
                notice = actions.index('notice --sync echo-fixture')
                self.assertEqual(actions.count('clear'), 1)
                self.assertLess(actions.index('clear'), notice)
                self.assertLess(max(index for index, action in enumerate(actions) if action == 'curl'), notice)

    def test_both_recipes_fail_loudly_when_the_harness_is_not_in_sync(self):
        for recipe in ['deploy', 'deploy-from-local']:
            with self.subTest(recipe=recipe):
                result, actions = self.run_recipe(recipe, notice_exit=1)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn('🔴🔴🔴 AI harness on echo-fixture is not confirmed in sync', result.stderr)
                self.assertIn('deploy-notice.py --sync echo-fixture', result.stderr)
                notice = actions.index('notice --sync echo-fixture')
                self.assertEqual(actions[notice + 1:], ['curl'])
                self.assertEqual(actions.count('clear'), 1)

    def test_failed_deployment_does_not_run_the_harness_sync(self):
        for recipe in ['deploy', 'deploy-from-local']:
            with self.subTest(recipe=recipe):
                result, actions = self.run_recipe(recipe, fail=True)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertFalse([action for action in actions if action.startswith('notice')])

if __name__ == '__main__':
    unittest.main()
