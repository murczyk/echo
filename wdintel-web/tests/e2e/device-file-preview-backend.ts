import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, type APIRequestContext } from '@playwright/test';
import type {
  CreateLoginReq,
  CreateOrganismReq,
  CreateSystemSettingsReq,
  DeviceDetails,
  DeviceFile,
  Login,
  Organism,
  SyncDeviceFilesReq,
  SystemSettingsCurrentRsp,
  SystemSettingsItem,
} from '../../src/Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../src/ts/snake-to-camel';
import {
  DEVICE_FILE_PREVIEW_FIXTURES,
  DEVICE_FILE_PREVIEW_SEED_FIXTURES,
  loadDeviceFilePreviewFixture,
  type DeviceFilePreviewFixture,
} from './device-file-preview.fixtures';

type Actor = { login: string; password: string; roles: string[]; id?: string };
type SeededFile = {
  fixtureId: string;
  file: DeviceFile;
  originalHref: string;
  sha256: string | null;
};
type PreviewFixtures = {
  run: string;
  bootstrap: { organismId: number; sigintZoneId: number };
  actors: Record<string, Actor>;
  seeded: SeededFile[];
  deviceId?: string;
  seedComplete?: boolean;
  unverified?: string[];
};

async function ownedEnvironment() {
  const root = process.env.DEVICE_FILE_PREVIEW_ROOT;
  const run = process.env.DEVICE_FILE_PREVIEW_RUN;
  const origin = process.env.PLAYWRIGHT_BASE_URL;
  if (!root || !run || !origin)
    throw new Error(
      'Source the dedicated file-preview environment before using real backend fixtures.',
    );
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/')
    throw new Error('File preview requires its owned loopback origin.');
  if ((await realpath(root)) !== resolve(root) || (await stat(root)).mode & 0o077)
    throw new Error('File preview root must be private and must not resolve through a symlink.');
  const harness = fileURLToPath(
    new URL('../../../scripts/devices/test-file-preview.sh', import.meta.url),
  );
  const status = JSON.parse(
    execFileSync(harness, ['status', '--root', root], { encoding: 'utf8' }),
  );
  const environment = JSON.parse(
    await readFile(resolve(root, 'resolved-environment.json'), 'utf8'),
  );
  if (
    status.stage !== 'ready' ||
    !['api-a', 'api-b', 'bgworker', 'front', 'proxy', 'redis'].every(
      (role) => status.processes[role] === true,
    ) ||
    status.run !== run ||
    status.origin !== origin ||
    origin !== process.env.ECHO_BASE_URL ||
    process.env.ECHO_CONFIG_PATH !== resolve(root, 'config-a.toml') ||
    process.env.DEVICE_FILE_PREVIEW_CONFIG_B !== resolve(root, 'config-b.toml') ||
    environment.main_db !== process.env.TEST_DB_NAME ||
    environment.files_db !== process.env.TEST_WDFILE_DB_NAME ||
    environment.bucket !== process.env.DEVICE_FILE_PREVIEW_S3_BUCKET ||
    process.env.DEVICE_FILE_PREVIEW_S3_ENDPOINT !== `http://127.0.0.1:${environment.s3_port}`
  )
    throw new Error(
      'File-preview environment does not match its private configuration and running resources.',
    );
  const fixturePath = resolve(root, 'fixtures-private.json');
  if ((await stat(fixturePath)).mode & 0o077) throw new Error('Actor fixtures must be private.');
  const fixtures: PreviewFixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
  if (fixtures.run !== run) throw new Error('Actor fixtures belong to another run.');
  return { root, origin, fixtures, fixturePath };
}

export async function localFilePreviewBackend() {
  const environment = await ownedEnvironment();
  const contexts: APIRequestContext[] = [];
  async function login(key: string) {
    const actor = environment.fixtures.actors[key];
    if (!actor?.password) throw new Error(`Missing file-preview actor: ${key}`);
    const api = await request.newContext({ baseURL: environment.origin, timeout: 120_000 });
    contexts.push(api);
    const response = await api.post('/api/user/test-api-login', {
      data: { user: actor.login, password: actor.password },
      maxRedirects: 0,
    });
    if (response.status() !== 200) throw new Error(`Fixture login: HTTP ${response.status()}`);
    const state = await api.storageState();
    if (!state.cookies.some((cookie) => cookie.name === 'id'))
      throw new Error('Fixture login returned no actual identity cookie.');
    const authenticated = await request.newContext({
      baseURL: environment.origin,
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
  return {
    ...environment,
    login,
    route: (api: 'a' | 'b', mediaPreflight = api, mediaStream = api) => {
      const harness = fileURLToPath(
        new URL('../../../scripts/devices/test-file-preview.sh', import.meta.url),
      );
      execFileSync(
        harness,
        [
          'route',
          '--root',
          environment.root,
          '--api',
          api,
          '--media-preflight',
          mediaPreflight,
          '--media-stream',
          mediaStream,
        ],
        { encoding: 'utf8' },
      );
    },
    dispose: () => Promise.all(contexts.map((context) => context.dispose())),
  };
}

export async function previewPost<T>(
  api: APIRequestContext,
  path: string,
  body: object,
): Promise<T> {
  const response = await api.post(path, { data: transformCamelToSnake(body), maxRedirects: 0 });
  if (!response.ok()) throw new Error(`${path}: HTTP ${response.status()}`);
  return transformSnakeToCamel<T>(await response.json());
}

export async function syncPreviewFile(
  api: APIRequestContext,
  deviceId: string,
  fixture: DeviceFilePreviewFixture,
) {
  const requestBody: SyncDeviceFilesReq = {
    deviceId,
    files: [
      {
        absolutePath: `C:\\preview\\${fixture.revisionPair ?? fixture.id}\\${fixture.fileName}`,
        mimeType: fixture.mimeType,
        extension: fixture.extension || null,
        fileMetadataCreatedAt: null,
        fileMetadataModifiedAt: new Date().toISOString(),
        sourceFileState: null,
      },
    ],
  };
  const response = await previewPost<unknown>(api, '/api/device/files/sync', requestBody);
  if (
    !response ||
    typeof response !== 'object' ||
    !('results' in response) ||
    !Array.isArray(response.results)
  )
    throw new Error('FileSync returned no operational result list.');
  const result = response.results[0];
  if (!result || typeof result !== 'object' || result.status !== 'accepted' || !result.file)
    throw new Error(
      `Actual FileSync rejected ${fixture.id}: ${result?.message ?? 'missing accepted result'}`,
    );
  return result.file as DeviceFile;
}

export function previewOriginalHref(deviceId: string, fileId: string, revision: number) {
  return `/api/device/files/${deviceId}/${fileId}/revisions/${revision}/content`;
}

export async function uploadPreviewContent(
  api: APIRequestContext,
  deviceId: string,
  file: DeviceFile,
  bytes: Buffer,
) {
  const digest = createHash('sha256').update(bytes).digest();
  const path = `/api/device/files/${deviceId}/${file.fileId}/revisions/${file.revision}/content-uploads`;
  const created = await api.post(path, {
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(bytes.length),
      'Upload-Metadata': `sha256 ${digest.toString('base64')}`,
    },
    maxRedirects: 0,
  });
  if (created.status() !== 201) throw new Error(`File TUS create: HTTP ${created.status()}`);
  const location = created.headers().location;
  if (!location || !/^\/api\/device\/file-content-uploads\/[a-f0-9-]{36}$/.test(location))
    throw new Error('File TUS did not return a same-origin upload resource.');
  let offset = 0;
  while (offset < bytes.length) {
    const end = Math.min(bytes.length, offset + 1024 * 1024);
    const patched = await api.patch(location, {
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
      },
      data: bytes.subarray(offset, end),
      maxRedirects: 0,
    });
    if (patched.status() !== 204 || Number(patched.headers()['upload-offset']) !== end)
      throw new Error(`File TUS PATCH failed at offset ${offset}: HTTP ${patched.status()}`);
    offset = end;
  }
  const head = await api.head(location, { headers: { 'Tus-Resumable': '1.0.0' }, maxRedirects: 0 });
  if (head.status() !== 204 || Number(head.headers()['upload-offset']) !== bytes.length)
    throw new Error('Actual TUS resource lost its persisted upload offset.');
  const completed = await api.post(`${location}/complete`, {
    headers: { 'Tus-Resumable': '1.0.0' },
    maxRedirects: 0,
  });
  if (completed.status() !== 200) throw new Error(`File TUS complete: HTTP ${completed.status()}`);
  const result = await completed.json();
  if (
    result.file_id !== file.fileId ||
    result.revision !== file.revision ||
    result.status !== 'completed'
  )
    throw new Error('TUS completed a different source revision.');
  const originalHref = previewOriginalHref(deviceId, file.fileId, file.revision);
  const original = await api.get(originalHref, { maxRedirects: 0 });
  if (original.status() !== 200 || !Buffer.from(await original.body()).equals(bytes))
    throw new Error('Published original bytes differ from the FileSync/TUS fixture.');
  return { originalHref, sha256: digest.toString('hex') };
}

async function enableDevices(admin: APIRequestContext) {
  const current = await previewPost<SystemSettingsCurrentRsp>(
    admin,
    '/api/system-settings/current',
    {},
  );
  if (current.devicesSectionEnabled) return;
  const { id: _id, ...settings } = current;
  const body: CreateSystemSettingsReq = {
    ...settings,
    devicesSectionEnabled: true,
    echoRestapiErrorDiscordWebhookUrl: null,
    messengerMediaCacheEnabled: false,
    messengerMediaCacheRetentionHours: 24,
    messengerMediaCacheMaxSizeGib: 1,
    messengerMediaCacheMinFreeGib: 1,
  };
  const created = await previewPost<SystemSettingsItem>(
    admin,
    '/api/admin/system-settings/create',
    body,
  );
  await previewPost(admin, '/api/admin/system-settings/activate', { id: created.id });
}

export async function seedFilePreviewFixtures() {
  const backend = await localFilePreviewBackend();
  const save = () =>
    writeFile(backend.fixturePath, `${JSON.stringify(backend.fixtures, null, 2)}\n`, {
      mode: 0o600,
    });
  try {
    if (backend.fixtures.seedComplete)
      throw new Error('This run is already seeded; create a fresh run for repeatable revisions.');
    const admin = await backend.login('admin');
    await enableDevices(admin);
    const organism = await previewPost<Organism>(admin, '/api/organism/create', {
      name: `preview-${backend.fixtures.run}`,
      parentId: null,
      roles: ['Cyber'],
      aorIds: [],
    } satisfies CreateOrganismReq);
    const foreign = await previewPost<Organism>(admin, '/api/organism/create', {
      name: `preview-denied-${backend.fixtures.run}`,
      parentId: null,
      roles: ['Cyber'],
      aorIds: [],
    } satisfies CreateOrganismReq);
    for (const [key, roles, organismId] of [
      ['source', ['Cyber', 'Api'], organism.id],
      ['reader', ['Cyber', 'Api'], organism.id],
      ['denied-role', ['Api'], organism.id],
      ['denied-scope', ['Cyber', 'Api'], foreign.id],
    ] as const) {
      const password = randomBytes(24).toString('base64url');
      const user = await previewPost<Login>(admin, '/api/login/create', {
        login: `preview-${key}-${backend.fixtures.run}`,
        password,
        roles: [...roles],
        sigintZoneId: backend.fixtures.bootstrap.sigintZoneId,
        organismId,
        description: 'Owned file preview fixture',
      } satisfies CreateLoginReq);
      backend.fixtures.actors[key] = {
        id: user.id,
        login: user.login,
        password,
        roles: [...roles],
      };
      await save();
    }
    const source = await backend.login('source');
    const device = await previewPost<DeviceDetails>(source, '/api/device/create', {
      name: `preview-${backend.fixtures.run}`,
    });
    backend.fixtures.deviceId = device.id;
    backend.fixtures.unverified = [
      'No separate read-only Devices role exists in the current permission contract; reader is Cyber + Api.',
      ...DEVICE_FILE_PREVIEW_FIXTURES.filter((fixture) => fixture.availability === 'absent').map(
        (fixture) => `Absent fixture: ${fixture.id}`,
      ),
      'Duty/Analysis rendering and Alpine conversion outcomes are not verified by API seeding.',
    ];
    await save();
    for (const fixture of DEVICE_FILE_PREVIEW_SEED_FIXTURES) {
      const { bytes } = await loadDeviceFilePreviewFixture(fixture.id);
      const file = await syncPreviewFile(source, device.id, fixture);
      const result = await uploadPreviewContent(source, device.id, file, bytes);
      backend.fixtures.seeded.push({ fixtureId: fixture.id, file, ...result });
      await save();
    }
    const history = backend.fixtures.seeded.filter((entry) =>
      ['historical-text', 'current-text'].includes(entry.fixtureId),
    );
    if (
      history.length !== 2 ||
      history[0].file.fileId !== history[1].file.fileId ||
      history[0].file.revision >= history[1].file.revision
    )
      throw new Error(
        'FileSync did not create two ordered revisions of the same historical source.',
      );
    const reader = await backend.login('reader');
    const deniedRole = await backend.login('denied-role');
    const deniedScope = await backend.login('denied-scope');
    for (const entry of history) {
      const original = await reader.get(entry.originalHref);
      if (
        original.status() !== 200 ||
        createHash('sha256')
          .update(await original.body())
          .digest('hex') !== entry.sha256
      )
        throw new Error('Reader received wrong or unavailable historical bytes.');
      if (
        (await deniedRole.head(entry.originalHref)).status() !== 403 ||
        (await deniedScope.head(entry.originalHref)).status() !== 404
      )
        throw new Error('Actual role/scope denial did not protect the original fixture.');
    }
    backend.fixtures.seedComplete = true;
    await save();
  } finally {
    await backend.dispose();
  }
}

if (process.argv.includes('--seed')) {
  seedFilePreviewFixtures().catch((error: Error) => {
    console.error(`Device preview seed failed: ${error.message}`);
    process.exitCode = 1;
  });
}
