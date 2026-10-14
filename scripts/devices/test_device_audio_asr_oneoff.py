#!/usr/bin/env python3
"""Exercise the standalone ASR CLI using only a fresh, owned loopback environment."""

import argparse
import http.cookiejar
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request
import uuid
import wave

import device_audio_harness as audio
import file_preview_harness as shared

BINARY = shared.REPO / 'target/debug/wdintel-rs'
COMMAND = 'oneoff-backfill-device-audio-transcriber'


def parser_checks():
    result = subprocess.run([str(BINARY), COMMAND, '--help'], capture_output=True, text=True)
    assert result.returncode == 0, 'Standalone device ASR command is missing'
    for flags in (['--resume', str(uuid.uuid4()), '--dry-run'],
                  ['--resume', str(uuid.uuid4()), '--device-id', str(uuid.uuid4())],
                  ['--device-id', 'invalid']):
        result = subprocess.run([str(BINARY), COMMAND, *flags], capture_output=True, text=True)
        assert result.returncode == 2, 'Invalid CLI flags must fail before database access'


class Scenario:
    def __init__(self, root):
        self.root, self.environment = audio.load(root)
        assert self.environment['stage'] == 'ready'
        for name in ('main_db', 'files_db'):
            database = self.environment[name]
            marker = shared.sql(self.root, self.environment,
                                f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{database}';")
            shared.require(marker == f"echo-device-audio:{self.environment['run']}",
                           'Refusing an unowned database')
        self.children = []
        self.process_evidence = {}
        self.sequence = 0
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))

    def sql(self, sql, files=True):
        audio.load(self.root)
        return shared.sql(self.root, self.environment, sql,
                          self.environment['files_db' if files else 'main_db'])

    def cli(self, *flags):
        audio.load(self.root)
        self.sequence += 1
        output = self.root / f'oneoff-{self.sequence}.log'
        with output.open('w') as log:
            child = subprocess.Popen([str(BINARY), '--mode=test', COMMAND, *map(str, flags)],
                                     env=shared.runtime_env(self.root, self.environment),
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        record = {'pid': child.pid, 'started': shared.process_identity(child.pid)}
        role = f'oneoff-{self.sequence}'
        self.environment['processes'][role] = record
        shared.save(self.root, self.environment)
        self.children.append(child)
        self.process_evidence[child.pid] = {
            'pid': child.pid, 'flags': list(map(str, flags)),
            'api_processes_live': [role for role in ('api-a', 'api-b')
                                   if role in self.environment['processes'] and
                                   shared.process_identity(self.environment['processes'][role]['pid'])],
        }
        return child, output

    def finish(self, execution, expected=0):
        child, output = execution
        code = child.wait(timeout=180)
        assert code == expected, f'{output.name}: expected exit {expected}, got {code}'
        text = output.read_text()
        summaries = [json.loads(line) for line in text.splitlines() if line.startswith('{') and '"run_id"' in line]
        summary = summaries[-1] if summaries else None
        evidence = {**self.process_evidence[child.pid], 'exit': code, 'summary': summary,
                    'provider': {key: value for key, value in self.fixture().items() if key != 'events'}}
        with (self.root / 'oneoff-evidence.jsonl').open('a') as output:
            output.write(json.dumps(evidence) + '\n')
        return summary

    def stop_api(self):
        for role in ('api-a', 'api-b'):
            record = self.environment['processes'].get(role)
            if record and shared.owned_process(record, self.root, self.environment):
                shared.signal_group(record, signal.SIGTERM)
                until(lambda: not shared.process_identity(record['pid']))

    def start_api(self):
        for role in ('a', 'b'):
            shared.spawn(self.root, self.environment, f'api-{role}')
            shared.wait_url(f"http://127.0.0.1:{self.environment[f'api_{role}_port']}/api/ping", 120)
        actor = json.loads((self.root / 'fixtures-private.json').read_text())['actors']['parent-admin']
        self.request('/api/user/test-api-login', {'user': actor['login'], 'password': actor['password']})
        for cookie in self.cookies:
            cookie.secure = False

    def request(self, path, value=None, method=None, headers=None, role='a'):
        url = path if path.startswith('http://127.0.0.1:') else f"http://127.0.0.1:{self.environment[f'api_{role}_port']}{path}"
        body = json.dumps(value).encode() if isinstance(value, dict) else value
        request = urllib.request.Request(url, data=body, method=method,
                                         headers=headers or {'Content-Type': 'application/json'})
        with self.opener.open(request, timeout=90) as response:
            data = response.read()
            for cookie in self.cookies:
                cookie.secure = False
            return json.loads(data) if data else dict(response.headers)

    def device(self):
        return self.request('/api/device/create', {'name': f'oneoff-{uuid.uuid4()}'})['id']

    def receive(self, device):
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(8000)
            wav.writeframes(os.urandom(16000))
        body = buffer.getvalue()
        upload = self.request(f'/api/device/audio/{device}/uploads', method='POST',
                              headers={'Tus-Resumable': '1.0.0', 'Upload-Length': str(len(body))})
        location = upload['location'] if 'location' in upload else upload['Location']
        self.request(location, body, 'PATCH', {'Tus-Resumable': '1.0.0', 'Upload-Offset': '0',
                                             'Content-Type': 'application/offset+octet-stream'})
        return self.request('/api/device/audio/receive', {'device_id': device, 'name': str(uuid.uuid4()),
                            'recording_started_at': '2026-10-01T10:00:00Z', 'upload_url': location})['audio']['id']

    def fixture(self, control=None):
        url = f"http://127.0.0.1:{self.environment['asr_rs_port']}/__fixture/{'control' if control else 'state'}"
        request = urllib.request.Request(url, data=json.dumps(control).encode() if control else None,
                                         headers={'X-Fixture-Token': (self.root / 'asr-token').read_text(),
                                                  'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    def counts(self, summary, expected):
        assert {key: summary[key] for key in expected} == expected, summary
        assert summary['checked'] == sum(summary[key] for key in ('succeeded', 'skipped', 'no_speech', 'failed', 'recovery_required'))


def until(check, seconds=30):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return
        time.sleep(0.1)
    raise AssertionError('Timed out waiting for owned fixture transition')


def database_digest(s):
    tables = ('device_audio', 'device_audio_asr_job', 'device_audio_asr_setting',
              'device_audio_asr_scheduler', 'device_audio_asr_backfill', 'device_audio_asr_backfill_item')
    parts = [f"SELECT '{table}' name, jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) data FROM {table} t"
             for table in tables]
    return s.sql("SELECT md5(string_agg(row_to_json(t)::text, '' ORDER BY name)) FROM (" +
                 ' UNION ALL '.join(parts) + ') t;')


def standalone(s):
    s.sql('UPDATE system_settings SET enable_audio_transcription=false;', False)
    s.start_api()
    device = s.device()
    first, second = s.receive(device), s.receive(device)
    s.sql(f"UPDATE device_audio SET transcription='manual correction' WHERE id='{first}';")
    s.stop_api()
    before = database_digest(s)
    s.finish(s.cli('--device-id', device, '--dry-run'))
    after = database_digest(s)
    assert before == after and s.fixture()['inferences'] == 0, 'dry-run wrote state or dispatched'
    s.finish(s.cli('--device-id', device, '--yes'), 3)
    s.sql('UPDATE system_settings SET enable_audio_transcription=true;', False)
    s.sql('UPDATE gpu_config SET is_active=false;', False)
    paused = s.finish(s.cli('--device-id', device, '--yes'), 3)
    s.counts(paused, {'checked': 0, 'unfinished': 2})
    assert paused['state'] == 'paused'
    s.sql('UPDATE gpu_config SET is_active=true;', False)
    summary = s.finish(s.cli('--resume', paused['run_id'], '--yes'))
    s.counts(summary, {'checked': 2, 'succeeded': 2, 'unfinished': 0, 'failed': 0})
    assert s.fixture()['inferences'] == 2
    assert s.sql(f"SELECT transcription FROM device_audio WHERE id='{first}';") == 'manual correction'
    s.finish(s.cli('--resume', summary['run_id'], '--yes'))
    empty = s.finish(s.cli('--device-id', device, '--yes'))
    s.counts(empty, {'checked': 0, 'unfinished': 0, 'succeeded': 0})
    assert s.fixture()['inferences'] == 2
    s.finish(s.cli('--resume', str(uuid.uuid4()), '--yes'), 1)
    return device


def interrupted(s):
    s.sql('UPDATE system_settings SET enable_audio_transcription=false;', False)
    s.start_api(); device = s.device(); audio_id = s.receive(device); s.stop_api()
    s.sql('UPDATE system_settings SET enable_audio_transcription=true;', False)
    s.fixture({'mode': 'delayed', 'delay_seconds': 3})
    execution = s.cli('--device-id', device, '--yes')
    until(lambda: s.fixture()['active'] == 1)
    execution[0].send_signal(signal.SIGINT)
    summary = s.finish(execution, 130)
    s.fixture({'mode': 'success'})
    s.finish(s.cli('--resume', summary['run_id'], '--yes'))
    assert s.sql(f"SELECT count(*) FROM device_audio WHERE id='{audio_id}' AND automatic_transcription IS NOT NULL;") == '1'
    s.sql('UPDATE system_settings SET enable_audio_transcription=false;', False)
    s.start_api(); device = s.device(); audio_id = s.receive(device); s.stop_api()
    s.sql('UPDATE system_settings SET enable_audio_transcription=true;', False)
    s.fixture({'mode': 'delayed', 'delay_seconds': 3})
    execution = s.cli('--device-id', device, '--yes')
    until(lambda: s.fixture()['active'] == 1)
    execution[0].kill(); execution[0].wait(timeout=10)
    until(lambda: s.fixture()['active'] == 0)
    run = s.sql(f"SELECT run_id FROM device_audio_asr_backfill WHERE device_id='{device}' ORDER BY started_at DESC LIMIT 1;")
    s.sql(f"UPDATE device_audio_asr_backfill SET heartbeat_at=now()-interval '3 minutes' WHERE run_id='{run}'; UPDATE device_audio_asr_job SET heartbeat_at=now()-interval '3 minutes' WHERE audio_id='{audio_id}';")
    before = s.fixture()['inferences']
    summary = s.finish(s.cli('--resume', run, '--yes'), 3)
    s.counts(summary, {'checked': 1, 'recovery_required': 1, 'unfinished': 0})
    assert s.fixture()['inferences'] == before, 'Unknown dispatch was retried'
    attempt = s.sql(f"SELECT attempt_id FROM device_audio_asr_job WHERE audio_id='{audio_id}';")
    shared.command([str(BINARY), '--mode=test', 'oneoff-recover-device-audio-transcription',
                    '--audio-id', audio_id, '--expected-attempt-id', attempt,
                    '--verification-note', 'Owned CLI killed and provider active count zero', '--yes'],
                   s.root, shared.runtime_env(s.root, s.environment))
    s.fixture({'mode': 'no_speech'})
    summary = s.finish(s.cli('--resume', run, '--yes'))
    s.counts(summary, {'checked': 1, 'no_speech': 1, 'recovery_required': 0})


def policy_and_concurrency(s):
    s.sql('UPDATE system_settings SET enable_audio_transcription=false;', False)
    s.start_api()
    device = s.device(); audio_id = s.receive(device); extra = s.receive(device)
    s.sql(f"DELETE FROM device_audio_asr_job WHERE device_id='{device}';")
    s.fixture({'mode': 'delayed', 'delay_seconds': 3})
    s.sql('UPDATE system_settings SET enable_audio_transcription=true;', False)
    before = s.fixture()['inferences']
    execution = s.cli('--device-id', device, '--yes')
    until(lambda: s.fixture()['active'] == 1)
    for role in ('a', 'b'):
        s.request('/api/device/audio/playback/prepare', {'device_id': device, 'audio_id': audio_id}, role=role)
    summary = s.finish(execution)
    s.counts(summary, {'checked': 2, 'succeeded': 2, 'unfinished': 0})
    assert s.fixture()['inferences'] == before + 2
    assert s.fixture()['max_active'] == 1
    s.stop_api()
    s.sql('UPDATE system_settings SET enable_audio_transcription=false;', False)
    s.start_api(); device = s.device(); first = s.receive(device); second = s.receive(device); s.stop_api()
    s.sql('UPDATE system_settings SET enable_audio_transcription=true;', False)
    execution = s.cli('--device-id', device, '--yes')
    until(lambda: s.fixture()['active'] == 1)
    s.sql('UPDATE system_settings SET enable_audio_transcription=false;', False)
    summary = s.finish(execution)
    s.counts(summary, {'checked': 2, 'succeeded': 1, 'skipped': 1, 'unfinished': 0})
    assert summary['skipped_by_reason'] == {'global_disabled': 1}
    s.fixture({'mode': 'success'})


def skipped_and_safe_failure(s):
    s.sql('UPDATE system_settings SET enable_audio_transcription=false;', False)
    s.start_api()
    disabled, archived, corrupt = s.device(), s.device(), s.device()
    s.receive(disabled); s.receive(archived); broken = s.receive(corrupt)
    s.stop_api()
    s.sql(f"UPDATE device_audio_asr_setting SET enabled=false WHERE device_id='{disabled}';")
    s.sql(f"UPDATE device SET archived=true,archived_at=now() WHERE id='{archived}';", False)
    key = s.sql(f"SELECT storage_key FROM device_audio WHERE id='{broken}';")
    shared.s3_request(s.root, s.environment, 'PUT', key, b'corrupt encrypted fixture')
    s.sql('UPDATE system_settings SET enable_audio_transcription=true;', False)
    before = s.fixture()['inferences']
    for device, reason in ((disabled, 'device_disabled'), (archived, 'device_archived_or_missing')):
        summary = s.finish(s.cli('--device-id', device, '--yes'))
        s.counts(summary, {'checked': 1, 'skipped': 1, 'succeeded': 0, 'failed': 0})
        assert summary['skipped_by_reason'] == {reason: 1}
    execution = s.cli('--device-id', corrupt, '--yes')
    until(lambda: s.sql(f"SELECT state FROM device_audio_asr_job WHERE audio_id='{broken}';") == 'retry_wait')
    s.sql(f"UPDATE device_audio_asr_job SET attempt_count=8,next_attempt_at=now() WHERE audio_id='{broken}';")
    summary = s.finish(execution, 2)
    s.counts(summary, {'checked': 1, 'failed': 1, 'no_speech': 0, 'succeeded': 0})
    assert s.fixture()['inferences'] == before, 'Excluded or corrupt audio reached inference'


def ownership(s):
    original = (s.root / 'config-a.toml').read_text()
    try:
        shared.private_write(s.root / 'config-a.toml', original.replace(s.environment['main_db'], 'wd'))
        try:
            s.cli('--yes')
        except RuntimeError:
            pass
        else:
            raise AssertionError('Foreign database configuration was accepted')
    finally:
        shared.private_write(s.root / 'config-a.toml', original)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli-only', action='store_true')
    parser.add_argument('--root')
    args = parser.parse_args()
    parser_checks()
    if args.cli_only:
        print('CLI parser checks passed'); return
    shared.require(args.root, 'Supply a fresh owned --root; shared config is never accepted')
    scenario = Scenario(args.root)
    try:
        ownership(scenario)
        standalone(scenario)
        interrupted(scenario)
        policy_and_concurrency(scenario)
        skipped_and_safe_failure(scenario)
        print('Standalone, dry-run, policy, signal, recovery and resume checks passed')
    finally:
        for child in scenario.children:
            if child.poll() is None:
                child.send_signal(signal.SIGINT)
                child.wait(timeout=150)


if __name__ == '__main__':
    main()
