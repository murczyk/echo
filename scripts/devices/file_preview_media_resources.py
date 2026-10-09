#!/usr/bin/env python3
"""Measure media limits only in the harness-owned loopback databases and storage."""
import argparse
import base64
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
try:
    import tomllib
except ModuleNotFoundError:
    fallback = os.environ.get('DEVICE_FILE_PREVIEW_PYTHON', '/opt/homebrew/bin/python3')
    if Path(fallback).is_file() and Path(fallback).resolve() != Path(sys.executable).resolve():
        os.execv(fallback, [fallback, *sys.argv])
    raise RuntimeError('Media resource acceptance requires Python 3.11 or newer')
from datetime import datetime, timezone
from urllib.parse import urlsplit
import urllib.request
import uuid

MIB = 1024 * 1024
CHUNK = bytes(range(256)) * 4096


class Experiment:
    def __init__(self, root):
        self.root = root.resolve(strict=True)
        harness = Path(__file__).with_name('test-file-preview.sh')
        self.status = json.loads(subprocess.check_output([str(harness), 'status', '--root', str(self.root)]))
        assert self.status['stage'] == 'ready' and all(self.status['processes'].get(role) for role in ('redis', 'front', 'proxy', 'api-a', 'api-b', 'bgworker'))
        self.env = json.loads((self.root / 'resolved-environment.json').read_text())
        self.config = tomllib.loads((self.root / 'config-a.toml').read_text())
        self.fixtures = json.loads((self.root / 'fixtures-private.json').read_text())
        assert self.env['run'] == self.fixtures['run'] == self.status['run']
        assert self.env['main_db'].startswith('wd_test_device_file_preview_')
        assert self.env['files_db'].startswith('wd_files_test_device_file_preview_')
        for database in (self.env['main_db'], self.env['files_db']):
            assert self.sql(f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{database}';") == f"echo-device-file-preview:{self.env['run']}"
        self.origin = self.status['origin']
        assert urlsplit(self.origin).hostname == '127.0.0.1'
        self.cookies = {}
        for actor in ('source', 'reader'):
            credentials = self.fixtures['actors'][actor]
            response = self.api('POST', '/api/user/test-api-login', {'user': credentials['login'], 'password': credentials['password']})
            self.cookies[actor] = response['headers']['set-cookie'].split(';', 1)[0]
        self.objects = []
        self.open_streams = []
        self.samples = []
        self.running = True
        self.sampler = threading.Thread(target=self.sample, daemon=True)
        self.sampler.start()

    def sql(self, query):
        env = {**os.environ, 'PGPASSWORD': self.config['pg_password']}
        return subprocess.check_output(['psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', self.config['pg_host'], '-p', str(self.config['pg_port']), '-U', self.config['pg_user'], '-d', self.env['files_db'], '-c', query], env=env, text=True).strip()

    def api(self, method, path, data=None, actor=None, headers=None):
        body = json.dumps(data).encode() if data is not None else None
        request = urllib.request.Request(self.origin + path, data=body, method=method, headers={**({'Content-Type': 'application/json'} if body else {}), **({'Cookie': self.cookies[actor]} if actor else {}), **(headers or {})})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=150) as response:
            raw = response.read()
            return {'status': response.status, 'headers': dict((key.lower(), value) for key, value in response.headers.items()), 'data': json.loads(raw) if raw else None}

    def file(self, name, size):
        digest = hashlib.sha256()
        for offset in range(0, size, len(CHUNK)):
            digest.update(CHUNK[:min(size - offset, len(CHUNK))])
        sha = digest.digest()
        response = self.api('POST', '/api/device/files/sync', {'device_id': self.fixtures['deviceId'], 'files': [{'absolute_path': f'C:\\preview\\resource-{self.env["run"]}\\{name}.mp4', 'mime_type': 'video/mp4', 'extension': 'mp4', 'file_metadata_created_at': None, 'file_metadata_modified_at': datetime.now(timezone.utc).isoformat(), 'source_file_state': None}]}, 'source')
        accepted = response['data']['results'][0]
        assert accepted['status'] == 'accepted', accepted
        file = accepted['file']
        path = f'/api/device/files/{self.fixtures["deviceId"]}/{file["file_id"]}/revisions/{file["revision"]}/content-uploads'
        created = self.api('POST', path, actor='source', headers={'Tus-Resumable': '1.0.0', 'Upload-Length': str(size), 'Upload-Metadata': 'sha256 ' + base64.b64encode(sha).decode()})
        assert created['status'] == 201
        location = created['headers']['location']
        upload_id = location.rsplit('/', 1)[1]
        uuid.UUID(upload_id)
        uuid.UUID(file['file_id'])
        key = self.sql(f"SELECT object_key FROM file_content_upload WHERE id='{upload_id}';")
        assert key == f"device-file-content/{self.fixtures['deviceId']}/{file['file_id']}/{file['revision']}/{upload_id}"
        self.objects.append(key)
        return {'file': file, 'location': location, 'upload_id': upload_id, 'key': key, 'size': size, 'sha256': sha.hex(), 'media': path.replace('/content-uploads', '/preview/media')}

    def s3(self, method, key, size=0, digest=None):
        config = self.config['s3_config']
        endpoint = urlsplit(config['s3_endpoint'])
        assert endpoint.hostname == '127.0.0.1' and endpoint.port == self.env['s3_port']
        path = f'/{self.env["bucket"]}/{key}'
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        day = stamp[:8]
        payload_hash = digest or hashlib.sha256(b'').hexdigest()
        canonical_headers = f'host:{endpoint.netloc}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{stamp}\n'
        signed = 'host;x-amz-content-sha256;x-amz-date'
        canonical = f'{method}\n{path}\n\n{canonical_headers}\n{signed}\n{payload_hash}'
        scope = f'{day}/us-east-1/s3/aws4_request'
        signing = ('AWS4' + config['s3_secret_access_key']).encode()
        for part in (day, 'us-east-1', 's3', 'aws4_request'):
            signing = hmac.new(signing, part.encode(), hashlib.sha256).digest()
        signature = hmac.new(signing, f'AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}'.encode(), hashlib.sha256).hexdigest()
        connection = http.client.HTTPConnection(endpoint.hostname, endpoint.port, timeout=150)
        connection.putrequest(method, path)
        connection.putheader('x-amz-content-sha256', payload_hash)
        connection.putheader('x-amz-date', stamp)
        connection.putheader('Authorization', f'AWS4-HMAC-SHA256 Credential={config["s3_access_key_id"]}/{scope}, SignedHeaders={signed}, Signature={signature}')
        if method == 'PUT': connection.putheader('Content-Length', str(size))
        connection.endheaders()
        if method == 'PUT':
            for offset in range(0, size, len(CHUNK)):
                connection.send(CHUNK[:min(size - offset, len(CHUNK))])
        response = connection.getresponse()
        response.read()
        assert response.status in (200, 204), response.status
        connection.close()

    def publish_plaintext(self, entry):
        self.s3('PUT', entry['key'], entry['size'], entry['sha256'])
        upload_id = entry['upload_id']
        self.sql(f"BEGIN; INSERT INTO file_content (file_id,revision,upload_id,object_key,source_size_bytes,source_sha256,is_encrypted,created_at) SELECT file_id,revision,id,object_key,upload_length,expected_sha256,false,now() FROM file_content_upload WHERE id='{upload_id}' AND status='open'; UPDATE file_entry SET content_path='{entry['key']}' WHERE id='{entry['file']['file_id']}'; UPDATE file_content_upload SET status='completed',next_cleanup_at=now() WHERE id='{upload_id}'; COMMIT;")

    def publish_encrypted(self, entry):
        endpoint = urlsplit(self.origin)
        for offset in range(0, entry['size'], len(CHUNK)):
            connection = http.client.HTTPConnection(endpoint.hostname, endpoint.port, timeout=150)
            body = CHUNK[:min(entry['size'] - offset, len(CHUNK))]
            connection.request('PATCH', entry['location'], body, {'Cookie': self.cookies['source'], 'Tus-Resumable': '1.0.0', 'Upload-Offset': str(offset), 'Content-Type': 'application/offset+octet-stream'})
            response = connection.getresponse()
            response.read()
            assert response.status == 204 and int(response.getheader('Upload-Offset')) == offset + len(body)
            connection.close()
        completed = self.api('POST', entry['location'] + '/complete', actor='source', headers={'Tus-Resumable': '1.0.0'})
        assert completed['status'] == 200

    def connect(self, path, headers=None):
        endpoint = urlsplit(self.origin)
        connection = http.client.HTTPConnection(endpoint.hostname, endpoint.port, timeout=150)
        connection.request('GET', path, headers={'Cookie': self.cookies['reader'], **(headers or {})})
        return connection, connection.getresponse()

    def cache_bytes(self):
        total = 0
        for role in ('a', 'b'):
            for path in (self.root / f'cache-{role}').rglob('*'):
                try:
                    if path.is_file(): total += path.stat().st_size
                except FileNotFoundError:
                    pass
        return total

    def sample(self):
        groups = {record['pid'] for key, record in self.env['processes'].items() if key in ('api-a', 'api-b')}
        while self.running:
            rows = subprocess.check_output(['ps', '-A', '-o', 'pgid=,rss=,comm='], text=True)
            rss = sum(int(parts[1]) * 1024 for line in rows.splitlines() if len(parts := line.split(None, 2)) == 3 and int(parts[0]) in groups and 'wdintel-rs' in parts[2])
            ffmpeg = sum(1 for line in rows.splitlines() if len(parts := line.split(None, 2)) == 3 and int(parts[0]) in groups and 'ffmpeg' in parts[2])
            self.samples.append({'seconds': time.monotonic(), 'rss_bytes': rss, 'cache_bytes': self.cache_bytes(), 'ffmpeg_processes': ffmpeg})
            time.sleep(0.1)

    def measure(self, entry, plaintext):
        baseline = self.samples[-1]['rss_bytes'] if self.samples else 0
        cache_before = self.cache_bytes()
        start_sample = len(self.samples)
        started = time.monotonic()
        connection, response = self.connect(entry['media'])
        assert response.status == 200 and int(response.getheader('Content-Length')) == entry['size']
        digest = hashlib.sha256()
        count = 0
        while body := response.read(MIB):
            count += len(body)
            digest.update(body)
        connection.close()
        assert count == entry['size'] and digest.hexdigest() == entry['sha256']
        full_get_seconds = time.monotonic() - started
        range_started = time.monotonic()
        connection, response = self.connect(entry['media'], {'Range': f'bytes={entry["size"] - 4096}-{entry["size"] - 1}'})
        expected = CHUNK[-4096:]
        content_range = response.getheader('Content-Range')
        assert content_range == f'bytes {entry["size"] - 4096}-{entry["size"] - 1}/{entry["size"]}'
        assert response.status == 206 and response.read() == expected
        connection.close()
        measured = self.samples[start_sample:]
        cache_after = self.cache_bytes()
        if plaintext: assert cache_after == cache_before
        else: assert cache_after - cache_before == entry['size']
        assert all(sample['ffmpeg_processes'] == 0 for sample in measured)
        return {'size_bytes': count, 'sha256': digest.hexdigest(), 'seconds': time.monotonic() - started, 'full_get_seconds': full_get_seconds, 'tail_range_seconds': time.monotonic() - range_started, 'baseline_api_rss_bytes': baseline, 'sampled_peak_api_rss_bytes': max(sample['rss_bytes'] for sample in measured), 'cache_before_bytes': cache_before, 'cache_after_bytes': cache_after, **self.sampling_metrics(measured), 'range': f'bytes={entry["size"] - 4096}-{entry["size"] - 1}', 'content_range': content_range, 'range_status': 206}

    def sampling_metrics(self, measured):
        gaps = [right['seconds'] - left['seconds'] for left, right in zip(measured, measured[1:])]
        return {'sample_count': len(measured), 'requested_sample_delay_seconds': 0.1, 'effective_sample_interval_mean_seconds': sum(gaps) / len(gaps) if gaps else None, 'effective_sample_interval_max_seconds': max(gaps) if gaps else None}

    def exhaust(self):
        start_sample = len(self.samples)
        holds = []
        admissions = []
        for index in range(11):
            entry = self.file(f'encrypted-lease-{index}', 100 * MIB)
            self.publish_encrypted(entry)
            connection, response = self.connect(entry['media'])
            admissions.append({'index': index, 'status': response.status, 'cache_bytes': self.cache_bytes(), 'retry_after': response.getheader('Retry-After')})
            if response.status == 503:
                assert response.getheader('Retry-After') == '2'
                response.read()
                connection.close()
                break
            assert response.status == 200
            holds.append((connection, response))
            self.open_streams.append((connection, response))
        assert admissions[-1]['status'] == 503 and len(holds) == 10, admissions
        assert max(row['cache_bytes'] for row in admissions) <= 1024 * MIB
        for connection, response in holds:
            response.close()
            connection.close()
        self.open_streams.clear()
        started = time.monotonic()
        recovery_statuses = []
        for _attempt in range(20):
            connection, response = self.connect(entry['media'], {'Range': 'bytes=0-0'})
            body = response.read()
            connection.close()
            recovery_statuses.append(response.status)
            if response.status == 206:
                assert body == CHUNK[:1]
                break
            assert response.status == 503
            time.sleep(0.25)
        assert response.status == 206, recovery_statuses
        measured = self.samples[start_sample:]
        peak_cache = max(sample['cache_bytes'] for sample in measured)
        assert peak_cache <= 1024 * MIB
        return {'admissions': admissions, 'live_leases': len(holds), 'released_leases_read_status': response.status, 'recovery_statuses': recovery_statuses, 'recovery_seconds': time.monotonic() - started, 'cache_bytes_after_recovery': self.cache_bytes(), 'sampled_peak_cache_bytes': peak_cache, 'sampled_peak_api_rss_bytes': max(sample['rss_bytes'] for sample in measured), **self.sampling_metrics(measured)}

    def close(self):
        for connection, response in self.open_streams:
            response.close()
            connection.close()
        self.running = False
        self.sampler.join(5)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--exhaust', action='store_true')
    parser.add_argument('--inspect-media')
    parser.add_argument('--revision', type=int)
    args = parser.parse_args()
    if not args.inspect_media and not args.output:
        parser.error('--output is required for resource measurements')
    if args.inspect_media and (args.revision is None or args.revision < 1):
        parser.error('--inspect-media requires a positive --revision')
    experiment = Experiment(args.root)
    results = {'run': experiment.env['run'], 'scope': 'actual loopback API/private MinIO, artificial deterministic media bytes; not playable codec acceptance'}
    try:
        if args.inspect_media:
            file_id = str(uuid.UUID(args.inspect_media))
            device_id = str(uuid.UUID(experiment.fixtures['deviceId']))
            row = experiment.sql(f"SELECT json_build_object('fileId',c.file_id,'revision',c.revision,'sourceSizeBytes',c.source_size_bytes,'isEncrypted',c.is_encrypted) FROM file_content c JOIN file_revision r ON r.id=c.file_id AND r.revision=c.revision WHERE c.file_id='{file_id}' AND c.revision={args.revision} AND r.device_id='{device_id}';")
            assert row, 'Media source is absent from this owned device/revision'
            print(row, flush=True)
            return
        jobs_before = int(experiment.sql('SELECT count(*) FROM file_preview;'))
        plaintext = experiment.file('plaintext-2gib', 2 * 1024 * MIB)
        experiment.publish_plaintext(plaintext)
        results['plaintext_2gib'] = experiment.measure(plaintext, True)
        print(json.dumps({'plaintext_2gib': results['plaintext_2gib']}), flush=True)
        encrypted = experiment.file('encrypted-100mib', 100 * MIB)
        experiment.publish_encrypted(encrypted)
        results['encrypted_100mib'] = experiment.measure(encrypted, False)
        print(json.dumps({'encrypted_100mib': results['encrypted_100mib']}), flush=True)
        if args.exhaust:
            results['cache_exhaustion'] = experiment.exhaust()
            print(json.dumps({'cache_exhaustion': results['cache_exhaustion']}), flush=True)
        results['owned_object_count'] = len(experiment.objects)
        results['preview_jobs_before'] = jobs_before
        results['preview_jobs_after'] = int(experiment.sql('SELECT count(*) FROM file_preview;'))
        assert results['preview_jobs_after'] == jobs_before
        results['observed_ffmpeg_processes'] = max(sample['ffmpeg_processes'] for sample in experiment.samples)
        assert results['observed_ffmpeg_processes'] == 0
        args.output.write_text(json.dumps(results, indent=2) + '\n')
    finally:
        experiment.close()


if __name__ == '__main__':
    main()
