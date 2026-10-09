#!/usr/bin/env python3
"""Operator-only rollout operations; never exposed through the agent dispatcher."""
import contextlib
import ast
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

ROOT = Path('/opt/echo-ai-agent')
SELECTIONS = Path('/etc/echo-ai-agent/namespace-releases')
JOURNALS = Path('/var/lib/echo-ai-agent/rollouts')
LOCKS = Path('/run/lock/echo-ai-agent-rollout')
DISPATCH_LOCK = Path('/run/lock/echo-ai-agent-dispatcher.lock')
FIXED = 'echo-ai-agent-019fc7f7-9770-7f83-9c1a-211af29b02e6'
RELEASE_RE = re.compile(r'^\d{4}\.\d{2}\.\d{2}\.\d+$')
NAMESPACE_RE = re.compile(r'^echo-[a-z0-9][a-z0-9-]{0,47}$')


def run(*args, timeout=120):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{args[0]} {args[1] if len(args)>1 else ""} failed: {result.stdout}\n{result.stderr}')
    return result.stdout


def digest(directory):
    checksum = hashlib.sha256()
    for path in sorted(Path(directory).rglob('*')):
        relative = path.relative_to(directory)
        if {'node_modules', '__pycache__'}.intersection(relative.parts) or path.suffix == '.pyc':
            continue
        if path.is_file():
            checksum.update(str(relative).encode() + b'\0' + hashlib.sha256(path.read_bytes()).digest())
    return checksum.hexdigest()


def manifest(directory):
    path = directory / 'release.json'
    if not path.exists():
        return None
    result = json.loads(path.read_text())
    if result.get('schemaVersion') != 1 or not RELEASE_RE.fullmatch(result.get('release', '')):
        raise RuntimeError('Unsupported release manifest')
    versions = dict(line.split('=', 1) for line in (directory / 'versions.env').read_text().splitlines() if '=' in line)
    for field, key in [('release', 'HARNESS_RELEASE'), ('nodeVersion', 'NODE_VERSION'), ('piVersion', 'PI_VERSION')]:
        if result.get(field) != versions.get(key):
            raise RuntimeError(f'Release manifest disagrees with {key}')
    tree = ast.parse((directory / 'dispatcher/echo_ai_agent_dispatcher.py').read_text())
    assignments = {node.targets[0].id: node.value for node in tree.body if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)}
    if ast.literal_eval(assignments['HARNESS_RELEASE']) != result['release']:
        raise RuntimeError('Dispatcher release disagrees with manifest')
    if ast.literal_eval(assignments['RUNNER_PROTOCOL_VERSION']) != result.get('runnerProtocolVersion'):
        raise RuntimeError('Runner protocol disagrees with manifest')
    supported = assignments['COMPATIBLE_RUNNER_RELEASES'].args[0].elts
    supported = {result['release'] if isinstance(value, ast.Name) and value.id == 'HARNESS_RELEASE' else ast.literal_eval(value) for value in supported}
    if supported != set(result['supportedRunnerReleases']):
        raise RuntimeError('Dispatcher compatibility disagrees with manifest')
    return result


def instances():
    return json.loads(run('incus', 'list', '--format=json'))


def summary(instance):
    config = instance.get('config', {})
    name = instance['name']
    return {'name': name, 'namespace': config.get('user.echo.ai.namespace'),
            'release': config.get('user.echo.ai.harness_release'),
            'state': instance['status'].lower(),
            'template': config.get('user.echo.ai.template.ready') == 'true',
            'managed': config.get('user.echo.ai.managed') == 'true' and bool(re.fullmatch(r'echo-ai-agent-[0-9a-f-]{36}', name)),
            'agent_id': config.get('user.echo.ai.agent_id'), 'incus_uuid': config.get('volatile.uuid')}


def inventory():
    records = instances()
    releases = []
    for directory in sorted((ROOT / 'releases').glob('*')):
        if directory.is_dir() and RELEASE_RE.fullmatch(directory.name):
            release = {'release': directory.name, 'manifest': None, 'digest': digest(directory), 'source': 'retained'}
            try:
                release['manifest'] = manifest(directory)
            except (OSError, RuntimeError, ValueError, LookupError, SyntaxError, AttributeError, TypeError) as error:
                release['manifest_error'] = str(error)
            releases.append(release)
    template = next((row for row in records if row['name'] == FIXED), {})
    current = (ROOT / 'current').resolve()
    selections = {path.stem: json.loads(path.read_text()) for path in SELECTIONS.glob('*.json')}
    namespaces = [path.read_text().strip() for path in Path('/etc/echo-ai-agent/namespaces').glob('*') if path.is_file()]
    return {'dispatcher_release': current.name, 'template_release': summary(template)['release'] if template else None,
            'releases': releases, 'instances': [summary(row) for row in records], 'selections': selections,
            'namespaces': namespaces, 'namespace_templates': (current / 'bin/control-host.py').exists(),
            'pending': [json.loads(path.read_text()) for path in JOURNALS.glob('*.json') if json.loads(path.read_text()).get('phase') != 'complete']}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    temporary = path.with_suffix('.new')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600 if path.parent == JOURNALS else 0o644)
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


@contextlib.contextmanager
def lock(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    existed = path.exists()
    with path.open('a') as stream:
        if not existed:
            os.chmod(path, 0o644)
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def validate_template(record, release, metadata):
    config = record.get('config', {})
    expected = {'user.echo.ai.harness_release': release, 'user.echo.ai.template.ready': 'true',
                'user.echo.ai.guestapi_disabled': 'true', 'user.echo.ai.container_uid': '29720',
                'user.echo.ai.container_gid': '29720', 'user.echo.ai.node_version': metadata['nodeVersion'],
                'user.echo.ai.pi_version': metadata['piVersion']}
    if record['status'].lower() != 'stopped' or record.get('profiles') != ['echo-ai-agent'] or any(config.get(k) != v for k, v in expected.items()):
        raise RuntimeError('Template does not match release or isolation requirements')


def release_request(request):
    directory = Path(request['bundle']).resolve()
    if not (str(directory).startswith('/tmp/echo-ai-control-') or directory.parent == ROOT / 'releases'):
        raise RuntimeError('Unsafe bundle directory')
    metadata = manifest(directory)
    if metadata is None or digest(directory) != request['digest']:
        raise RuntimeError('Bundle digest or metadata changed')
    release = metadata['release']
    installed = ROOT / 'releases' / release
    if installed.exists() and digest(installed) != request['digest']:
        raise RuntimeError('Release identity already contains different bytes; bump HARNESS_RELEASE')
    return directory, metadata


def build_release(request):
    directory, metadata = release_request(request)
    release = metadata['release']
    validate_shared_update(directory, metadata)
    name = 'echo-ai-agent-template-' + release.replace('.', '-')
    output = run('bash', str(directory / 'bin/build-template-host.sh'), 'true', name, timeout=3600)
    validate_template(next(row for row in instances() if row['name'] == name), release, metadata)
    return {'ok': True, 'diagnostic': output}


def validate_shared_update(directory, metadata):
    current = (ROOT / 'current').resolve()
    contract = ['config/host.env', 'config/sshd_config', 'config/echo-ai-agent.nft',
                'bin/force-command.sh', 'bin/dispatcher-identity.sh', 'bin/apply-firewall.sh']
    contract += [str(path.relative_to(directory)) for path in (directory / 'systemd').glob('*')]
    for relative in contract:
        if (current / relative).read_bytes() != (directory / relative).read_bytes():
            raise RuntimeError(f'Shared infrastructure changed: {relative}; deploy it separately')
    versions = dict(line.split('=', 1) for line in (current / 'versions.env').read_text().splitlines() if '=' in line)
    if versions.get('NODE_VERSION') != metadata['nodeVersion'] or versions.get('PI_VERSION') != metadata['piVersion']:
        raise RuntimeError('Shared runtime changed; deploy it separately')


def install_release(directory):
    release = manifest(directory)['release']
    installed = ROOT / 'releases' / release
    if not installed.exists():
        staging = ROOT / 'releases' / f'.control-{uuid.uuid4().hex}'
        try:
            shutil.copytree(directory, staging, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', 'node_modules'))
            for path in [staging, *staging.rglob('*')]:
                if path.is_symlink():
                    raise RuntimeError('Bundle symlinks are not supported')
                os.chown(path, 0, 0)
                path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
            staging.rename(installed)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    elif digest(installed) != digest(directory):
        raise RuntimeError('Installed release bytes differ')
    return installed


def publish_release(installed):
    for name, target in [('previous', (ROOT / 'current').resolve()), ('current', installed)]:
        temporary = ROOT / f'.{name}-{uuid.uuid4().hex}'
        temporary.symlink_to(target)
        temporary.replace(ROOT / name)


def check_pinned_template(directory, namespace, release):
    result = subprocess.run(['python3', str(directory / 'dispatcher/echo_ai_agent_dispatcher.py'), '--namespace', namespace],
                            input=json.dumps({'id':'rollout-preflight', 'operation':'preflight'})+'\n',
                            text=True, capture_output=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f'{namespace}: dispatcher preflight failed: {result.stderr[-1000:]}')
    response = json.loads(result.stdout)
    if not response.get('ok') or response.get('result', {}).get('harness_release') != release:
        raise RuntimeError(f'{namespace}: dispatcher preflight did not preserve template release: {response}')


def prepare(request):
    directory, metadata = release_request(request)
    release = metadata['release']
    with lock(Path('/run/lock/echo-ai-agent-deploy.lock')), lock(Path('/run/lock/echo-ai-control-prepare.lock')), lock(DISPATCH_LOCK):
        validate_shared_update(directory, metadata)
        records = instances()
        for row in records:
            info = summary(row)
            if info['managed'] and info['release'] not in metadata['supportedRunnerReleases']:
                raise RuntimeError(f'Unsupported deployed runner: {info["name"]}')
        old = next(row for row in records if row['name'] == FIXED)
        old_release = old['config']['user.echo.ai.harness_release']
        name = 'echo-ai-agent-template-' + release.replace('.', '-')
        validate_template(next(row for row in records if row['name'] == name), release, metadata)
        installed = install_release(directory)
        for path in Path('/etc/echo-ai-agent/namespaces').glob('*'):
            namespace = path.read_text().strip()
            if not NAMESPACE_RE.fullmatch(namespace):
                raise RuntimeError('Invalid registered namespace')
            selection = SELECTIONS / f'{namespace}.json'
            if not selection.exists():
                write_json(selection, {'release': old_release, 'template': FIXED})
            with lock(LOCKS / f'{namespace}.lock'):
                check_pinned_template(installed, namespace, json.loads(selection.read_text())['release'])
        publish_release(installed)
        return {'ok': True, 'release': release, 'template': name}


def reconcile_inventory(containers, owned, allow_orphans=False):
    known = {row['name']: row for row in containers}
    present = {row['name']: row for row in owned}
    missing = sorted(name for name, row in known.items() if row.get('state') != 'absent' and name not in present)
    if missing:
        raise RuntimeError('Database/container inventory differs; missing agents: ' + ', '.join(missing))
    orphans = [row for name, row in present.items() if name not in known]
    if orphans and not allow_orphans:
        raise RuntimeError('Orphaned agents: use --reconcile-orphans to retain stopped backups: ' + ', '.join(row['name'] for row in orphans))
    for row in orphans:
        if row['state'] != 'stopped' or row.get('agent_id') != row['name'].removeprefix('echo-ai-agent-'):
            raise RuntimeError('Orphan is running or has an inconsistent identity: ' + row['name'])
    for name in present.keys() & known.keys():
        if present[name].get('agent_id') != known[name].get('agent_id'):
            raise RuntimeError('Agent identity differs from database inventory: ' + name)
    return orphans


def checked_namespace(request):
    namespace = request['namespace']
    if not NAMESPACE_RE.fullmatch(namespace):
        raise RuntimeError('Invalid namespace')
    if namespace not in [path.read_text().strip() for path in Path('/etc/echo-ai-agent/namespaces').glob('*')]:
        raise RuntimeError('Namespace is not registered')
    return namespace


def effective_running(records, exclude_reservation=None):
    counts = {}
    for row in records:
        item = summary(row)
        if item['managed'] and item['state'] == 'running':
            counts[item['namespace']] = counts.get(item['namespace'], 0) + 1
    total = sum(counts.values())
    for marker in SELECTIONS.glob('*.maintenance'):
        if marker.stem != exclude_reservation:
            reservation = json.loads(marker.read_text()).get('reserved_slots', 0)
            total += max(0, reservation - counts.get(marker.stem, 0))
    return total


def reserve_namespace(journal):
    namespace = journal['namespace']
    running = sum(row['state'] == 'running' for row in journal['containers'])
    slots = max(running, int(bool(journal['containers'])))
    with lock(DISPATCH_LOCK):
        if effective_running(instances()) - running + slots > 6:
            raise RuntimeError('No capacity for rollout verification; stop an idle agent first')
        write_json(JOURNALS / f'{journal["id"]}.json', journal)
        write_json(SELECTIONS / f'{namespace}.maintenance', {'id': journal['id'], 'reserved_slots': slots})


def replace_namespace(request):
    namespace = checked_namespace(request)
    release = request['release']
    if not RELEASE_RE.fullmatch(release):
        raise RuntimeError('Invalid release')
    metadata = manifest(ROOT / 'releases' / release)
    if metadata is None:
        raise RuntimeError('Release has no verified metadata')
    with lock(LOCKS / f'{namespace}.lock'):
        if any(job['phase'] != 'complete' for job in namespace_jobs(namespace)):
            raise RuntimeError('An unfinished rollout needs recovery')
        records = instances()
        template = 'echo-ai-agent-template-' + release.replace('.', '-')
        validate_template(next(row for row in records if row['name'] == template), release, metadata)
        owned = [row for row in records if summary(row)['managed'] and summary(row)['namespace'] == namespace]
        orphans = reconcile_inventory(request['containers'], [summary(row) for row in owned], request.get('reconcile_orphans', False))
        orphan_names = {row['name'] for row in orphans}
        job = f'{namespace}-{time.time_ns()}'
        journal = {'id': job, 'namespace': namespace, 'release': release, 'phase': 'replacing',
                   'previous_selection': json.loads((SELECTIONS / f'{namespace}.json').read_text()),
                   'containers': [], 'orphans': [], 'enabled': request['enabled']}
        for record in owned:
            if record['name'] in orphan_names:
                if not record['config'].get('volatile.uuid'):
                    raise RuntimeError('Orphan has no Incus identity for recovery')
                journal['orphans'].append({'name':record['name'], 'backup':f'ai-orphan-{uuid.uuid4().hex}',
                                           'incus_uuid':record['config'].get('volatile.uuid')})
                continue
            journal['containers'].append({'name': record['name'], 'backup': f'ai-rollout-{uuid.uuid4().hex}',
                                          'state': record['status'].lower(), 'devices': record.get('devices', {}),
                                          'incus_uuid': record.get('config', {}).get('volatile.uuid'),
                                          'config': {key: value for key, value in record.get('config', {}).items() if key.startswith('user.echo.ai.')},
                                          'stage': 'pending'})
        reserve_namespace(journal)
        write_json(SELECTIONS / f'{namespace}.json', {'release': release, 'template': template})
        for record in journal['orphans']:
            run('incus', 'move', record['name'], record['backup'])
        for record in journal['containers']:
            replace_container(record, template, journal)
        journal['phase'] = 'verifying'
        write_json(JOURNALS / f'{job}.json', journal)
        return journal


def replace_container(record, template, journal):
    name = record['name']
    if record['state'] == 'running':
        run('incus', 'stop', name, '--timeout=60')
    run('incus', 'move', name, record['backup'])
    record['stage'] = 'backed_up'
    write_json(JOURNALS / f'{journal["id"]}.json', journal)
    config = {key: value for key, value in record['config'].items() if key in {
        'user.echo.ai.namespace', 'user.echo.ai.agent_id', 'user.echo.ai.echo_hostname', 'user.echo.ai.echo_upstream', 'user.echo.ai.vllm_upstream', 'user.echo.ai.provider_transport'}}
    config.update({'user.echo.ai.managed': 'true', 'user.echo.ai.template.ready': 'false', 'user.echo.ai.template_source': template,
                   'security.protection.delete': 'false', 'boot.autostart': 'false'})
    options = [item for key, value in config.items() for item in ('--config', f'{key}={value}')]
    run('incus', 'copy', template, name, '--profile=echo-ai-agent', *options)
    for device, values in record['devices'].items():
        if device not in {'echo-upstream', 'vllm-upstream'} or values.get('type') != 'proxy':
            raise RuntimeError('Unexpected instance device; refusing replacement')
        run('incus', 'config', 'device', 'add', name, device, 'proxy', *(f'{key}={value}' for key, value in values.items() if key != 'type'))
    record['stage'] = 'replaced'
    write_json(JOURNALS / f'{journal["id"]}.json', journal)


def namespace_jobs(namespace):
    jobs = [json.loads(path.read_text()) for path in JOURNALS.glob(f'{namespace}-*.json')]
    return [job for job in jobs if job['namespace'] == namespace]


def load_job(request):
    namespace = checked_namespace(request)
    jobs = namespace_jobs(namespace)
    jobs = [job for job in jobs if job['phase'] != 'complete']
    if len(jobs) != 1:
        raise RuntimeError('Expected exactly one unfinished rollout')
    return jobs[0]


def control_container(request):
    namespace = checked_namespace(request)
    with lock(LOCKS / f'{namespace}.lock'):
        with lock(DISPATCH_LOCK):
            return control_container_locked(request)


def control_container_locked(request):
    job = load_job(request)
    record = next(row for row in job['containers'] if row['name'] == request['name'])
    action = request['action']
    if action == 'start':
        running = effective_running(instances(), job['namespace'])
        if running >= 6:
            raise RuntimeError('Shared running-container limit reached')
        run('incus', 'start', record['name'])
        hostname = record['config'].get('user.echo.ai.echo_hostname')
        if not hostname:
            raise RuntimeError('Container has no configured Echo hostname')
        run('incus', 'exec', record['name'], '--', '/usr/local/sbin/echo-ai-agent-configure-network', hostname)
    elif action == 'stop':
        run('incus', 'stop', record['name'], '--timeout=60')
    else:
        raise RuntimeError('Invalid container action')
    return {'ok': True}


def finish(request):
    job = load_job(request)
    with lock(LOCKS / f'{job["namespace"]}.lock'):
        if job['phase'] != 'verifying':
            raise RuntimeError('Rollout has not reached verification')
        observed = {row['name']: summary(row) for row in instances()}
        for record in job['containers']:
            current = observed[record['name']]
            if current['release'] != job['release'] or current['namespace'] != job['namespace'] or current['state'] != record['state']:
                raise RuntimeError('Container state changed before completion')
        job['phase'] = 'complete'
        write_json(JOURNALS / f'{job["id"]}.json', job)
        (SELECTIONS / f'{job["namespace"]}.maintenance').unlink(missing_ok=True)
        return {'ok': True, 'states': [{'name':row['name'], 'state':row['state']} for row in job['containers']]}


def recover(request):
    job = load_job(request)
    with lock(LOCKS / f'{job["namespace"]}.lock'):
        records = {row['name']: row for row in instances()}
        observed = {name: summary(row) for name,row in records.items()}
        for record in job['containers']:
            if record['backup'] not in observed:
                original = records.get(record['name'], {})
                same_instance = record.get('incus_uuid') and original.get('config', {}).get('volatile.uuid') == record['incus_uuid']
                if record['stage'] not in {'pending','recovered'} and not same_instance:
                    raise RuntimeError('A required recovery backup is missing')
                if observed.get(record['name'], {}).get('namespace') != job['namespace']:
                    raise RuntimeError('Original container ownership changed')
                restore_power(record, observed[record['name']]['state'])
                continue
            if observed[record['backup']]['namespace'] != job['namespace']:
                raise RuntimeError('Backup ownership changed')
            if record['name'] in observed:
                if observed[record['name']]['namespace'] != job['namespace']:
                    raise RuntimeError('Replacement ownership changed')
                if observed[record['name']]['state'] == 'running':
                    run('incus', 'stop', record['name'], '--timeout=60')
                run('incus', 'config', 'set', record['name'], 'security.protection.delete=false')
                run('incus', 'delete', record['name'])
            run('incus', 'move', record['backup'], record['name'])
            record['stage'] = 'recovered'
            write_json(JOURNALS / f'{job["id"]}.json', job)
            restore_power(record, 'stopped')
        restore_orphans(job)
        write_json(SELECTIONS / f'{job["namespace"]}.json', job['previous_selection'])
        job['phase'] = 'complete'
        job['recovered'] = True
        write_json(JOURNALS / f'{job["id"]}.json', job)
        (SELECTIONS / f'{job["namespace"]}.maintenance').unlink(missing_ok=True)
        return {'ok': True, 'enabled': job['enabled'], 'release': job['previous_selection']['release'], 'states': [{'name':r['name'],'state':r['state']} for r in job['containers']]}


def restore_orphans(job):
    observed = {row['name']: summary(row) for row in instances()}
    for record in job.get('orphans', []):
        name = record['backup'] if record['backup'] in observed else record['name']
        current = observed.get(name, {})
        if (current.get('namespace') != job['namespace'] or not record.get('incus_uuid')
                or current.get('incus_uuid') != record['incus_uuid'] or current.get('state') != 'stopped'):
            raise RuntimeError('Orphan backup ownership or identity changed: ' + name)
        if name == record['backup']:
            if record['name'] in observed:
                raise RuntimeError('Orphan original name has been reused')
            run('incus', 'move', name, record['name'])


def restore_power(record, current):
    if record['state'] == current:
        return
    if record['state'] == 'running':
        run('incus', 'start', record['name'])
    else:
        run('incus', 'stop', record['name'], '--timeout=60')


def job_info(request):
    namespace = checked_namespace(request)
    job = request['job']
    if not re.fullmatch(re.escape(namespace) + r'-[0-9]+', job):
        raise RuntimeError('Invalid rollout journal ID')
    result = json.loads((JOURNALS / f'{job}.json').read_text())
    if result['namespace'] != namespace or result['id'] != job:
        raise RuntimeError('Journal ownership does not match request')
    return result


def cleanup_completed(request):
    job = job_info(request)
    if job['phase'] != 'complete':
        raise RuntimeError('Rollout is not complete')
    marker = SELECTIONS / f'{job["namespace"]}.maintenance'
    if marker.exists():
        if json.loads(marker.read_text())['id'] != job['id']:
            raise RuntimeError('Another rollout owns the maintenance marker')
        marker.unlink()
    return {'ok': True}


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Requires operator sudo access')
    action = sys.argv[1]
    request = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    handlers = {'inventory': lambda _: inventory(), 'build': build_release, 'prepare': prepare, 'replace': replace_namespace,
                'container': control_container, 'finish': finish, 'recover': recover, 'job': job_info, 'cleanup': cleanup_completed}
    print(json.dumps(handlers[action](request)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
