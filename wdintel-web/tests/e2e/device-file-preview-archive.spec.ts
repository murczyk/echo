import { openDeviceSection } from './device-pages.ui';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type {
  BrowseDeviceFilesRsp,
  DeviceAnalyticsSummaryRsp,
  DeviceArchiveStatus,
  DeviceFile,
  DeviceFileTreeEntry,
  BrowseDeviceFilesReq,
} from '../../src/Bindings';
import { transformSnakeToCamel } from '../../src/ts/snake-to-camel';
import { zipSync, strToU8 } from 'fflate';
import {
  localFilePreviewBackend,
  syncPreviewFile,
  uploadPreviewContent,
  previewPost,
  previewOriginalHref,
} from './device-file-preview-backend';
import {
  DEVICE_FILE_PREVIEW_FIXTURES,
  loadDeviceFilePreviewFixture,
} from './device-file-preview.fixtures';
import { openDeviceFilePreviewEntry } from './device-file-preview.ui';

async function browseArchive(
  reader: APIRequestContext,
  deviceId: string,
  file: Pick<DeviceFile, 'fileId' | 'revision'>,
  request: Partial<BrowseDeviceFilesReq> = {},
) {
  return previewPost<BrowseDeviceFilesRsp>(reader, '/api/device/files/browse', {
    deviceId,
    parentEntryId: file.fileId,
    archiveRevision: file.revision,
    ...request,
  });
}

function contentRef(entry: DeviceFileTreeEntry) {
  if (!entry.fileId || entry.revision === null) throw new Error('Missing member revision');
  return { fileId: entry.fileId, revision: entry.revision };
}

test('#3778 @regression ZIP history keeps nested bytes and source counts after the next sync', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const backend = await localFilePreviewBackend();
  try {
    const deviceId = backend.fixtures.deviceId!;
    const source = await backend.login('source');
    const reader = await backend.login('reader');
    const fixture = {
      ...DEVICE_FILE_PREVIEW_FIXTURES.find((entry) => entry.id === 'archive-zip')!,
      id: `archive-history-${randomUUID()}`,
      fileName: 'history.zip',
    };
    const summary = (syncId: string | null = null) =>
      previewPost<DeviceAnalyticsSummaryRsp>(reader, '/api/device/analytics/summary', {
        deviceId,
        syncId,
      });
    const baseline = await summary();
    const physical = await syncPreviewFile(source, deviceId, {
      ...fixture,
      fileName: 'Report.txt',
      extension: 'txt',
      mimeType: 'text/plain',
    });
    await uploadPreviewContent(source, deviceId, physical, Buffer.from('physical Report.txt'));
    const audio = (await loadDeviceFilePreviewFixture('audio-wav')).bytes;
    const versions: Array<{
      label: string;
      file: DeviceFile;
      bytes: Buffer;
      members: Record<string, Uint8Array>;
      archiveUrl: string;
      tree: BrowseDeviceFilesRsp;
    }> = [];
    for (const label of ['A', 'B']) {
      const members = {
        'Report.txt': strToU8(`upper ${label}`),
        'report.txt': strToU8(`lower ${label}`),
        'docs/member.txt': strToU8(`directory ${label}`),
        'nested.zip': zipSync({ 'inner.txt': strToU8(`nested ${label}`) }),
        'sound.wav': audio,
        'route.kml': strToU8(
          `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>${label}</name><Point><coordinates>${label === 'A' ? '30,50' : '31,51'},0</coordinates></Point></Placemark></kml>`,
        ),
      };
      const bytes = Buffer.from(zipSync({ ...members, empty: {} }));
      const file = await syncPreviewFile(source, deviceId, fixture);
      await uploadPreviewContent(source, deviceId, file, bytes);
      const archiveUrl = previewOriginalHref(deviceId, file.fileId, file.revision).replace(
        /\/content$/,
        '/archive',
      );
      await expect
        .poll(
          async () => {
            const response = await reader.get(archiveUrl);
            expect(response.status()).toBe(200);
            return transformSnakeToCamel<DeviceArchiveStatus>(await response.json()).archive.state;
          },
          { timeout: 45_000, intervals: [1000] },
        )
        .toBe('ready');
      const tree = await browseArchive(reader, deviceId, file);
      expect(tree.entries.some((entry) => entry.name === 'empty')).toBe(true);
      versions.push({ label, file, bytes, members, archiveUrl, tree });
    }
    const [a, b] = versions;
    expect(a.file.fileId).toBe(b.file.fileId);
    expect(a.file.revision).toBeLessThan(b.file.revision);
    expect(a.file.fileId).toBe(b.file.fileId);
    expect(a.file.revision).not.toBe(b.file.revision);
    expect(a.tree.entries.find((entry) => entry.name === 'nested.zip')!.entryId).toBe(
      b.tree.entries.find((entry) => entry.name === 'nested.zip')!.entryId,
    );
    expect((await summary()).totalFileCount).toBe(baseline.totalFileCount + 2);
    expect((await summary()).filesWithContentCount).toBe(baseline.filesWithContentCount + 2);
    await page.context().addCookies((await reader.storageState()).cookies);
    for (const version of [a, b, a]) {
      const { file, tree, archiveUrl, members, label } = version;
      const historical = await previewPost<BrowseDeviceFilesRsp>(
        reader,
        '/api/device/files/browse',
        {
          deviceId,
          syncId: file.syncId,
          parentEntryId: file.parentEntryId,
        },
      );
      expect(historical.entries.find((entry) => entry.fileId === file.fileId)).toMatchObject({
        revision: file.revision,
        archive: { state: 'ready' },
      });
      expect((await summary(file.syncId)).totalFileCount).toBe(1);
      const names: string[] = [];
      let cursor: string | null = null;
      do {
        const result: BrowseDeviceFilesRsp = await browseArchive(reader, deviceId, file, {
          limit: 1,
          cursor,
          hasContent: true,
        });
        names.push(...result.entries.map((entry) => entry.name));
        cursor = result.nextCursor;
        if (cursor && names.length === 1) {
          expect(
            (
              await reader.post('/api/device/files/browse', {
                data: {
                  device_id: deviceId,
                  parent_entry_id: file.fileId,
                  archive_revision: (version === b ? a : b).file.revision,
                  limit: 1,
                  cursor,
                  has_content: true,
                },
              })
            ).status(),
          ).toBe(400);
          expect(
            (
              await reader.post('/api/device/files/browse', {
                data: {
                  device_id: deviceId,
                  parent_entry_id: file.fileId,
                  archive_revision: file.revision,
                  limit: 1,
                  cursor,
                  has_content: false,
                },
              })
            ).status(),
          ).toBe(400);
        }
      } while (cursor);
      expect(names).toEqual([
        'docs',
        'Report.txt',
        'nested.zip',
        'report.txt',
        'route.kml',
        'sound.wav',
      ]);
      const docs = tree.entries.find((entry) => entry.name === 'docs')!;
      const directory = await browseArchive(reader, deviceId, file, {
        parentEntryId: docs.entryId,
      });
      expect(directory.breadcrumbs.map((part) => part.name).slice(-2)).toEqual([
        'history.zip',
        'docs',
      ]);
      for (const member of [...tree.entries, ...directory.entries].filter(
        (entry) => entry.kind === 'file',
      )) {
        const target = contentRef(member);
        const url = previewOriginalHref(deviceId, target.fileId, target.revision);
        const response = await reader.get(url);
        expect(response.status()).toBe(200);
        expect(await response.body()).toEqual(
          Buffer.from(
            members[
              member.virtualPath!.slice(file.absolutePath!.length + 1) as keyof typeof members
            ],
          ),
        );
        if (member.name === 'sound.wav') {
          const media = await reader.get(url.replace(/\/content$/, '/preview/media'));
          expect(media.status()).toBe(200);
          expect(await media.body()).toEqual(audio);
        }
        if (member.name === 'nested.zip') {
          const nestedUrl = url.replace(/\/content$/, '/archive');
          await expect
            .poll(
              async () =>
                transformSnakeToCamel<DeviceArchiveStatus>(
                  await (await reader.get(nestedUrl)).json(),
                ).archive.state,
              { timeout: 45_000, intervals: [1000] },
            )
            .toBe('ready');
          const nested = await browseArchive(reader, deviceId, target);
          expect(nested.breadcrumbs.at(-1)?.name).toBe('nested.zip');
          const inner = contentRef(nested.entries[0]);
          expect(
            await (
              await reader.get(previewOriginalHref(deviceId, inner.fileId, inner.revision))
            ).body(),
          ).toEqual(Buffer.from(`nested ${label}`));
        }
      }
      await page.goto(`/devices/${deviceId}?sync_id=${file.syncId}`);
      await openDeviceSection(page, 'Файли');
      const fileTree = page.getByTestId('device-files-tree');
      for (const name of ['preview', fixture.id]) {
        await fileTree
          .getByRole('button', { name: `Розгорнути каталог ${name}`, exact: true })
          .click();
      }
      await fileTree.getByTestId(`device-file-${file.fileId}`).click();
      const pane = page.getByTestId('device-file-content-pane');
      const folder = page.getByRole('region', { name: 'Вміст папки', exact: true });
      const returnToArchive = () => fileTree.getByTestId(`device-file-${file.fileId}`).click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('directory_revision'))
        .toBe(String(file.revision));
      await expect(pane).toHaveCount(0);
      const original = await reader.get(previewOriginalHref(deviceId, file.fileId, file.revision));
      expect(original.status()).toBe(200);
      expect(await original.body()).toEqual(version.bytes);
      await folder.getByRole('button', { name: 'Відкрити файл Report.txt', exact: true }).click();
      await expect(pane.locator('pre')).toHaveText(`upper ${label}`);
      const downloaded = page.waitForEvent('download', { timeout: 90_000 });
      await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
      expect(await readFile((await (await downloaded).path())!)).toEqual(
        Buffer.from(`upper ${label}`),
      );
      await returnToArchive();
      await folder.getByRole('button', { name: 'Відкрити файл sound.wav', exact: true }).click();
      const player = pane.locator('custom-audio-player');
      await expect
        .poll(() =>
          player.evaluate(
            (host: HTMLElement & { audio: HTMLAudioElement }) => host.audio.readyState,
          ),
        )
        .toBeGreaterThanOrEqual(2);
      const sound = contentRef(tree.entries.find((entry) => entry.name === 'sound.wav')!);
      expect(
        await player.evaluate(
          (host: HTMLElement & { audio: HTMLAudioElement }) => host.audio.currentSrc,
        ),
      ).toContain(`/${sound.fileId}/revisions/${sound.revision}/preview/media`);
      await returnToArchive();
      await folder.getByRole('button', { name: 'Відкрити папку nested.zip', exact: true }).click();
      await folder.getByRole('button', { name: 'Відкрити файл inner.txt', exact: true }).click();
      await expect(pane.locator('pre')).toHaveText(`nested ${label}`);
      const nestedDownload = page.waitForEvent('download', { timeout: 90_000 });
      await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
      const nestedSaved = await nestedDownload;
      expect(nestedSaved.suggestedFilename()).toBe('inner.txt');
      expect(await readFile((await nestedSaved.path())!)).toEqual(Buffer.from(`nested ${label}`));
      await returnToArchive();
      await folder.getByRole('button', { name: 'Відкрити файл route.kml', exact: true }).click();
      await expect(pane.locator('.leaflet-container')).toBeVisible();
    }
    expect((await summary()).totalFileCount).toBe(baseline.totalFileCount + 2);
    expect(
      await (
        await reader.get(previewOriginalHref(deviceId, physical.fileId, physical.revision))
      ).body(),
    ).toEqual(Buffer.from('physical Report.txt'));
  } finally {
    await backend.dispose();
  }
});

test.setTimeout(120_000);

async function openArchiveTree(page: Page, issue?: 'corrupt' | 'empty-path' | 'empty') {
  const backend = await localFilePreviewBackend();
  try {
    const fixture = {
      ...DEVICE_FILE_PREVIEW_FIXTURES.find((entry) => entry.id === 'archive-zip')!,
      id: 'archive-tree',
      fileName: 'echo-archive-tree.zip',
    };
    const image = await loadDeviceFilePreviewFixture('image-png');
    const pdf = await loadDeviceFilePreviewFixture('document-pdf');
    const audio = await loadDeviceFilePreviewFixture('audio-mp3');
    const video = await loadDeviceFilePreviewFixture('video-mp4');
    const bytes = Buffer.from(
      zipSync(
        issue === 'empty'
          ? {}
          : {
              'docs/readme.txt': strToU8('Файл усередині архіву Echo'),
              'docs/this-is-a-very-long-file-name-that-needs-an-ellipsis.txt': strToU8('Long name'),
              'docs/report.pdf': pdf.bytes,
              'images/picture.png': image.bytes,
              'sound.mp3': audio.bytes,
              'Report.txt': strToU8('Upper case bytes'),
              'report.txt': strToU8('Lower case bytes'),
              'empty/': new Uint8Array(),
              'movie.mp4': video.bytes,
              'route.gpx': strToU8('<gpx version="1.1"/>'),
              ...(issue === 'empty-path' ? { '.': strToU8('invalid file name') } : {}),
              'nested.zip': zipSync({ 'inner.txt': strToU8('Вкладений ZIP Echo') }),
            },
      ),
    );
    if (issue === 'corrupt') {
      const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      bytes[central + 16] = bytes[central + 16]! ^ 1;
    }
    const api = await backend.login('source');
    const file = await syncPreviewFile(api, backend.fixtures.deviceId!, fixture);
    const receipt = await uploadPreviewContent(api, backend.fixtures.deviceId!, file, bytes);
    const reader = await backend.login('reader');
    const archiveUrl = `/api/device/files/${backend.fixtures.deviceId}/${file.fileId}/revisions/${file.revision}/archive`;
    let archive!: DeviceArchiveStatus;
    await expect
      .poll(
        async () => {
          const response = await reader.get(archiveUrl);
          expect(response.status()).toBe(200);
          archive = transformSnakeToCamel<DeviceArchiveStatus>(await response.json());
          return archive.archive.state;
        },
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe(issue && issue !== 'empty' ? 'failed' : 'ready');
    const list = (directoryEntryId: string | null = null) =>
      browseArchive(reader, backend.fixtures.deviceId!, file, {
        parentEntryId: directoryEntryId ?? file.fileId,
      });
    const memberHref = async (name: string, directory?: string) => {
      let entries = (await list()).entries;
      if (directory)
        entries = (await list(entries.find((entry) => entry.name === directory)!.entryId)).entries;
      const member = contentRef(entries.find((entry) => entry.name === name)!);
      expect(member.fileId).not.toBe(file.fileId);
      expect(member.revision).toBe(file.revision);
      return previewOriginalHref(backend.fixtures.deviceId!, member.fileId, member.revision);
    };
    await page.context().addCookies((await reader.storageState()).cookies);
    await page.goto(`/devices/${backend.fixtures.deviceId}`, { waitUntil: 'domcontentloaded' });
    await openDeviceSection(page, 'Файли');
    await page.getByRole('button', { name: 'Розгорнути каталог preview', exact: true }).click();
    await page
      .getByRole('button', { name: 'Розгорнути каталог archive-tree', exact: true })
      .click();
    return { backend, receipt, file, bytes, reader, archive, archiveUrl, list, memberHref };
  } catch (error) {
    await backend.dispose();
    throw error;
  }
}

test('@regression ZIP folders open archive members in the ordinary file preview', async ({
  page,
}) => {
  const { backend } = await openArchiveTree(page);
  try {
    const tree = page.getByTestId('device-files-tree');
    const pane = page.getByTestId('device-file-content-pane');
    await tree
      .getByRole('button', { name: 'Розгорнути каталог echo-archive-tree.zip', exact: true })
      .click();
    await tree.getByRole('button', { name: 'Розгорнути каталог docs', exact: true }).click();
    await tree.getByRole('button', { name: 'readme.txt', exact: true }).click();
    await expect(pane.locator('pre')).toContainText('Файл усередині архіву Echo');
    await expect(pane.locator('#device-file-content-title')).toContainText('echo-archive-tree.zip');
    const download = page.waitForEvent('download');
    await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('readme.txt');
    await tree.getByRole('button', { name: 'report.pdf', exact: true }).click();
    await expect(pane.locator('.react-pdf__Page__canvas').first()).toBeVisible();
    await tree.getByRole('button', { name: 'Розгорнути каталог images', exact: true }).click();
    await tree.getByRole('button', { name: 'picture.png', exact: true }).click();
    await expect
      .poll(() => pane.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(80);
    await tree.getByRole('button', { name: 'movie.mp4', exact: true }).click();
    await expect
      .poll(() => pane.locator('video').evaluate((video: HTMLVideoElement) => video.readyState))
      .toBeGreaterThanOrEqual(1);
    await tree.getByRole('button', { name: 'sound.mp3', exact: true }).click();
    await expect(pane.locator('[data-audio-player-host]')).toBeVisible();
    await tree.getByRole('button', { name: 'Розгорнути каталог nested.zip', exact: true }).click();
    await tree.getByRole('button', { name: 'inner.txt', exact: true }).click();
    await expect(pane.locator('pre')).toContainText('Вкладений ZIP Echo');
  } finally {
    await backend.dispose();
  }
});

test('@regression file explorer resizes and uses the whole row for folders and files', async ({
  page,
}) => {
  const { backend, file } = await openArchiveTree(page);
  try {
    const sidebar = page.getByTestId('device-files-sidebar');
    const tree = page.getByTestId('device-files-tree');
    const separator = page.getByRole('separator', { name: 'Ширина панелі файлів' });
    await expect(separator).toBeVisible();
    const initialWidth = (await sidebar.boundingBox())!.width;
    const handle = (await separator.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 120, handle.y + handle.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(initialWidth + 120);
    await separator.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(initialWidth + 110);
    await page.keyboard.press('Home');

    const archive = tree.getByTestId(`device-file-${file.fileId}`);
    await expect(tree).not.toContainText('Windows');

    const clickRightEdge = async (row: ReturnType<Page['locator']>) => {
      await row.scrollIntoViewIfNeeded();
      const bounds = (await row.boundingBox())!;
      const panel = (await sidebar.boundingBox())!;
      expect(bounds.width).toBeGreaterThan(panel.width - 12);
      await row.click({ position: { x: bounds.width - 4, y: bounds.height / 2 } });
    };
    const directory = tree.getByRole('button', { name: /^Вибрати каталог archive-tree / });
    await clickRightEdge(directory);
    await expect(archive).toBeHidden();
    await clickRightEdge(directory);
    await expect(archive).toBeVisible();
    await clickRightEdge(archive);
    const docs = tree.getByRole('button', { name: 'docs', exact: true });
    await expect(docs).toBeVisible();
    await clickRightEdge(archive);
    await expect(docs).toBeHidden();
    await clickRightEdge(archive);
    await expect(docs).toBeVisible();
    await clickRightEdge(docs);
    const name = tree.getByText('this-is-a-very-long-file-name-that-needs-an-ellipsis.txt', {
      exact: true,
    });
    await expect
      .poll(() => name.evaluate((element) => element.scrollWidth > element.clientWidth))
      .toBe(true);
    expect(await name.evaluate((element) => getComputedStyle(element).textOverflow)).toBe(
      'ellipsis',
    );
    const readme = tree.getByRole('button', { name: 'readme.txt', exact: true });
    await clickRightEdge(readme);
    await expect(page.getByTestId('device-file-content-pane').locator('pre')).toContainText(
      'Файл усередині архіву Echo',
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(readme).toBeVisible();
    await clickRightEdge(docs);
    await expect(readme).toBeHidden();
    await clickRightEdge(archive);
    await expect(docs).toBeHidden();
    await clickRightEdge(archive);
    const nested = tree.getByRole('button', { name: 'nested.zip', exact: true });
    await clickRightEdge(nested);
    const inner = tree.getByRole('button', { name: 'inner.txt', exact: true });
    await expect(inner).toBeVisible();
    await clickRightEdge(nested);
    await expect(inner).toBeHidden();
  } finally {
    await backend.dispose();
  }
});

test('@regression archive member access is rechecked after listing', async ({ page }) => {
  const { backend, memberHref } = await openArchiveTree(page);
  try {
    const tree = page.getByTestId('device-files-tree');
    await tree
      .getByRole('button', { name: 'Розгорнути каталог echo-archive-tree.zip', exact: true })
      .click();
    await tree.getByRole('button', { name: 'Розгорнути каталог docs', exact: true }).click();
    await page.route(`**${await memberHref('readme.txt', 'docs')}`, (route) =>
      route.fulfill({ status: 403, body: 'Access denied' }),
    );
    await tree.getByRole('button', { name: 'readme.txt', exact: true }).click();
    const pane = page.getByTestId('device-file-content-pane');
    await expect(pane.getByRole('alert')).toBeVisible();
    await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeDisabled();
    await expect(pane.locator('pre')).toHaveCount(0);
  } finally {
    await backend.dispose();
  }
});

test('@regression archive maps address their member in the conversion queue', async ({ page }) => {
  const { backend } = await openArchiveTree(page);
  try {
    const tree = page.getByTestId('device-files-tree');
    await tree
      .getByRole('button', { name: 'Розгорнути каталог echo-archive-tree.zip', exact: true })
      .click();
    const prepared = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/preview/geodata') &&
        !response.url().includes('archive_members='),
    );
    await tree.getByRole('button', { name: 'route.gpx', exact: true }).click();
    const response = await prepared;
    expect([200, 202, 503]).toContain(response.status());
    if (response.status() === 503) {
      expect((await response.json()).code).toBe('preview_unavailable');
      await expect(page.getByTestId('device-file-content-pane').getByRole('alert')).toBeVisible();
    }
  } finally {
    await backend.dispose();
  }
});

test('@regression a late persisted member response cannot replace the selected member', async ({
  page,
}) => {
  const { backend, memberHref } = await openArchiveTree(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const tree = page.getByTestId('device-files-tree');
    const pane = page.getByTestId('device-file-content-pane');
    await tree
      .getByRole('button', { name: 'Розгорнути каталог echo-archive-tree.zip', exact: true })
      .click();
    await tree.getByRole('button', { name: 'Розгорнути каталог docs', exact: true }).click();
    let intercepted!: () => void;
    const started = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    let first = true;
    await page.route(`**${await memberHref('readme.txt', 'docs')}`, async (route) => {
      if (first && route.request().method() === 'GET') {
        first = false;
        const response = await route.fetch();
        intercepted();
        await held;
        await route.fulfill({ response }).catch(() => {});
      } else await route.continue();
    });
    await tree.getByRole('button', { name: 'readme.txt', exact: true }).click();
    await started;
    await tree.getByRole('button', { name: 'report.pdf', exact: true }).click();
    await expect(pane.locator('.react-pdf__Page__canvas').first()).toBeVisible();
    release();
    await expect(pane.locator('#device-file-content-title')).toContainText('report.pdf');
    await expect(pane.locator('pre')).toHaveCount(0);
  } finally {
    release();
    await backend.dispose();
  }
});

test('@regression an invalid archive exposes no members and keeps the original download', async ({
  page,
}) => {
  const { backend, file, receipt, bytes, reader, archiveUrl } = await openArchiveTree(
    page,
    'corrupt',
  );
  try {
    const tree = page.getByTestId('device-files-tree');
    await tree
      .getByRole('button', { name: 'Розгорнути файл echo-archive-tree.zip', exact: true })
      .click();
    await expect(tree.getByRole('status')).toHaveCount(0);
    await tree.getByTestId(`device-file-${file.fileId}`).click();
    await expect(page.getByTestId('device-file-content-pane')).toContainText(
      /пошкоджено|цілісності/,
    );
    await expect(tree.getByRole('button', { name: 'readme.txt', exact: true })).toHaveCount(0);
    expect(
      (
        await reader.post('/api/device/files/browse', {
          data: {
            device_id: backend.fixtures.deviceId,
            parent_entry_id: file.fileId,
            archive_revision: file.revision,
          },
        })
      ).status(),
    ).toBe(409);
    const original = await reader.get(receipt.originalHref);
    expect(await original.body()).toEqual(bytes);
    const terminal = await reader.post(archiveUrl);
    expect(terminal.status()).toBe(200);
    expect((await terminal.json()).archive.state).toBe('failed');
  } finally {
    await backend.dispose();
  }
});

test('@regression an unsafe archive path reports an error without publishing a tree', async ({
  page,
}) => {
  const { backend, file } = await openArchiveTree(page, 'empty-path');
  try {
    const tree = page.getByTestId('device-files-tree');
    await tree
      .getByRole('button', { name: 'Розгорнути файл echo-archive-tree.zip', exact: true })
      .click();
    await expect(tree.getByRole('status')).toHaveCount(0);
    await tree.getByTestId(`device-file-${file.fileId}`).click();
    await expect(page.getByTestId('device-file-content-pane')).toContainText('небезпечний шлях');
    await expect(
      page
        .getByTestId('device-file-content-pane')
        .getByRole('region', { name: 'Вміст папки', exact: true }),
    ).toHaveCount(0);
    await expect(tree.getByRole('button', { name: 'readme.txt', exact: true })).toHaveCount(0);
  } finally {
    await backend.dispose();
  }
});

test('@regression an empty ZIP is prepared without a browser and opens as one empty folder', async ({
  page,
}) => {
  const { backend, file, archive, reader, archiveUrl } = await openArchiveTree(page, 'empty');
  try {
    expect(archive.archive.state).toBe('ready');
    const tree = page.getByTestId('device-files-tree');
    await expect(tree.getByTestId(`device-file-${file.fileId}`)).toHaveCount(1);
    await tree
      .getByRole('button', { name: 'Розгорнути каталог echo-archive-tree.zip', exact: true })
      .click();
    await expect(tree).not.toContainText('Каталог порожній');
    const repeated = transformSnakeToCamel<DeviceArchiveStatus>(
      await (await reader.post(archiveUrl)).json(),
    );
    expect(repeated.archive.rootEntryId).toBe(archive.archive.rootEntryId);
    await tree.getByTestId(`device-file-${file.fileId}`).click();
    await expect(page.getByRole('region', { name: 'Вміст папки', exact: true })).toContainText(
      'Папка порожня.',
    );
    await expect(page.getByTestId('device-file-content-pane')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('directory')).toBe(file.fileId);
    expect(new URL(page.url()).searchParams.get('directory_revision')).toBe(String(file.revision));
  } finally {
    await backend.dispose();
  }
});

test('@regression case-only names keep separate persisted identities and exact download bytes', async ({
  page,
}) => {
  const { backend, file, bytes, list, memberHref, reader, receipt } = await openArchiveTree(page);
  try {
    const entries = (await list()).entries;
    const upper = entries.find((entry) => entry.name === 'Report.txt')!;
    const lower = entries.find((entry) => entry.name === 'report.txt')!;
    expect(upper.entryId).not.toBe(lower.entryId);
    const tree = page.getByTestId('device-files-tree');
    const pane = page.getByTestId('device-file-content-pane');
    await tree
      .getByRole('button', { name: 'Розгорнути каталог echo-archive-tree.zip', exact: true })
      .click();
    for (const [name, contents] of [
      ['Report.txt', 'Upper case bytes'],
      ['report.txt', 'Lower case bytes'],
    ]) {
      expect(await (await reader.get(await memberHref(name!))).text()).toBe(contents);
      await tree.getByRole('button', { name, exact: true }).click();
      await expect(pane.locator('pre')).toContainText(contents!);
      const download = page.waitForEvent('download');
      await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
      const result = await download;
      expect(result.suggestedFilename()).toBe(name);
      expect((await readFile((await result.path())!)).toString()).toBe(contents);
    }
    await tree.getByRole('button', { name: 'echo-archive-tree.zip', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Вміст папки', exact: true })).toBeVisible();
    await expect(pane).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('directory_revision')).toBe(String(file.revision));
    const original = await reader.get(receipt.originalHref);
    expect(original.status()).toBe(200);
    expect(await original.body()).toEqual(bytes);
  } finally {
    await backend.dispose();
  }
});

test('@regression archive routes enforce current device access and validate requests', async ({
  page,
}) => {
  const { backend, file, reader, archiveUrl } = await openArchiveTree(page, 'empty');
  const browse = {
    device_id: backend.fixtures.deviceId,
    parent_entry_id: file.fileId,
    archive_revision: file.revision,
  };
  try {
    for (const actor of ['denied-role', 'denied-scope']) {
      const denied = await backend.login(actor);
      expect([403, 404]).toContain((await denied.get(archiveUrl)).status());
      expect([403, 404]).toContain((await denied.post(archiveUrl)).status());
      expect([403, 404]).toContain(
        (await denied.post('/api/device/files/browse', { data: browse })).status(),
      );
    }
    const status = await reader.get(archiveUrl);
    expect(status.status()).toBe(200);
    expect(status.headers()['cache-control']).toContain('no-store');
    expect((await reader.post(archiveUrl, { data: {} })).status()).toBe(400);
    expect(
      (await reader.post('/api/device/files/browse', { data: { ...browse, limit: 101 } })).status(),
    ).toBe(400);
    expect(
      (
        await reader.post('/api/device/files/browse', { data: { ...browse, cursor: 'forged' } })
      ).status(),
    ).toBe(400);
    expect(
      (await reader.get(archiveUrl.replace(/\/revisions\/\d+\//, '/revisions/0/'))).status(),
    ).toBe(400);
  } finally {
    await backend.dispose();
  }
});
