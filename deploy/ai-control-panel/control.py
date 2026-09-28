#!/usr/bin/env python3
"""JSON-lines worker for the Rust AI control panel."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback

AGENT_HOST = 'echo@echo-ai-agent-vm.eagle-atria.ts.net'
AGENT_HOSTNAME = 'echo-ai-agent-vm.eagle-atria.ts.net'
SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes']
HOST_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,252}$')
SCAN_TIMEOUT = 35


def emit(value):
    print(json.dumps(value), flush=True)


def message(text):
    emit({'message': text})


def safe_error(error, limit=1500):
    if isinstance(error, subprocess.TimeoutExpired):
        return f'Command timed out after {error.timeout} seconds'
    text = str(error)
    text = re.sub(r'([a-z][a-z0-9+.-]*://)[^/\s@]*@', r'\1[redacted]@', text)
    text = re.sub(r'(?i)(bearer\s+|(?:token|password|api[_-]?key)\s*[:=]\s*)\S+', r'\1[redacted]', text)
    return text[-limit:] if limit else text


def command(args, input_text=None, timeout=SCAN_TIMEOUT):
    label = safe_error(shlex.join(args), limit=None)
    started = time.monotonic()
    emit({'diagnostic': f'Command: {label} (timeout {timeout}s)'})
    try:
        result = subprocess.run(args, input=input_text, capture_output=True, text=True, timeout=timeout)
    except Exception as error:
        emit({'diagnostic': f'Command failed after {time.monotonic()-started:.1f}s: {label}: {safe_error(error)}'})
        raise
    emit({'diagnostic': f'Command exited {result.returncode} after {time.monotonic()-started:.1f}s: {label}'})
    if result.stderr:
        emit({'diagnostic': safe_error(result.stderr, limit=None)})
    if result.returncode:
        if result.stdout:
            emit({'diagnostic': safe_error(result.stdout, limit=None)})
        raise RuntimeError(safe_error(result.stderr or result.stdout or f'Exit {result.returncode}'))
    return result.stdout


def ssh(host, args):
    if not HOST_RE.fullmatch(host):
        raise ValueError('Enter an SSH alias or user@hostname; configure ports and jump hosts in SSH config')
    options = SSH_OPTIONS.copy()
    if host == AGENT_HOST:
        options += ['-o', 'HostKeyAlias=[echo-ai-agent-vm.eagle-atria.ts.net]:22031']
    return ['ssh', *options, host, shlex.join(args)]


class Control:
    def __init__(self, options):
        self.repo = options.repo.resolve()
        self.executable = options.executable.resolve()
        self.mode = options.mode
        self.bundle = self.repo / 'echo-ai-agent'
        path = self.bundle / 'bin/control-host.py'
        spec = importlib.util.spec_from_file_location('control_host', path)
        self.shared = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.shared)
        self.host_script = path.read_text()

    def host_action(self, action, request=None, timeout=SCAN_TIMEOUT):
        args = ['sudo', '-n', 'python3', '-', action, json.dumps(request or {})]
        output = command(ssh(AGENT_HOST, args), self.host_script, timeout)
        result = json.loads(output)
        if result.get('diagnostic'):
            emit({'diagnostic': safe_error(result['diagnostic'], limit=None)})
        if 'error' in result:
            raise RuntimeError(result['error'])
        return result

    def probe_command(self, host, maintenance=False):
        flag = '--maintenance' if maintenance else '--probe'
        if host == 'local':
            return [str(self.executable), '--mode=' + self.mode, 'ai-control-panel', flag]
        return ssh(host, ['sudo', '-n', '/usr/bin/wdintel-rs', '--mode=live', 'ai-control-panel', flag])

    def probe(self, host):
        started = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
        row = {'host': host, 'scanned_at': started, 'details': ''}
        try:
            result = json.loads(command(self.probe_command(host)))
            row.update(result)
        except Exception as error:
            row['details'] = safe_error(error)
            if host != 'local' and not isinstance(error, subprocess.TimeoutExpired):
                try:
                    sql = 'BEGIN READ ONLY;\n' + (self.repo / 'deploy/ai-control-panel/inventory.sql').read_text() + '\nCOMMIT;'
                    output = command(ssh(host, ['sudo', '-n', '-u', 'postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', 'wd']), sql)
                    row.update(json.loads(output))
                    row['details'] = 'Legacy Echo: inventory available; deploy management-capable Echo to establish compatibility.'
                except Exception as fallback_error:
                    row['details'] += '; inventory: ' + safe_error(fallback_error)
        row['probe_details'] = row['details']
        return row

    def aliases(self, extra):
        listed = command(['just', '--justfile', str(self.repo / 'justfile'), 'servers-ai']).split()
        if (self.repo / 'deploy/config.toml').exists() or (self.repo / 'deploy/config-debug.toml').exists():
            listed.insert(0, 'local')
        hosts = list(dict.fromkeys([*listed, *extra]))
        if any(not HOST_RE.fullmatch(host) for host in hosts):
            raise ValueError('Invalid SSH alias in host list')
        return hosts

    def scan(self, request):
        hosts = self.aliases(request.get('hosts', []))
        previous = {row['host']: row for row in request.get('snapshot', {}).get('hosts', [])}
        selected = request.get('selected', [])
        if selected and not previous:
            hosts = [host for host in hosts if host in selected]
        refreshed = [host for host in hosts if not selected or host in selected or host not in previous]
        message(f'Scanning {len(refreshed)} Echo hosts and shared harness inventory…')
        with ThreadPoolExecutor(max_workers=4) as pool:
            shared_future = pool.submit(self.host_action, 'inventory')
            futures = {pool.submit(self.probe, host): host for host in refreshed}
            for future in as_completed(futures):
                host = futures[future]
                previous[host] = future.result()
                message(f'Scanned {host}')
                row = previous[host]
                emit({'diagnostic': f'{host}: namespace={row.get("namespace", "unknown")}, build={row.get("build", "unknown")}, requires={row.get("required_release", "unknown")}, running_match={row.get("running_match", "unknown")}, active_requests={row.get("active_requests", "unknown")}'})
                if row.get('running_details'):
                    emit({'diagnostic': f'{host}: {row["running_details"]}'})
            try:
                shared = shared_future.result()
            except Exception as error:
                shared = {'error': safe_error(error), 'releases': [], 'instances': []}
        releases = {row['release']: row for row in shared['releases']}
        metadata = self.shared.manifest(self.bundle)
        if metadata:
            release = metadata['release']
            local_digest = self.shared.digest(self.bundle)
            existing = releases.get(release)
            collision = existing and existing['digest'] != local_digest
            releases[release] = {'release': release, 'manifest': metadata, 'digest': local_digest, 'source': 'checkout', 'collision': bool(collision)}
            releases[release]['revision'] = command(['git','-C',str(self.repo),'rev-parse','--short','HEAD']).strip()
            releases[release]['dirty'] = bool(command(['git','-C',str(self.repo),'status','--porcelain','--','echo-ai-agent']).strip())
        for release in releases.values():
            ready = any(row['template'] and row['state'] == 'stopped' and row['release'] == release['release'] and 'backup' not in row['name'] for row in shared['instances'])
            release['template_ready'] = ready
            release['availability'] = release['source'] + (' + template ready' if ready else ' + needs template')
            if release.get('revision'):
                release['availability'] += f' @ {release["revision"]}' + (' (modified)' if release.get('dirty') else '')
            if release.get('collision'):
                release['availability'] += ' — ID collision'
            elif not release.get('manifest'):
                release['availability'] += ' — compatibility unknown'
        data = {'hosts': [previous[host] for host in hosts], 'shared': shared,
                'releases': sorted(releases.values(), key=lambda row: release_key(row['release']), reverse=True)}
        for row in data['hosts']:
            row['stale'] = row['host'] not in refreshed
        decorate(data)
        return data

    def prepare(self, release, data):
        current = data['shared']
        if release['template_ready'] and current.get('namespace_templates'):
            active = next((r for r in current['releases'] if r['release'] == current['dispatcher_release']), {})
            if release['release'] in (active.get('manifest') or {}).get('supportedRunnerReleases', []):
                return
        if release_key(release['release']) < release_key(current['dispatcher_release']):
            raise RuntimeError('Preparing this release would downgrade the shared dispatcher')
        if release['source'] == 'retained':
            directory = '/opt/echo-ai-agent/releases/' + release['release']
        else:
            directory = command(ssh(AGENT_HOST, ['mktemp', '-d', '/tmp/echo-ai-control-XXXXXXXX'])).strip()
            if not re.fullmatch(r'/tmp/echo-ai-control-[a-zA-Z0-9]+', directory):
                raise RuntimeError('Unsafe remote staging path')
            with tempfile.TemporaryFile() as archive:
                with tarfile.open(fileobj=archive, mode='w') as tar:
                    tar.add(self.bundle, arcname='.', filter=lambda info: None if {'node_modules','__pycache__'}.intersection(Path(info.name).parts) or info.name.endswith('.pyc') else info)
                archive.seek(0)
                process = subprocess.run(ssh(AGENT_HOST, ['tar', '-xf', '-', '-C', directory]), stdin=archive, capture_output=True, timeout=120)
                if process.returncode:
                    raise RuntimeError('Harness upload failed')
        message(f'Preparing shared dispatcher and template {release["release"]}; existing namespace pins are preserved')
        try:
            self.host_action('build', {'bundle': directory, 'digest': release['digest']}, timeout=3900)
            self.host_action('prepare', {'bundle': directory, 'digest': release['digest']}, timeout=660)
        finally:
            if directory.startswith('/tmp/echo-ai-control-'):
                command(ssh(AGENT_HOST, ['sudo', '-n', 'rm', '-rf', '--', directory]))

    def upgrade(self, request):
        data = self.scan({**request, 'selected': []})
        emit(data)
        target = next((row for row in data['releases'] if row['release'] == request['release']), None)
        if target is None:
            raise RuntimeError('Unknown target release: ' + request['release'])
        previewed = next((row for row in request.get('snapshot', {}).get('releases', []) if row['release'] == request['release']), target)
        if target['digest'] != previewed['digest']:
            raise RuntimeError('Release contents changed after preview; review the new scan')
        selected = [row for row in data['hosts'] if row['host'] in request['selected']]
        if not selected or set(request['selected']) != {row['host'] for row in selected}:
            raise RuntimeError('Select at least one known host')
        for row in selected:
            status = row['eligibility_reconciled' if request.get('reconcile_orphans') else 'eligibility'][target['release']]
            if status not in {'Ready', 'Current'}:
                details = row.get('running_details', '') if not row.get('running_match') else ''
                raise RuntimeError(f'{row["host"]}: {status}' + (f'. {details}' if details else ''))
        if request.get('dry_run'):
            message('Preview passed; no changes made. Selected: ' + ', '.join(request['selected']))
            return
        selected = [row for row in selected if row['eligibility'].get(target['release']) != 'Current']
        if not selected:
            message('All selected hosts are already current')
            return
        try:
            if cancelled(request):
                return
            self.prepare(target, data)
            for row in sorted(selected, key=lambda row: host_order(row['host'])):
                if cancelled(request):
                    break
                self.upgrade_namespace(row, target, request.get('reconcile_orphans', False))
        finally:
            emit(self.scan({**request, 'selected': []}))

    def journal_path(self, host):
        directory = self.repo / '.dev-runtime/ai-control-panel'
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        return directory / (host + '.json')

    def upgrade_namespace(self, row, target, reconcile_orphans=False):
        host = row['host']
        path = self.journal_path(host)
        if path.exists() and json.loads(path.read_text()).get('phase') != 'complete':
            raise RuntimeError(f'{host}: recover the previous rollout first')
        journal = {'host': host, 'namespace': row['namespace'], 'enabled': row['enabled'], 'phase': 'starting'}
        self.shared.write_json(path, journal)
        try:
            maintenance = Maintenance(self.probe_command(host, maintenance=True))
        except Exception:
            journal['phase'] = 'complete'
            self.shared.write_json(path, journal)
            raise
        try:
            current = maintenance.ready['inventory']
            if any(current.get(key) != row.get(key) for key in ('namespace', 'containers', 'dispatcher', 'template_id')):
                raise RuntimeError('Host inventory changed since preview')
            if maintenance.ready['required_release'] != target['release']:
                raise RuntimeError('Echo harness requirement changed since preview')
            journal['enabled'] = current['enabled']
            self.shared.write_json(path, journal)
            maintenance.call({'action': 'begin'})
            journal['phase'] = 'disabled'
            self.shared.write_json(path, journal)
            message(f'{host}: replacing containers in {row["namespace"]}')
            job = self.host_action('replace', {'namespace': row['namespace'], 'release': target['release'],
                                   'containers': current['containers'], 'enabled': current['enabled'], 'reconcile_orphans': reconcile_orphans}, timeout=600)
            journal['job'] = job['id']
            journal['phase'] = 'verifying'
            self.shared.write_json(path, journal)
            for orphan in job.get('orphans', []):
                message(f'{host}: retained orphan {orphan["name"]} as {orphan["backup"]}')
            maintenance.call({'action':'verify_template'}, timeout=120)
            message(f'{host}: authenticated template preflight passed for {target["release"]}')
            humans = {r['name']: r['human_id'] for r in current['containers']}
            for container in job['containers']:
                self.host_action('container', {'namespace':row['namespace'],'name':container['name'],'action':'start'})
                maintenance.call({'action':'verify','human_id':humans[container['name']]}, timeout=120)
                self.host_action('container', {'namespace':row['namespace'],'name':container['name'],'action':'stop'})
                message(f'{host}: verified {container["name"]}')
            for container in job['containers']:
                if container['state'] == 'running':
                    self.host_action('container', {'namespace':row['namespace'],'name':container['name'],'action':'start'})
            result = self.host_action('finish', {'namespace':row['namespace']})
            journal['states'] = result['states']
            journal['phase'] = 'host_complete'
            self.shared.write_json(path, journal)
            maintenance.call({'action':'finish','states':result['states']})
            journal['phase'] = 'complete'
            self.shared.write_json(path, journal)
            message(f'{host}: upgraded to {target["release"]}')
        except Exception:
            try:
                if journal['phase'] == 'starting':
                    maintenance.call({'action':'abort'})
                    journal['phase'] = 'complete'
                else:
                    self.restore_namespace(journal, maintenance)
                    journal['phase'] = 'complete'
                self.shared.write_json(path, journal)
                message(f'{host}: previous state recovered; batch stopped')
            except Exception as recovery_error:
                message(f'{host}: AI remains disabled; press x to recover. {safe_error(recovery_error)} Journal: {path}')
            raise
        finally:
            maintenance.close()

    def recover(self, request):
        if len(request['selected']) != 1:
            raise RuntimeError('Highlight one host to recover')
        host = request['selected'][0]
        path = self.journal_path(host)
        journal = json.loads(path.read_text())
        if journal['phase'] == 'complete':
            raise RuntimeError('No unfinished local rollout')
        maintenance = Maintenance(self.probe_command(host, maintenance=True))
        try:
            if maintenance.ready['inventory']['namespace'] != journal['namespace']:
                raise RuntimeError('Saved rollout belongs to a different namespace')
            maintenance.call({'action':'begin'})
            self.restore_namespace(journal, maintenance)
            journal['phase'] = 'complete'
            self.shared.write_json(path, journal)
            message(f'{host}: recovery complete')
        finally:
            maintenance.close()
        emit(self.scan({**request,'selected':[]}))

    def restore_namespace(self, journal, maintenance):
        states = journal.get('states', [])
        release = maintenance.ready['required_release']
        if journal.get('job'):
            saved = self.host_action('job', {'namespace':journal['namespace'],'job':journal['job']})
            if saved['phase'] == 'complete':
                states = [{'name':r['name'],'state':r['state']} for r in saved['containers']]
                release = saved['previous_selection']['release'] if saved.get('recovered') else saved['release']
                self.host_action('cleanup', {'namespace':journal['namespace'],'job':journal['job']})
        pending = self.host_action('inventory')['pending']
        if any(job['namespace'] == journal['namespace'] for job in pending):
            result = self.host_action('recover', {'namespace':journal['namespace']}, timeout=600)
            states = result['states']
            release = result['release']
        compatible = release == maintenance.ready['required_release']
        maintenance.call({'action':'finish','states':states,'enabled':journal['enabled'] and compatible})
        if not compatible:
            message('Containers recovered, but AI remains disabled: recovered harness does not match the running Echo build.')


class Maintenance:
    def __init__(self, args):
        emit({'diagnostic': 'Starting maintenance helper: ' + safe_error(shlex.join(args), limit=None)})
        self.errors = tempfile.TemporaryFile(mode='w+')
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors, text=True)
        try:
            self.ready = self.read()
        except Exception:
            self.close()
            raise
        if not self.ready.get('ready'):
            self.close()
            raise RuntimeError('Maintenance lock was not acquired; unexpected handshake fields: ' + ', '.join(sorted(self.ready)))

    def read(self, timeout=SCAN_TIMEOUT):
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout):
                raise RuntimeError('Maintenance helper timed out')
        line = self.process.stdout.readline()
        if not line:
            self.errors.seek(0)
            raise RuntimeError(safe_error(self.errors.read()))
        result = json.loads(line)
        emit({'diagnostic': 'Maintenance response: ' + safe_error(json.dumps(result), limit=None)})
        return result

    def call(self, request, timeout=SCAN_TIMEOUT):
        self.process.stdin.write(json.dumps(request)+'\n')
        self.process.stdin.flush()
        result = self.read(timeout)
        if not result.get('ok'):
            raise RuntimeError('Maintenance helper rejected operation: ' + safe_error(json.dumps(result)))
        return result

    def close(self):
        try:
            self.process.stdin.close()
        except BrokenPipeError:
            pass
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=10)
        self.process.stdout.close()
        self.errors.close()


def release_key(release):
    return tuple(int(part) for part in release.split('.'))


def host_order(host):
    return (0 if host == 'local' else 1 if 'staging' in host else 2, host)


def cancelled(request):
    if request.get('cancel_file') and Path(request['cancel_file']).exists():
        message('Cancelled at a safe boundary; completed namespaces remain upgraded.')
        return True
    return False


def shared_inventory_check(containers, owned, reconcile_orphans):
    path = Path(__file__).resolve().parents[2] / 'echo-ai-agent/bin/control-host.py'
    spec = importlib.util.spec_from_file_location('inventory_guard', path)
    shared = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shared)
    return shared.reconcile_inventory(containers, owned, reconcile_orphans)


def blockers(row, release, data, reconcile_orphans=False):
    shared = data['shared']
    if shared.get('error'):
        return 'Shared host unavailable'
    if not row.get('namespace'):
        return 'Not configured / unavailable'
    if row.get('stale'):
        return 'Stale: refresh this host'
    if sum(other.get('namespace') == row['namespace'] for other in data['hosts']) != 1:
        return 'Duplicate namespace aliases'
    if row.get('protocol') != 1:
        return 'Unknown compatibility: update Echo management helper'
    if not row.get('running_match'):
        return 'Start/restart matching Echo build'
    if row.get('dispatcher', {}).get('host') != AGENT_HOSTNAME:
        return 'Unsupported shared agent host'
    if row.get('template_id') != '019fc7f7-9770-7f83-9c1a-211af29b02e6':
        return 'Unsupported logical template ID'
    if row.get('active_requests') != 0:
        return 'Busy: queued/running requests'
    if any(job['namespace'] == row['namespace'] for job in shared.get('pending', [])):
        return 'Interrupted rollout: recover first'
    if release.get('collision'):
        return 'Release ID contains different bundle bytes'
    metadata = release.get('manifest')
    if not metadata or not metadata.get('namespaceTemplates'):
        return 'Unknown release compatibility'
    if row.get('required_release') != release['release']:
        return f'Requires Echo build for {release["release"]}'
    if not set(metadata['requiredMigrations']).issubset(row.get('migrations', [])):
        return 'Apply required Echo migrations first'
    owned = [agent for agent in shared['instances'] if agent['managed'] and agent['namespace'] == row['namespace']]
    try:
        shared_inventory_check(row.get('containers', []), owned, reconcile_orphans)
    except RuntimeError as error:
        return str(error)
    if any(agent['release'] not in metadata['supportedRunnerReleases'] for agent in shared['instances'] if agent['managed']):
        return 'Shared dispatcher would reject another deployed runner'
    if all(agent['release'] == release['release'] for agent in owned) and shared.get('selections', {}).get(row['namespace'], {}).get('release') == release['release']:
        return 'Current'
    return 'Ready'


def decorate(data):
    for row in data['hosts']:
        deployed = {}
        for instance in data['shared']['instances']:
            if instance['managed'] and instance['namespace'] == row.get('namespace'):
                version = instance['release'] or 'unknown'
                deployed[version] = deployed.get(version, 0)+1
        row['deployed'] = ', '.join(f'{version} ×{count}' for version,count in sorted(deployed.items())) or 'No containers'
        if data['shared'].get('error') or not row.get('namespace'):
            row['deployed'] = 'Unknown'
        row['eligibility'] = {release['release']: blockers(row,release,data) for release in data['releases']}
        row['eligibility_reconciled'] = {release['release']: blockers(row,release,data,True) for release in data['releases']}
        if not deployed and row.get('namespace') in data['shared'].get('selections', {}):
            row['deployed'] = data['shared']['selections'][row['namespace']]['release'] + ' (template; 0 agents)'
        row['details'] = ' | '.join(part for part in [row.get('probe_details', ''), row.get('running_details', ''),
            f'Active requests: {row.get("active_requests", "unknown")}',
            f'Namespace target: {data["shared"].get("selections", {}).get(row.get("namespace"), {}).get("release", "legacy default")}'] if part)
        if data['shared'].get('error'):
            row['details'] += ' | Shared host: ' + data['shared']['error']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['scan','upgrade','recover'])
    parser.add_argument('--repo',type=Path,required=True)
    parser.add_argument('--executable',type=Path,required=True)
    parser.add_argument('--mode',default='debug')
    options = parser.parse_args()
    request = json.load(sys.stdin)
    message(f'AI control panel: action={options.action}, mode={options.mode}, repo={options.repo.resolve()}, hosts={request.get("selected") or "all"}, added_hosts={request.get("hosts", [])}, release={request.get("release") or "catalog"}, reconcile_orphans={bool(request.get("reconcile_orphans"))}, dry_run={bool(request.get("dry_run"))}, probe={options.executable}')
    control = Control(options)
    if options.action == 'scan':
        emit(control.scan(request))
    elif options.action == 'upgrade':
        control.upgrade(request)
    else:
        control.recover(request)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit({'message': safe_error(error), 'error': True})
        emit({'diagnostic': safe_error(traceback.format_exc(), limit=None)})
        sys.exit(1)
