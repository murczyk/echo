#!/usr/bin/env python3
"""Harness check after an application deployment.

By default it only reports. With --sync it upgrades the server's AI harness to
the release the running application requires (preview first) and exits non-zero
unless the harness ends up current or the server has no AI harness.
"""
import argparse
import contextlib
import datetime
import io
import json
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace

from control import Control, resolve_agent_host, safe_error, shared_inventory_check

RELEASE = r'\d{4}\.\d{2}\.\d{2}\.\d+'


def upgrade_status(row, inventory):
    if inventory.get('error'):
        raise RuntimeError(inventory['error'])
    namespace = row['namespace']
    if any(job.get('namespace') == namespace for job in inventory.get('pending', [])):
        raise RuntimeError(f'Interrupted rollout of namespace {namespace}; '
                           f'recovery needs approval: just ai-control-panel recover --host {row["host"]}')
    agents = [entry for entry in inventory['instances']
              if entry['managed'] and entry['namespace'] == namespace]
    shared_inventory_check(row.get('containers', []), agents, False)
    selection = inventory.get('selections', {}).get(namespace)
    if selection:
        template = next((entry for entry in inventory['instances'] if entry['name'] == selection['template']), None)
        selected_release = selection['release']
    else:
        template = next((entry for entry in inventory['instances'] if entry['name'] == 'echo-ai-agent-019fc7f7-9770-7f83-9c1a-211af29b02e6'), None)
        selected_release = inventory.get('template_release')
    if not template or not template.get('template') or template.get('state') != 'stopped' or template.get('release') != selected_release:
        raise RuntimeError('Namespace template is missing or inconsistent')
    observed = {agent.get('release') for agent in agents} | {selected_release}
    if any(not isinstance(release, str) or not re.fullmatch(RELEASE, release) for release in observed):
        raise RuntimeError('Harness version metadata is incomplete')
    return observed != {row['required_release']}, ', '.join(sorted(observed))


def inspect_deployment(controller, host):
    """Return (state, required release, text); state is skipped, current or needed."""
    row = controller.probe(host)
    if row.get('protocol') != 1:
        raise RuntimeError(row.get('probe_details') or 'Echo management probe is unavailable')
    if not row.get('namespace') and not row.get('dispatcher'):
        return 'skipped', None, f'AI harness: not configured on {host}; skipped.'
    if not row.get('running_match'):
        raise RuntimeError(row.get('running_details') or 'Running Echo processes do not match the installed build')
    required = row.get('required_release', '')
    if not re.fullmatch(RELEASE, required):
        raise RuntimeError('Running application did not report a valid harness requirement')
    if not row.get('namespace'):
        raise RuntimeError('Dispatcher namespace is missing')
    connection = resolve_agent_host(row)
    inventory = controller.host_action('inventory', agent_host=connection)
    needed, observed = upgrade_status(row, inventory)
    if not needed:
        return 'current', required, f'AI harness: {host} is current ({required}; {connection}).'
    return 'needed', required, (f'AI harness upgrade needed on {host}: observed {observed}; application requires {required}.\n'
                                f'Agent host: {connection}')


def check(controller, host):
    """Like inspect_deployment, but any failure is state unknown with a warning."""
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            return inspect_deployment(controller, host)
    except Exception as error:
        command = shlex.join(['just', 'ai-control-panel', 'scan', '--host', host, '--json'])
        return 'unknown', None, f'WARNING: AI harness status is unknown on {host}: {safe_error(error)}\nCheck manually:\n  {command}'


def deployment_notice(controller, host):
    state, required, text = check(controller, host)
    if state != 'needed':
        return text
    command = shlex.join(['just', 'ai-control-panel', 'upgrade', '--host', host, '--release', required])
    return (f'{text}\n'
            'Run from an Echo checkout containing this harness release:\n'
            '  cargo build -p wdintel-rs --bin wdintel-rs\n'
            f'  {command} --dry-run\n  {command}')


def show(event, host, release):
    if isinstance(event.get('message'), str):
        print(event['message'], flush=True)
    for row in event.get('hosts', []) if isinstance(event.get('hosts'), list) else []:
        if row.get('host') == host:
            status = row.get('eligibility', {}).get(release) or row.get('routing_error') or 'Unknown compatibility'
            print(f"{host} | {row.get('agent_host', 'agent host unknown')} | {row.get('namespace')} | "
                  f"{row.get('deployed', '?')} | requires {row.get('required_release', 'unknown')} | "
                  f'target {release}: {status}', flush=True)


def run_panel(repo, host, release, dry_run):
    """Run the control panel's upgrade for one host, as `just ai-control-panel` does; True on success.

    The checkout's control.py does the work, so no local Rust build is needed or
    can be stale. It runs in its own session: Ctrl-C only asks it to stop at a
    safe boundary, and this keeps waiting until it has.
    """
    directory = repo / '.dev-runtime/ai-control-panel'
    directory.mkdir(parents=True, exist_ok=True)
    cancel_file = directory / f'cancel-{uuid.uuid4()}'
    request = {'hosts': [host], 'selected': [host], 'release': release, 'reconcile_orphans': False,
               'dry_run': dry_run, 'cancel_file': str(cancel_file)}
    interrupted = False

    def cancel(signum, frame):
        nonlocal interrupted
        if not interrupted:
            interrupted = True
            cancel_file.write_text('cancel')
            print('Cancellation requested; waiting for a safe boundary.', file=sys.stderr, flush=True)

    previous = signal.signal(signal.SIGINT, cancel)
    try:
        with tempfile.NamedTemporaryFile('w', prefix='echo-ai-control-panel-', suffix='.log', delete=False) as log:
            print(f'AI control panel log: {log.name}', flush=True)
            # The executable only probes a local dev instance in the fleet scan, as in `just ai-control-panel`.
            process = subprocess.Popen(
                [sys.executable, str(repo / 'deploy/ai-control-panel/control.py'), 'upgrade', '--repo', str(repo),
                 '--executable', str(repo / 'target/debug/wdintel-rs'), '--mode', 'debug'],
                cwd=repo, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, start_new_session=True)
            process.stdin.write(json.dumps(request))
            process.stdin.close()
            failed = False
            for line in process.stdout:
                log.write(f'{datetime.datetime.now(datetime.timezone.utc).isoformat()} {line}')
                log.flush()
                try:
                    event = json.loads(line)
                except ValueError:
                    print(line, end='', flush=True)
                    continue
                if isinstance(event, dict):
                    failed |= event.get('error') is True
                    show(event, host, release)
            status = process.wait()
    finally:
        signal.signal(signal.SIGINT, previous)
        cancel_file.unlink(missing_ok=True)
    return status == 0 and not failed and not interrupted


def sync_deployment(controller, host, run=run_panel):
    """Bring the harness to the release the application requires; True when in sync."""
    state, required, text = check(controller, host)
    print(text, flush=True)
    if state in ('skipped', 'current'):
        return True
    if state != 'needed':
        return False
    print(f'Previewing the AI harness upgrade on {host} to {required}…', flush=True)
    if not run(controller.repo, host, required, dry_run=True):
        print(f'AI harness upgrade preview failed on {host}; nothing was changed.', flush=True)
        return False
    print(f'Upgrading the AI harness on {host} to {required}…', flush=True)
    if not run(controller.repo, host, required, dry_run=False):
        print(f'AI harness upgrade failed on {host}.', flush=True)
        return False
    state, _, text = check(controller, host)
    print(text, flush=True)
    return state == 'current'


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('host')
    parser.add_argument('--sync', action='store_true',
                        help='upgrade the harness when needed; exit 1 unless it ends up current')
    options = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    controller = Control(SimpleNamespace(repo=repo, executable=Path('/usr/bin/wdintel-rs'), mode='live'))
    if options.sync:
        sys.exit(0 if sync_deployment(controller, options.host) else 1)
    print(deployment_notice(controller, options.host))


if __name__ == '__main__':
    main()
