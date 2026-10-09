import copy
import fcntl
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HOST = load('control_host_test', ROOT / 'echo-ai-agent/bin/control-host.py')
CONTROL = load('control_panel_test', ROOT / 'deploy/ai-control-panel/control.py')
DISPATCHER = load('control_dispatcher_test', ROOT / 'echo-ai-agent/dispatcher/echo_ai_agent_dispatcher.py')
RELEASE = json.loads((ROOT / 'echo-ai-agent/release.json').read_text())
OLD = '2026.08.25.2'
NEW = RELEASE['release']
AGENT = 'echo-ai-agent-019fd2bb-e21c-7b62-b9f9-1cf29dd6082e'


def template(release):
    return {'name': 'echo-ai-agent-template-' + release.replace('.', '-'), 'status': 'Stopped', 'profiles': ['echo-ai-agent'],
            'config': {'user.echo.ai.template.ready': 'true', 'user.echo.ai.harness_release': release,
                       'user.echo.ai.guestapi_disabled': 'true', 'user.echo.ai.container_uid': '29720',
                       'user.echo.ai.container_gid': '29720', 'user.echo.ai.node_version': RELEASE['nodeVersion'],
                       'user.echo.ai.pi_version': RELEASE['piVersion']}}


class RolloutIsolationTests(unittest.TestCase):
    def test_recovery_never_matches_a_namespace_with_the_same_prefix(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(HOST, 'JOURNALS', Path(directory)), \
             mock.patch.object(HOST, 'checked_namespace', return_value='echo-cbr'):
            directory = Path(directory)
            (directory / 'echo-cbr-staging-100.json').write_text(json.dumps({'namespace':'echo-cbr-staging','phase':'verifying'}))
            with self.assertRaisesRegex(RuntimeError, 'exactly one'):
                HOST.load_job({'namespace':'echo-cbr'})
            (directory / 'echo-cbr-101.json').write_text(json.dumps({'namespace':'echo-cbr','phase':'verifying'}))
            self.assertEqual(HOST.load_job({'namespace':'echo-cbr'})['namespace'], 'echo-cbr')

    def test_old_namespace_preflight_and_clone_use_its_pinned_template(self):
        old_template = template(OLD)
        with mock.patch.object(DISPATCHER, 'namespace_template', return_value={'template':old_template['name'],'release':OLD}), \
             mock.patch.object(DISPATCHER, 'instance_record', return_value=old_template) as lookup, \
             mock.patch.object(DISPATCHER, 'incus_versions', return_value={}), \
             mock.patch.object(DISPATCHER, 'running_agent_count', return_value=0):
            result = DISPATCHER.op_preflight('echo-cbr', {})
            self.assertEqual(result['harness_release'], OLD)
            self.assertEqual(result['dispatcher_release'], NEW)
            self.assertEqual(result['template_id'], DISPATCHER.TEMPLATE_NAME.removeprefix('echo-ai-agent-'))
            self.assertEqual(lookup.call_args.args, (old_template['name'],))
            self.assertEqual(DISPATCHER.require_template({}, 'echo-cbr'), old_template)

    def test_namespace_selection_accepts_an_incus_name_and_preserves_release_label(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            selection = {'release':NEW, 'template':template(NEW)['name']}
            (directory / 'echo-cbr.json').write_text(json.dumps(selection))
            metadata = mock.Mock(st_uid=0, st_mode=0o100644)
            with mock.patch.object(DISPATCHER, 'NAMESPACE_RELEASES', directory), \
                 mock.patch.object(Path, 'lstat', return_value=metadata):
                self.assertEqual(DISPATCHER.namespace_template('echo-cbr'), selection)
                self.assertRegex(selection['template'], r'^[a-zA-Z0-9-]+$')
                selection['template'] = 'echo-ai-agent-template-' + NEW
                (directory / 'echo-cbr.json').write_text(json.dumps(selection))
                with self.assertRaisesRegex(DISPATCHER.DispatchError, 'name is invalid'):
                    DISPATCHER.namespace_template('echo-cbr')

    def test_durable_maintenance_marker_blocks_mutations_after_updater_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / 'echo-cbr.maintenance').write_text('{}')
            with mock.patch.object(DISPATCHER, 'NAMESPACE_RELEASES', directory), \
                 mock.patch.object(DISPATCHER, 'dispatch') as dispatch, \
                 (directory / 'global.lock').open('w') as lease:
                request = DISPATCHER.Request('test', 'clone', {})
                with self.assertRaisesRegex(DISPATCHER.DispatchError, 'recovery'):
                    DISPATCHER.dispatch_with_rollout_lock(request, 'echo-cbr', lease)
                dispatch.assert_not_called()

    def test_namespace_lock_blocks_racing_requests_but_not_other_namespaces(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / 'echo-other.lock').touch()
            with mock.patch.object(DISPATCHER, 'ROLLOUT_LOCK_ROOT', directory), \
                 mock.patch.object(DISPATCHER, 'NAMESPACE_RELEASES', directory), \
                 mock.patch.object(DISPATCHER, 'dispatch', return_value={'ok':True}) as dispatch, \
                 (directory / 'echo-cbr.lock').open('w') as exclusive, \
                 (directory / 'global.lock').open('w') as shared:
                fcntl.flock(exclusive, fcntl.LOCK_EX | fcntl.LOCK_NB)
                request = DISPATCHER.Request('test', 'run_request', {})
                with self.assertRaisesRegex(DISPATCHER.DispatchError, 'in progress'):
                    DISPATCHER.dispatch_with_rollout_lock(request, 'echo-cbr', shared)
                self.assertEqual(DISPATCHER.dispatch_with_rollout_lock(request, 'echo-other', shared), {'ok':True})
                self.assertEqual(dispatch.call_count, 1)

    def test_inventory_mismatch_blocks_destructive_work_before_pin_changes(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(HOST, 'checked_namespace', return_value='echo-cbr'), \
             mock.patch.object(HOST, 'manifest', return_value=RELEASE), \
             mock.patch.object(HOST, 'instances', return_value=[template(NEW)]), \
             mock.patch.object(HOST, 'run') as run:
            directory = Path(directory)
            with mock.patch.object(HOST, 'LOCKS', directory), mock.patch.object(HOST, 'JOURNALS', directory), mock.patch.object(HOST, 'SELECTIONS', directory):
                with self.assertRaisesRegex(RuntimeError, 'inventory differs'):
                    HOST.replace_namespace({'namespace':'echo-cbr','release':NEW,'containers':[{'name':AGENT}],'enabled':True})
            run.assert_not_called()
            self.assertFalse((directory / 'echo-cbr.json').exists())

    def test_recovery_refuses_to_delete_reassigned_container(self):
        job = {'id':'echo-cbr-test','namespace':'echo-cbr','containers':[{'name':AGENT,'backup':'saved','stage':'replaced'}]}
        intruder = {'name':AGENT,'status':'Stopped','config':{'user.echo.ai.namespace':'echo-other'}}
        saved = {'name':'saved','status':'Stopped','config':{}}
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(HOST, 'LOCKS', Path(directory)), \
             mock.patch.object(HOST, 'load_job', return_value=job), \
             mock.patch.object(HOST, 'instances', return_value=[intruder,saved]), \
             mock.patch.object(HOST, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'ownership changed'):
                HOST.recover({'namespace':'echo-cbr'})
            run.assert_not_called()

    def test_preparation_lock_preserves_dispatcher_group_write_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'dispatcher.lock'
            path.touch(mode=0o660)
            path.chmod(0o660)
            with HOST.lock(path):
                self.assertEqual(path.stat().st_mode & 0o777, 0o660)

    def test_shared_publish_retains_previous_release_without_running_host_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            root = directory / 'host'
            (root / 'releases' / OLD).mkdir(parents=True)
            (root / 'current').symlink_to(root / 'releases' / OLD)
            source = directory / 'bundle'
            source.mkdir()
            (source / 'runner').write_text('immutable runner')
            with mock.patch.object(HOST, 'ROOT', root), \
                 mock.patch.object(HOST, 'manifest', return_value=RELEASE), \
                 mock.patch.object(HOST.os, 'chown'), \
                 mock.patch.object(HOST, 'run') as run:
                installed = HOST.install_release(source)
                self.assertEqual(HOST.digest(installed), HOST.digest(source))
                HOST.publish_release(installed)
                self.assertEqual((root / 'current').resolve(), installed)
                self.assertEqual((root / 'previous').resolve(), root / 'releases' / OLD)
                run.assert_not_called()
                (source / 'runner').write_text('changed runner')
                with self.assertRaisesRegex(RuntimeError, 'bytes differ'):
                    HOST.install_release(source)

    def test_shared_publish_blocks_infrastructure_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / 'old'
            new = root / 'new'
            for bundle in [old, new]:
                (bundle / 'config').mkdir(parents=True)
            (old / 'config/host.env').write_text('old contract')
            (new / 'config/host.env').write_text('changed contract')
            (root / 'current').symlink_to(old)
            with mock.patch.object(HOST, 'ROOT', root):
                with self.assertRaisesRegex(RuntimeError, 'infrastructure changed'):
                    HOST.validate_shared_update(new, RELEASE)
            self.assertEqual((root / 'current').resolve(), old)

    def test_dispatcher_counts_reserved_slots_without_double_counting_running_agents(self):
        records = [{'name':AGENT, 'status':'Running', 'config':{
            'user.echo.ai.managed':'true', 'user.echo.ai.namespace':'echo-cbr'}}]
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / 'echo-cbr.maintenance').write_text(json.dumps({'reserved_slots':3}))
            (directory / 'echo-other.maintenance').write_text(json.dumps({'reserved_slots':1}))
            with mock.patch.object(DISPATCHER, 'NAMESPACE_RELEASES', directory), \
                 mock.patch.object(DISPATCHER, 'incus_instances', return_value=records), \
                 mock.patch.object(HOST, 'SELECTIONS', directory):
                self.assertEqual(DISPATCHER.running_agent_count(), 4)
                self.assertEqual(HOST.effective_running(records), 4)
                self.assertEqual(HOST.effective_running(records, 'echo-cbr'), 2)


class FleetCompatibilityTests(unittest.TestCase):
    def fixture(self):
        row = {'host':'echo-cbr','namespace':'echo-cbr','protocol':1,'running_match':True,
               'required_release':NEW,'active_requests':0,'dispatcher':{'host':CONTROL.AGENT_HOSTNAME},
               'template_id':DISPATCHER.TEMPLATE_NAME.removeprefix('echo-ai-agent-'),
               'migrations':RELEASE['requiredMigrations'],'containers':[{'name':AGENT}], 'details':''}
        agent = {'name':AGENT,'namespace':'echo-cbr','release':OLD,'managed':True,'template':False}
        release = {'release':NEW,'manifest':RELEASE}
        return row, release, {'hosts':[row], 'releases':[release], 'shared':{'instances':[agent]}}

    def test_absent_database_agents_are_normal_but_missing_live_agents_block(self):
        row, release, data = self.fixture()
        row['containers'].append({'name':'not-created-yet','state':'absent'})
        self.assertEqual(CONTROL.blockers(row, release, data), 'Ready')
        row['containers'][-1]['state'] = 'stopped'
        self.assertIn('missing agents: not-created-yet', CONTROL.blockers(row, release, data))

    def test_stopped_orphan_backup_requires_explicit_choice_and_consistent_identity(self):
        row, release, data = self.fixture()
        row['containers'] = []
        orphan = data['shared']['instances'][0]
        orphan.update(state='stopped', agent_id=AGENT.removeprefix('echo-ai-agent-'))
        self.assertIn('--reconcile-orphans', CONTROL.blockers(row, release, data))
        self.assertEqual(CONTROL.blockers(row, release, data, True), 'Ready')
        orphan['state'] = 'running'
        self.assertIn('running', CONTROL.blockers(row, release, data, True))
        orphan.update(state='stopped', agent_id='different-identity')
        self.assertIn('identity', CONTROL.blockers(row, release, data, True))

    def test_observed_runner_does_not_establish_backend_compatibility(self):
        row, release, data = self.fixture()
        self.assertEqual(CONTROL.blockers(row, release, data), 'Ready')
        row.pop('protocol')
        self.assertIn('Unknown compatibility', CONTROL.blockers(row, release, data))
        row['protocol'] = 1
        row['required_release'] = OLD
        self.assertIn('Requires Echo build', CONTROL.blockers(row, release, data))

    def test_busy_migrating_stale_or_duplicate_targets_are_never_eligible(self):
        for change, reason in [({'active_requests':1}, 'Busy'), ({'migrations':[]}, 'migrations'), ({'running_match':False}, 'restart')]:
            with self.subTest(change=change):
                row, release, data = self.fixture()
                row.update(change)
                self.assertIn(reason, CONTROL.blockers(row, release, data))
        row, release, data = self.fixture()
        data['hosts'].append({**row, 'host':'alias'})
        self.assertIn('Duplicate', CONTROL.blockers(row, release, data))

    def test_another_namespaces_unsupported_runner_blocks_shared_upgrade(self):
        row, release, data = self.fixture()
        data['shared']['instances'].append({'name':'other','namespace':'echo-other','release':'2099.01.01.1','managed':True})
        self.assertIn('another deployed runner', CONTROL.blockers(row, release, data))

    def test_mixed_inventory_excludes_retained_backup_containers(self):
        row, release, data = self.fixture()
        data['shared']['instances'].append({'name':'backup','namespace':'echo-cbr','release':'2026.08.03.1','managed':False})
        CONTROL.decorate(data)
        self.assertEqual(row['deployed'], OLD + ' ×1')

    def test_unavailable_shared_inventory_does_not_claim_no_containers(self):
        row, _, data = self.fixture()
        data['shared'] = {'error':'connection failed', 'instances':[]}
        CONTROL.decorate(data)
        self.assertEqual(row['deployed'], 'Unknown')
        self.assertIn('Shared host: connection failed', row['details'])

    def test_manifest_requires_matching_release_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            (directory / 'release.json').write_text(json.dumps(RELEASE))
            (directory / 'versions.env').write_text('HARNESS_RELEASE=2026.01.01.1\n')
            with self.assertRaisesRegex(RuntimeError, 'disagrees'):
                HOST.manifest(directory)

    def test_3724_inconsistent_retained_manifest_preserves_inventory_and_blocks_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for release in [OLD, NEW]:
                bundle = root / 'releases' / release
                (bundle / 'dispatcher').mkdir(parents=True)
                for name in ['release.json', 'versions.env', 'dispatcher/echo_ai_agent_dispatcher.py']:
                    (bundle / name).write_bytes((ROOT / 'echo-ai-agent' / name).read_bytes())
            old = root / 'releases' / OLD
            metadata = {**RELEASE, 'supportedRunnerReleases': [OLD]}
            (old / 'release.json').write_text(json.dumps(metadata))
            (root / 'current').symlink_to(root / 'releases' / NEW)
            with mock.patch.object(HOST, 'ROOT', root), \
                 mock.patch.object(HOST, 'SELECTIONS', root / 'selections'), \
                 mock.patch.object(HOST, 'JOURNALS', root / 'journals'), \
                 mock.patch.object(HOST, 'instances', return_value=[template(NEW)]):
                inventory = HOST.inventory()
            releases = {release['release']: release for release in inventory['releases']}
            self.assertIsNone(releases[OLD]['manifest'])
            self.assertIn('compatibility disagrees', releases[OLD]['manifest_error'])
            self.assertEqual(releases[NEW]['manifest'], RELEASE)
            self.assertEqual(inventory['instances'][0]['release'], NEW)
            row, _, data = self.fixture()
            self.assertEqual(CONTROL.blockers(row, releases[OLD], data), 'Unknown release compatibility')
            with self.assertRaisesRegex(RuntimeError, 'compatibility disagrees'):
                HOST.manifest(old)

    def test_batch_stops_before_second_host_when_first_upgrade_fails(self):
        row, release, data = self.fixture()
        release['digest'] = 'verified'
        row['eligibility'] = {NEW:'Ready'}
        data['hosts'].append({**row,'host':'echo-other','namespace':'echo-other'})
        controller = CONTROL.Control.__new__(CONTROL.Control)
        with mock.patch.object(controller, 'scan', return_value=data), \
             mock.patch.object(controller, 'prepare'), \
             mock.patch.object(controller, 'upgrade_namespace', side_effect=RuntimeError('failed')) as upgrade, \
             mock.patch.object(CONTROL, 'emit'):
            with self.assertRaisesRegex(RuntimeError, 'failed'):
                controller.upgrade({'release':NEW,'selected':['echo-cbr','echo-other'],'snapshot':data})
            self.assertEqual(upgrade.call_count, 1)
            self.assertEqual(upgrade.call_args.args[0]['host'], 'echo-cbr')

    def test_cli_dry_run_and_already_current_target_never_prepare_or_replace(self):
        for dry_run, status in [(True, 'Ready'), (False, 'Current')]:
            with self.subTest(dry_run=dry_run, status=status):
                row, release, data = self.fixture()
                release['digest'] = 'verified'
                row['eligibility'] = {NEW:status}
                controller = CONTROL.Control.__new__(CONTROL.Control)
                with mock.patch.object(controller, 'scan', return_value=data), \
                     mock.patch.object(controller, 'prepare') as prepare, \
                     mock.patch.object(controller, 'upgrade_namespace') as upgrade, \
                     mock.patch.object(CONTROL, 'emit'):
                    controller.upgrade({'release':NEW,'selected':['echo-cbr'],'dry_run':dry_run})
                    prepare.assert_not_called()
                    upgrade.assert_not_called()

    def test_mismatched_build_blocks_mutation_and_reports_the_process(self):
        row, release, data = self.fixture()
        release['digest'] = 'verified'
        row.update(running_match=False, running_details='Different executable: report-worker PID 40')
        row['eligibility'] = {NEW:CONTROL.blockers(row, release, data)}
        controller = CONTROL.Control.__new__(CONTROL.Control)
        with mock.patch.object(controller, 'scan', return_value=data), \
             mock.patch.object(controller, 'prepare') as prepare, \
             mock.patch.object(CONTROL, 'emit'):
            with self.assertRaisesRegex(RuntimeError, 'report-worker PID 40'):
                controller.upgrade({'release':NEW,'selected':['echo-cbr'],'snapshot':data})
            prepare.assert_not_called()

    def test_recovery_rejects_a_host_that_now_serves_another_namespace(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'echo-cbr.json'
            path.write_text(json.dumps({'namespace':'echo-cbr', 'phase':'disabled'}))
            controller = CONTROL.Control.__new__(CONTROL.Control)
            maintenance = mock.Mock()
            maintenance.ready = {'inventory':{'namespace':'echo-other'}}
            with mock.patch.object(controller, 'journal_path', return_value=path), \
                 mock.patch.object(controller, 'probe_command', return_value=[]), \
                 mock.patch.object(controller, 'host_action') as host_action, \
                 mock.patch.object(CONTROL, 'Maintenance', return_value=maintenance):
                with self.assertRaisesRegex(RuntimeError, 'different namespace'):
                    controller.recover({'selected':['echo-cbr']})
                maintenance.call.assert_not_called()
                host_action.assert_not_called()
                maintenance.close.assert_called_once()


class ContainerReplacementTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        directory = Path(self.directory.name)
        for name in ['ROOT','SELECTIONS','JOURNALS','LOCKS']:
            path = directory / name
            path.mkdir()
            patch = mock.patch.object(HOST, name, path)
            patch.start()
            self.addCleanup(patch.stop)
        patch = mock.patch.object(HOST, 'DISPATCH_LOCK', directory / 'dispatch.lock')
        patch.start()
        self.addCleanup(patch.stop)
        self.other = 'echo-ai-agent-019fd2bb-e21c-7b62-b9f9-1cf29dd6082f'
        old = {'name':AGENT,'status':'Running','profiles':['echo-ai-agent'],
               'config':{'user.echo.ai.namespace':'echo-cbr','user.echo.ai.agent_id':AGENT.removeprefix('echo-ai-agent-'),
                         'user.echo.ai.harness_release':OLD,'user.echo.ai.managed':'true','user.echo.ai.template.ready':'false',
                         'user.echo.ai.echo_hostname':'echo-cbr.example.com'},
               'devices':{'echo-upstream':{'type':'proxy','bind':'instance','listen':'tcp:127.0.0.1:18443','connect':'tcp:100.64.0.1:443'}}}
        other = copy.deepcopy(old)
        other.update(name=self.other)
        other['config']['user.echo.ai.namespace'] = 'echo-other'
        self.records = {AGENT:old, self.other:other, template(NEW)['name']:template(NEW)}
        self.before = copy.deepcopy(self.records)
        self.fail_copy = False
        for patch in [mock.patch.object(HOST, 'checked_namespace', return_value='echo-cbr'),
                      mock.patch.object(HOST, 'manifest', return_value=RELEASE),
                      mock.patch.object(HOST, 'instances', side_effect=lambda: copy.deepcopy(list(self.records.values()))),
                      mock.patch.object(HOST, 'run', side_effect=self.incus)]:
            patch.start()
            self.addCleanup(patch.stop)
        HOST.write_json(HOST.SELECTIONS / 'echo-cbr.json', {'release':OLD,'template':HOST.FIXED})

    def incus(self, *args, **kwargs):
        if args[0] != 'incus':
            raise AssertionError(args)
        action = args[1]
        name = args[2]
        if action in {'start','stop'}:
            self.records[name]['status'] = 'Running' if action == 'start' else 'Stopped'
        elif action == 'move':
            self.records[args[3]] = self.records.pop(name)
            self.records[args[3]]['name'] = args[3]
        elif action == 'copy':
            if self.fail_copy:
                raise RuntimeError('simulated Incus copy failure')
            record = copy.deepcopy(self.records[name])
            record['name'] = args[3]
            record['devices'] = {}
            for index, item in enumerate(args):
                if item == '--config':
                    key, value = args[index+1].split('=',1)
                    record['config'][key] = value
            self.records[args[3]] = record
        elif action == 'config' and args[2:4] == ('device','add'):
            values = {'type':args[6]}
            values.update(item.split('=',1) for item in args[7:])
            self.records[args[4]]['devices'][args[5]] = values
        elif action == 'config' and args[2] == 'set':
            self.records[args[3]]['config'].update(item.split('=',1) for item in args[4:])
        elif action == 'delete':
            del self.records[name]
        else:
            raise AssertionError(args)
        return ''

    def request(self):
        return {'namespace':'echo-cbr','release':NEW,'enabled':True,
                'containers':[{'name':AGENT,'agent_id':AGENT.removeprefix('echo-ai-agent-')}]}

    def test_orphan_backup_is_journaled_and_recovery_preserves_other_namespace(self):
        self.records[AGENT]['status'] = 'Stopped'
        self.records[AGENT]['config']['volatile.uuid'] = 'original-incus-uuid'
        before = copy.deepcopy(self.records)
        request = {**self.request(), 'containers':[], 'reconcile_orphans':True}
        job = HOST.replace_namespace(request)
        self.assertEqual(job['containers'], [])
        self.assertNotIn(AGENT, self.records)
        self.assertIn(job['orphans'][0]['backup'], self.records)
        saved = json.loads((HOST.JOURNALS / (job['id']+'.json')).read_text())
        self.assertEqual(saved['orphans'], job['orphans'])
        HOST.recover({'namespace':'echo-cbr'})
        self.assertEqual(self.records, before)

    def test_running_orphan_is_never_stopped_or_renamed(self):
        request = {**self.request(), 'containers':[], 'reconcile_orphans':True}
        with self.assertRaisesRegex(RuntimeError, 'Orphan is running'):
            HOST.replace_namespace(request)
        self.assertEqual(self.records, self.before)

    def test_absent_database_record_does_not_create_a_container_during_upgrade(self):
        request = self.request()
        request['containers'].append({'name':'not-created-yet', 'state':'absent'})
        job = HOST.replace_namespace(request)
        self.assertEqual([r['name'] for r in job['containers']], [AGENT])
        self.assertNotIn('not-created-yet', self.records)

    def test_upgrade_and_recovery_preserve_other_namespace_and_original_proxy(self):
        job = HOST.replace_namespace(self.request())
        self.assertEqual(self.records[self.other], self.before[self.other])
        self.assertEqual(self.records[AGENT]['config']['user.echo.ai.harness_release'], NEW)
        self.assertEqual(self.records[AGENT]['devices'], self.before[AGENT]['devices'])
        self.assertIn(job['containers'][0]['backup'], self.records)
        result = HOST.recover({'namespace':'echo-cbr'})
        self.assertEqual(result['release'], OLD)
        self.assertEqual(self.records[AGENT], self.before[AGENT])
        self.assertEqual(self.records[self.other], self.before[self.other])
        self.assertFalse((HOST.SELECTIONS / 'echo-cbr.maintenance').exists())

    def test_failed_copy_can_recover_from_persisted_backup(self):
        self.fail_copy = True
        with self.assertRaisesRegex(RuntimeError, 'copy failure'):
            HOST.replace_namespace(self.request())
        self.assertNotIn(AGENT, self.records)
        self.assertTrue((HOST.SELECTIONS / 'echo-cbr.maintenance').exists())
        HOST.recover({'namespace':'echo-cbr'})
        self.assertEqual(self.records[AGENT], self.before[AGENT])
        self.assertEqual(self.records[self.other], self.before[self.other])

    def test_full_host_blocks_verification_before_any_container_changes(self):
        self.records[AGENT]['status'] = 'Stopped'
        before = copy.deepcopy(self.records)
        with mock.patch.object(HOST, 'effective_running', return_value=6):
            with self.assertRaisesRegex(RuntimeError, 'No capacity'):
                HOST.replace_namespace(self.request())
        self.assertEqual(self.records, before)
        self.assertFalse((HOST.SELECTIONS / 'echo-cbr.maintenance').exists())
        self.assertEqual(json.loads((HOST.SELECTIONS / 'echo-cbr.json').read_text())['release'], OLD)


if __name__ == '__main__':
    unittest.main()
