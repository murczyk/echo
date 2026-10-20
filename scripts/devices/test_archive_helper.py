#!/usr/bin/env python3
"""Bounded ZIP helper integration checks; set ECHO_ARCHIVE_HELPER_BIN explicitly."""
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import threading
import unittest
import urllib.parse
import zipfile


def frame(value):
    body = json.dumps(value).encode()
    return struct.pack('>I', len(body)) + body


def receive(pipe):
    header = pipe.read(4)
    if len(header) != 4:
        raise AssertionError('helper exited before reporting its result')
    size, = struct.unpack('>I', header)
    if not 0 < size <= 32 * 1024 * 1024:
        raise AssertionError('invalid helper frame length')
    return json.loads(pipe.read(size))


class ArchiveHelperTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        binary = os.environ.get('ECHO_ARCHIVE_HELPER_BIN')
        if not binary:
            raise unittest.SkipTest('ECHO_ARCHIVE_HELPER_BIN must name the built application')
        cls.binary = str(Path(binary).resolve(strict=True))

    def setUp(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('Report.txt', b'hello')
            archive.writestr('report.txt', b'world')
            archive.writestr('empty/', b'')
        self.source = data.getvalue()
        self.uploads = {}
        self.objects = {}
        self.block = threading.Event()
        self.entered = threading.Event()
        self.pause_source = False
        self.source_status = 200
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body=b'', headers=None):
                self.send_response(status)
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(body)

            def do_HEAD(self):
                key = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).removeprefix('/bucket/')
                if key == 'source.zip':
                    self.reply(200, owner.source, {'ETag': '"source"', 'Content-Type': 'application/zip'})
                elif key in owner.objects:
                    content, digest = owner.objects[key]
                    self.reply(200, content, {'x-amz-meta-source-sha256': digest, 'ETag': '"output"'})
                else:
                    self.reply(404)

            def do_GET(self):
                owner.entered.set()
                if owner.pause_source:
                    owner.block.wait(10)
                if owner.source_status != 200:
                    self.reply(owner.source_status, b'<Error><Code>AccessDenied</Code></Error>')
                    return
                content = owner.source
                requested = self.headers.get('Range')
                if requested:
                    start, end = requested.removeprefix('bytes=').split('-')
                    begin, end = int(start), int(end or len(content) - 1)
                    self.reply(206, content[begin:end + 1], {'Content-Range': f'bytes {begin}-{end}/{len(content)}', 'ETag': '"source"'})
                else:
                    self.reply(200, content)

            def do_POST(self):
                parsed = urllib.parse.urlsplit(self.path)
                key = urllib.parse.unquote(parsed.path).removeprefix('/bucket/')
                query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
                body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                if 'uploads' in query:
                    owner.uploads[key] = {'parts': {}, 'digest': self.headers.get('x-amz-meta-source-sha256')}
                    self.reply(200, f'<InitiateMultipartUploadResult><UploadId>upload</UploadId></InitiateMultipartUploadResult>'.encode())
                else:
                    upload = owner.uploads[key]
                    owner.objects[key] = (b''.join(value for _, value in sorted(upload['parts'].items())), upload['digest'])
                    self.reply(200, f'<CompleteMultipartUploadResult><Key>{key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>'.encode())

            def do_PUT(self):
                parsed = urllib.parse.urlsplit(self.path)
                key = urllib.parse.unquote(parsed.path).removeprefix('/bucket/')
                number = int(urllib.parse.parse_qs(parsed.query)['partNumber'][0])
                owner.uploads[key]['parts'][number] = self.rfile.read(int(self.headers['Content-Length']))
                self.reply(200, headers={'ETag': '"part"'})

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.scratch = tempfile.TemporaryDirectory(prefix='echo-archive-helper-test-')
        self.process = None

    def tearDown(self):
        self.block.set()
        if self.process:
            self.process.kill() if self.process.poll() is None else None
            self.process.wait(timeout=5)
            self.process.stdin.close()
            self.process.stdout.close()
        self.server.shutdown()
        self.server.server_close()
        self.scratch.cleanup()

    def start(self, digest=None):
        request = {
            'source_key': 'source.zip', 'source_size': len(self.source),
            'source_sha256': list(digest or hashlib.sha256(self.source).digest()),
            'source_encrypted': False, 'output_prefix': 'device-file-archive/job/1/',
            'key': [66] * 32, 'scratch': self.scratch.name,
            'storage': {'bucket': 'bucket', 'region': 'us-east-1', 'endpoint': f'http://127.0.0.1:{self.server.server_port}', 'access_key_id': 'test', 'secret_access_key': 'test', 'prefix': ''},
            'limits': {'directory_bytes': 16 * 1024 * 1024, 'records': 50000, 'nodes': 10000, 'path_bytes': 1024, 'path_components': 32, 'member_bytes': 10000000000, 'member_ratio': 1000},
        }
        self.process = subprocess.Popen([self.binary, '--device-archive-helper'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.process.stdin.write(frame(request))
        self.process.stdin.flush()

    def test_manifest_admission_and_verified_encrypted_outputs(self):
        self.start()
        manifest = receive(self.process.stdout)
        self.assertEqual(manifest['type'], 'manifest')
        self.assertEqual([member['path'] for member in manifest['manifest']['members']], ['Report.txt', 'empty', 'report.txt'])
        self.assertEqual(self.objects, {})
        self.process.stdin.write(frame('Admit'))
        self.process.stdin.flush()
        result = receive(self.process.stdout)
        self.assertEqual(result['type'], 'result')
        files = {output['member']['path']: output for output in result['outputs'] if not output['member']['directory']}
        self.assertEqual(set(files), {'Report.txt', 'report.txt'})
        for name, plaintext in [('Report.txt', b'hello'), ('report.txt', b'world')]:
            output = files[name]
            self.assertEqual(bytes(output['bytes']['sha256']), hashlib.sha256(plaintext).digest())
            self.assertTrue(output['encrypted'])
            self.assertTrue(self.objects[output['object_key']][0].startswith(b'\xb1\xb8\xf5'))
        self.assertEqual(self.process.wait(timeout=5), 0)

    def test_lost_parent_terminates_helper_during_source_read(self):
        self.pause_source = True
        self.start()
        self.assertTrue(self.entered.wait(5))
        self.process.stdin.close()
        self.assertNotEqual(self.process.wait(timeout=3), 0)

    def test_invalid_source_digest_never_uploads_members(self):
        self.start(bytes(32))
        event = receive(self.process.stdout)
        self.assertEqual(event['type'], 'failed')
        self.assertEqual(event['reason'], 'integrity_mismatch')
        self.assertEqual(self.objects, {})

    def test_permanent_source_storage_failure_never_uploads_members(self):
        self.source_status = 403
        self.start()
        event = receive(self.process.stdout)
        self.assertEqual(event['type'], 'failed')
        self.assertEqual(event['reason'], 'storage_unavailable')
        self.assertEqual(self.objects, {})


if __name__ == '__main__':
    unittest.main()
