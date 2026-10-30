import { readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { request, type APIRequestContext } from '@playwright/test';
import type {
  DeviceAudio,
  DeviceDetails,
  ReceiveDeviceAudioReq,
  ReceiveDeviceAudioRsp,
  ListDeviceAudioReq,
  ListDeviceAudioRsp,
  DeviceAudioDetails,
} from '../../src/Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../src/ts/snake-to-camel';

type Actor = { login: string; password: string; roles: string[] };
type LocalFixtures = { run: string; actors: Record<string, Actor> };

export async function localAudioBackend() {
  const origin = process.env.PLAYWRIGHT_BASE_URL;
  const root = process.env.AUDIO_TEST_ROOT;
  const configPath = process.env.ECHO_CONFIG_PATH;
  if (!origin || !root || !configPath || !process.env.AUDIO_TEST_RUN)
    throw new Error(
      'Source the dedicated device-audio test environment before running real backend tests.',
    );
  const url = new URL(origin);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new Error('Device audio tests require a dedicated loopback origin.');
  if (!resolve(configPath).startsWith(`${resolve(root)}/`) || (await stat(configPath)).mode & 0o077)
    throw new Error(
      'Device audio configuration must be private and inside the dedicated test root.',
    );
  const config = await readFile(configPath, 'utf8');
  const resolvedEnvironment = JSON.parse(
    await readFile(resolve(root, 'resolved-environment.json'), 'utf8'),
  );
  if (Number(url.port) !== resolvedEnvironment.proxy_port || origin !== process.env.ECHO_BASE_URL)
    throw new Error('Device audio origin does not match the dedicated proxy.');
  const databases = [...config.matchAll(/^pg_dbname\s*=\s*"([^"\n]+)"/gm)].map((match) => match[1]);
  if (
    !process.env.TEST_DB_NAME?.startsWith('wd_test_device_audio_') ||
    !process.env.TEST_WDFILE_DB_NAME?.startsWith('wd_files_test_device_audio_') ||
    !databases.includes(process.env.TEST_DB_NAME) ||
    !databases.includes(process.env.TEST_WDFILE_DB_NAME)
  )
    throw new Error('Dedicated device-audio database/config mismatch.');
  if (
    !config.includes(process.env.AUDIO_S3_BUCKET ?? '\0') ||
    !process.env.AUDIO_S3_BUCKET?.startsWith('device-audio-')
  )
    throw new Error('Dedicated device-audio bucket/config mismatch.');
  const endpoint = process.env.AUDIO_S3_ENDPOINT;
  if (
    !endpoint ||
    !['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname) ||
    config.match(/^s3_endpoint\s*=\s*"([^"\n]+)"/m)?.[1] !== endpoint ||
    !process.env.AUDIO_STORAGE_DIR ||
    !resolve(process.env.AUDIO_STORAGE_DIR).startsWith(`${resolve(root)}/`) ||
    !config.includes(JSON.stringify(process.env.AUDIO_STORAGE_DIR))
  )
    throw new Error('Device audio storage does not match the dedicated local namespace.');
  const fixtures: LocalFixtures = JSON.parse(
    await readFile(resolve(root, 'fixtures-private.json'), 'utf8'),
  );
  if (fixtures.run !== process.env.AUDIO_TEST_RUN)
    throw new Error('Device audio actor fixtures belong to a different test run.');
  const contexts: APIRequestContext[] = [];
  async function login(key: string) {
    const actor = fixtures.actors[key];
    if (!actor?.password) throw new Error(`Missing local audio actor: ${key}`);
    const api = await request.newContext({ baseURL: origin, timeout: 120_000 });
    contexts.push(api);
    const response = await api.post('/api/user/test-api-login', {
      data: { user: actor.login, password: actor.password },
    });
    if (response.status() !== 200)
      throw new Error(`Local audio login failed for ${key}: HTTP ${response.status()}`);
    const state = await api.storageState();
    if (!state.cookies.some((cookie) => cookie.name === 'id'))
      throw new Error(`Local audio login returned no identity session for ${key}`);
    const authenticated = await request.newContext({
      baseURL: origin,
      timeout: 120_000,
      extraHTTPHeaders: {
        Cookie: state.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
      },
      storageState: {
        ...state,
        cookies: state.cookies.map((cookie) => ({ ...cookie, secure: false })),
      },
    });
    contexts.push(authenticated);
    return authenticated;
  }
  const source = await login('api-source');
  const reader = await login('parent-cyberviewer');
  async function createDevice(api = source) {
    return post<DeviceDetails>(api, '/api/device/create', {
      name: `audio-e2e-${crypto.randomUUID()}`,
    });
  }
  return {
    source,
    reader,
    login,
    createDevice,
    origin,
    dispose: async () => {
      await Promise.all(contexts.map((api) => api.dispose()));
    },
  };
}

export async function post<T>(api: APIRequestContext, path: string, body: object): Promise<T> {
  const response = await api.post(path, { data: transformCamelToSnake(body) });
  if (!response.ok()) throw new Error(`${path}: HTTP ${response.status()}`);
  return transformSnakeToCamel<T>(await response.json());
}

export function wavBytes(seconds: number, size?: number) {
  const bytes = Buffer.alloc(size ?? 44 + seconds * 8000 * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

export async function uploadAudio(
  api: APIRequestContext,
  deviceId: string,
  bytes: Buffer,
  resume = false,
) {
  const response = await api.post(`/api/device/audio/${deviceId}/uploads`, {
    headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(bytes.length) },
  });
  if (response.status() !== 201) throw new Error(`Audio TUS create: HTTP ${response.status()}`);
  const location = response.headers().location;
  if (!location) throw new Error('Audio TUS returned no resource URL.');
  let offset = 0;
  while (offset < bytes.length) {
    const end = Math.min(bytes.length, offset + (resume && offset === 0 ? 17 : 1024 * 1024));
    const patch = await api.patch(location, {
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
      },
      data: bytes.subarray(offset, end),
    });
    if (patch.status() !== 204 || Number(patch.headers()['upload-offset']) !== end)
      throw new Error(`Audio TUS PATCH failed at ${offset}: HTTP ${patch.status()}`);
    offset = end;
    if (resume && offset === 17) {
      const head = await api.head(location, { headers: { 'Tus-Resumable': '1.0.0' } });
      if (head.status() !== 204 || Number(head.headers()['upload-offset']) !== offset)
        throw new Error('Audio resume offset was lost.');
    }
  }
  return location;
}

export async function receiveAudio(
  api: APIRequestContext,
  deviceId: string,
  name: string,
  recordingStartedAt: string,
  bytes = wavBytes(1),
  resume = false,
): Promise<DeviceAudio> {
  const uploadUrl = await uploadAudio(api, deviceId, bytes, resume);
  const req: ReceiveDeviceAudioReq = {
    deviceId,
    name,
    recordingStartedAt,
    uploadUrl,
    asyncFinalization: false,
  };
  const response = await api.post('/api/device/audio/receive', {
    data: transformCamelToSnake(req),
  });
  if (response.status() !== 201) throw new Error(`Audio receive: HTTP ${response.status()}`);
  return transformSnakeToCamel<ReceiveDeviceAudioRsp>(await response.json()).audio;
}

export function listAudio(api: APIRequestContext, req: ListDeviceAudioReq) {
  return post<ListDeviceAudioRsp>(api, '/api/device/audio/list', req);
}
export function audioDetail(api: APIRequestContext, deviceId: string, audioId: string) {
  return post<DeviceAudioDetails>(api, '/api/device/audio/detail', { deviceId, audioId });
}

export async function audioAsrFixture(control?: { mode: string; delay_seconds?: number }) {
  const root = process.env.AUDIO_TEST_ROOT;
  const origin = process.env.AUDIO_ASR_RS_URL;
  if (!root || !origin || new URL(origin).hostname !== '127.0.0.1')
    throw new Error('Dedicated loopback ASR fixture required.');
  const token = await readFile(resolve(root, 'asr-token'), 'utf8');
  const response = await fetch(`${origin}/__fixture/${control ? 'control' : 'state'}`, {
    method: control ? 'POST' : 'GET',
    headers: { 'X-Fixture-Token': token, 'Content-Type': 'application/json' },
    ...(control ? { body: JSON.stringify(control) } : {}),
  });
  if (!response.ok) throw new Error(`ASR fixture: HTTP ${response.status}`);
  return response.json();
}

export async function removeAudioFixtureCache() {
  const root = process.env.AUDIO_TEST_ROOT;
  if (!root || !resolve(process.env.ECHO_CONFIG_PATH ?? '').startsWith(`${resolve(root)}/`))
    throw new Error('Private audio fixture config required.');
  const environment = JSON.parse(
    await readFile(resolve(root, 'resolved-environment.json'), 'utf8'),
  );
  if (environment.run !== process.env.AUDIO_TEST_RUN || environment.profile !== 'device-audio')
    throw new Error('Audio cache must belong to this test run.');
  for (const role of ['a', 'b'])
    await rm(resolve(root, `storage-${role}`, 'device-audio-cache'), {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
}

export async function audioFixtureSql(database: 'main' | 'files', sql: string) {
  const { execFileSync } = await import('node:child_process');
  const root = process.env.AUDIO_TEST_ROOT;
  const path = process.env.ECHO_CONFIG_PATH;
  if (!root || !path || !resolve(path).startsWith(`${resolve(root)}/`))
    throw new Error('Private audio fixture config required.');
  const config = await readFile(path, 'utf8');
  const section =
    database === 'files'
      ? config.split('[file_registry]')[1]?.split('\n[')[0]
      : config.split('\n[')[0];
  if (!section) throw new Error('Missing audio fixture database section.');
  const env = { ...process.env };
  for (const [key, variable] of [
    ['pg_host', 'PGHOST'],
    ['pg_port', 'PGPORT'],
    ['pg_user', 'PGUSER'],
    ['pg_password', 'PGPASSWORD'],
    ['pg_dbname', 'PGDATABASE'],
  ]) {
    const value = section.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'))?.[1];
    if (!value) throw new Error(`Missing fixture field ${key}`);
    env[variable] = String(JSON.parse(value));
  }
  const expected =
    database === 'files' ? process.env.TEST_WDFILE_DB_NAME : process.env.TEST_DB_NAME;
  if (
    env.PGDATABASE !== expected ||
    !expected?.startsWith(
      database === 'files' ? 'wd_files_test_device_audio_' : 'wd_test_device_audio_',
    )
  )
    throw new Error('Unsafe audio fixture database.');
  const execute = (input: string) =>
    execFileSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], {
      input,
      env,
      encoding: 'utf8',
    });
  if (execute('SELECT current_database();').trim() !== expected)
    throw new Error('Actual fixture database mismatch.');
  return execute(`BEGIN;\n${sql}\nCOMMIT;`).trim();
}
