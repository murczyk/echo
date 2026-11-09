#!/usr/bin/env python3
"""Read-only harness advisory after an application deployment."""
import argparse
import contextlib
import io
import re
import shlex
from pathlib import Path
from types import SimpleNamespace

from control import Control, resolve_agent_host, safe_error, shared_inventory_check


def upgrade_status(row, inventory):
    if inventory.get('error'):
        raise RuntimeError(inventory['error'])
    namespace = row['namespace']
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
    if any(not isinstance(release, str) or not re.fullmatch(r'\d{4}\.\d{2}\.\d{2}\.\d+', release) for release in observed):
        raise RuntimeError('Harness version metadata is incomplete')
    return observed != {row['required_release']}, ', '.join(sorted(observed))


def inspect_deployment(controller, host):
    row = controller.probe(host)
    if row.get('protocol') != 1:
        raise RuntimeError(row.get('probe_details') or 'Echo management probe is unavailable')
    if not row.get('namespace') and not row.get('dispatcher'):
        return f'AI harness: not configured on {host}; skipped.'
    if not row.get('running_match'):
        raise RuntimeError(row.get('running_details') or 'Running Echo processes do not match the installed build')
    required = row.get('required_release', '')
    if not re.fullmatch(r'\d{4}\.\d{2}\.\d{2}\.\d+', required):
        raise RuntimeError('Running application did not report a valid harness requirement')
    if not row.get('namespace'):
        raise RuntimeError('Dispatcher namespace is missing')
    connection = resolve_agent_host(row)
    inventory = controller.host_action('inventory', agent_host=connection)
    needed, observed = upgrade_status(row, inventory)
    if not needed:
        return f'AI harness: {host} is current ({required}; {connection}).'
    command = shlex.join(['just', 'ai-control-panel', 'upgrade', '--host', host, '--release', required])
    return (f'AI harness upgrade needed on {host}: observed {observed}; application requires {required}.\n'
            f'Agent host: {connection}\n'
            'Run from an Echo checkout containing this harness release:\n'
            '  cargo build -p wdintel-rs --bin wdintel-rs\n'
            f'  {command} --dry-run\n  {command}')


def deployment_notice(controller, host):
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            notice = inspect_deployment(controller, host)
        return notice
    except Exception as error:
        command = shlex.join(['just', 'ai-control-panel', 'scan', '--host', host, '--json'])
        return f'WARNING: AI harness status is unknown on {host}: {safe_error(error)}\nCheck manually:\n  {command}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('host')
    options = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    controller = Control(SimpleNamespace(repo=repo, executable=Path('/usr/bin/wdintel-rs'), mode='live'))
    print(deployment_notice(controller, options.host))


if __name__ == '__main__':
    main()
