"""Authenticated integration checks against a local Echo development instance."""
import base64
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import urllib.parse
import urllib.request
import uuid

from fixtures import checked, literal
from grading import accepted_citation


def database_name(config_text):
    match = re.search(r'^pg_dbname\s*=\s*(.+)$', config_text, re.M)
    if not match:
        raise ValueError('deploy/config.toml has no pg_dbname')
    name = json.loads(match.group(1))
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', name):
        raise ValueError('Unexpected local database name')
    return name


def psql_command(engine, database):
    command = list(engine.get('fixturePsql', ['psql']))
    if '-d' in command:
        command[command.index('-d') + 1] = database
    else:
        command.extend(['-d', database])
    return command + ['-XAtq', '-v', 'ON_ERROR_STOP=1']


def sql(engine, statement, database):
    return checked(psql_command(engine, database), statement)


@contextmanager
def session(root, engine):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    base = engine.get('localBaseUrl', 'http://127.0.0.1:8081').rstrip('/')
    parsed = urllib.parse.urlsplit(base)
    if parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.scheme != 'http':
        raise ValueError('Integration evaluation only supports the local loopback HTTP backend')
    if not engine.get('localLogin'):
        raise ValueError('Explicit localLogin is required in the private engine configuration')
    config = (root / 'deploy/config.toml').read_text()
    database = database_name(config)

    def setting(name, default=None):
        match = re.search(r'^' + re.escape(name) + r'\s*=\s*(.+)$', config, re.M)
        return json.loads(match.group(1)) if match else default

    redis_command = ['redis-cli', '-h', setting('redis_host', '127.0.0.1'), '-p', str(setting('redis_port', 6379)), '--raw']
    identity = sql(engine, f"SELECT id FROM login WHERE login={literal(engine['localLogin'])} AND NOT deleted", database)
    uuid.UUID(identity)
    key = secrets.token_urlsafe(48)
    stamp = int(time.time())
    state = {'actix_identity.user_id': json.dumps(identity), 'actix_identity.logged_in_at': json.dumps(stamp),
             'actix_identity.last_visited_at': json.dumps(stamp), 'id': json.dumps(str(uuid.uuid4()))}
    checked(redis_command + ['-x', 'SET', key], json.dumps(state))
    checked(redis_command + ['EXPIRE', key, '3600'], '')
    nonce = os.urandom(12)
    secret = setting('cookie_session_secret').encode()[32:64]
    cookie = urllib.parse.quote(base64.b64encode(nonce + AESGCM(secret).encrypt(nonce, key.encode(), b'id')).decode())

    def api(path, body=None):
        request = urllib.request.Request(base + path, headers={'Cookie': 'id=' + cookie, 'Content-Type': 'application/json'},
                                         data=None if body is None else json.dumps(body).encode())
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)

    try:
        yield api
    finally:
        checked(redis_command + ['DEL', key], '')


def request_result(case, repeat, api, engine, timeout, database):
    engine_id = sql(engine, f"SELECT id FROM ai_engine WHERE model_name={literal(engine['model_name'])} AND enabled LIMIT 1", database)
    uuid.UUID(engine_id)
    configuration = api('/api/ai-agent/configuration')
    if not configuration['featureEnabled'] or not any(item['id'] == engine_id for item in configuration['providers']):
        raise ValueError('Requested engine is not available to the selected local user')
    conversation_id = None
    events, requests = [], []
    started = time.monotonic()
    answer = ''
    state = None
    for prompt in case['turns']:
        created = api('/api/ai-agent/requests/create', {'conversationId': conversation_id, 'aiEngineId': engine_id, 'prompt': prompt})
        request_id = str(uuid.UUID(created['requestId']))
        requests.append(request_id)
        conversation_id = created['conversationId']
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            raw = sql(engine, f"SELECT json_build_object('state',state,'response',response) FROM ai_agent_request WHERE id={literal(request_id)}", database)
            if not raw:
                time.sleep(1)
                continue
            row = json.loads(raw)
            if row['state'] not in ('queued', 'running'):
                state, answer = row['state'], row['response'] or ''
                break
            time.sleep(1)
        else:
            api('/api/ai-agent/requests/cancel', {'requestId': request_id})
            state = 'timeout'
        rows = json.loads(sql(engine, f"SELECT coalesce(json_agg(json_build_object('type',event_type,'payload',payload) ORDER BY sequence),'[]') FROM ai_agent_request_event WHERE request_id={literal(request_id)}", database))
        events.extend({'type': row['type'], **row['payload']} for row in rows)
        events.append({'type': 'eval_answer', 'text': answer})
        if state != 'completed':
            break
    tools = [event.get('arguments', {}) for event in events if event.get('type') == 'tool_start' and event.get('tool') == 'echo_inbox_messages']
    text_calls = sum(bool(args.get('search') and not args.get('selectedCallsigns')) for args in tools)
    tag_calls = sum(bool(args.get('selectedCallsigns') and not args.get('search')) for args in tools)
    delivered = {citation['messageId'] for event in events if event.get('type') == 'message_citations' for citation in event.get('citations', [])}
    expected = set(case['expect'].get('evidenceIds', []))
    identifiers = {citation['messageIdentifier']: citation['messageId']
                   for event in events if event.get('type') == 'message_citations'
                   for citation in event.get('citations', [])}
    cited = set()
    invalid_citations = []
    for target in re.findall(r'\]\(([^\s)]+)\)', answer):
        message_id = accepted_citation(target, identifiers)
        if message_id is None:
            invalid_citations.append(target)
        else:
            cited.add(message_id)
    failures = []
    if state != 'completed' or not answer:
        failures.append('execution')
    if not text_calls or not tag_calls:
        failures.append('complementary_search_missing')
    if not expected.issubset(delivered):
        failures.append('required_evidence_not_retrieved')
    if not expected & cited:
        failures.append('required_evidence_not_cited')
    if invalid_citations:
        failures.append('unregistered_citation')
    return events, {'caseId': case['id'], 'category': case['category'], 'split': case['split'], 'repeat': repeat,
                    'passed': not failures, 'failures': failures, 'answer': answer, 'requestIds': requests,
                    'retrievedIds': sorted(delivered), 'citedIds': sorted(cited), 'textSearches': text_calls,
                    'tagSearches': tag_calls, 'toolErrors': sum(event.get('type') == 'tool_end' and event.get('is_error', False) for event in events),
                    'latencyMs': round((time.monotonic() - started) * 1000)}


def run_local(cases, args, engine, run_dir):
    if args.runner_ref or any(not case.get('provenance') for case in cases):
        raise ValueError('Local integration uses the installed harness and captured real cases only; select --case explicitly')
    root = Path(__file__).resolve().parents[2]
    database = database_name((root / 'deploy/config.toml').read_text())
    results = []
    with open('/tmp/echo-ai-eval-local.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = sql(engine, 'SELECT mattermost_chat_enabled FROM ai_agent_settings', database)
        if previous not in ('t', 'f'):
            raise ValueError('Unexpected local AI settings')
        try:
            sql(engine, 'UPDATE ai_agent_settings SET mattermost_chat_enabled=false', database)
            with session(root, engine) as api:
                for case in cases:
                    for repeat in range(1, args.repeat + 1):
                        events, result = request_result(case, repeat, api, engine, args.timeout, database)
                        results.append(result)
                        (run_dir / f"{case['id']}-{repeat}.trace.jsonl").write_text('\n'.join(json.dumps(event, ensure_ascii=False) for event in events) + '\n')
                        with (run_dir / 'results.jsonl').open('a') as output:
                            output.write(json.dumps(result, ensure_ascii=False) + '\n')
                        print(json.dumps({key: result[key] for key in ('caseId', 'repeat', 'passed', 'failures', 'latencyMs')}), flush=True)
        finally:
            sql(engine, f"UPDATE ai_agent_settings SET mattermost_chat_enabled={'true' if previous == 't' else 'false'}", database)
    return results
