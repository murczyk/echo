/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceFileJournalEntry, JournalDeviceFilesRsp } from '../../../../../Bindings';
import { HttpRequestError } from '../../../services/api/client';
import { useDeviceFileJournal, type DeviceFileJournalState } from '.././use-device-file-journal';

const apiMock = vi.hoisted(() => ({
  journalDeviceFiles: vi.fn(),
}));

vi.mock('../../../services/api/devices', () => apiMock);

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const FILE_ONE_ID = '018f0000-0000-7000-8000-000000000001';
const FILE_TWO_ID = '018f0000-0000-7000-8000-000000000002';

function journalEntry(
  fileId: string,
  name: string,
  synchronizedAt = '2026-07-28T08:00:00Z',
): DeviceFileJournalEntry {
  return {
    fileId,
    name,
    absolutePath: `/var/log/${name}`,
    hasContent: false,
    tags: [],
    synchronizedAt,
  };
}

function journalResponse(
  entries: DeviceFileJournalEntry[],
  nextCursor: string | null = null,
  totalCount = entries.length,
): JournalDeviceFilesRsp {
  return { entries, totalCount, nextCursor };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let enabled = false;
let latest: DeviceFileJournalState | null = null;

function Harness() {
  latest = useDeviceFileJournal({
    deviceId: DEVICE_ID,
    enabled,
    tagFilter: { tagIds: [], tagMatch: 'any', untagged: false },
  });
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderHook() {
  await act(async () => {
    root?.render(<Harness />);
  });
  await flush();
}

beforeEach(() => {
  enabled = false;
  apiMock.journalDeviceFiles.mockResolvedValue(
    journalResponse([journalEntry(FILE_ONE_ID, 'first.log')]),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
  vi.clearAllMocks();
});
describe('useDeviceFileJournal', () => {
  it('loads only while active and reloads fresh data when re-entered', async () => {
    await renderHook();
    expect(apiMock.journalDeviceFiles).not.toHaveBeenCalled();

    enabled = true;
    await renderHook();
    expect(apiMock.journalDeviceFiles).toHaveBeenCalledTimes(1);
    expect(latest?.entries.map((entry) => entry.name)).toEqual(['first.log']);
    expect(latest?.totalCount).toBe(1);

    enabled = false;
    await renderHook();
    expect(latest?.entries).toEqual([]);
    expect(latest?.totalCount).toBeNull();

    apiMock.journalDeviceFiles.mockResolvedValueOnce(
      journalResponse([journalEntry(FILE_TWO_ID, 'second.log')]),
    );
    enabled = true;
    await renderHook();

    expect(apiMock.journalDeviceFiles).toHaveBeenCalledTimes(2);
    expect(latest?.entries.map((entry) => entry.name)).toEqual(['second.log']);
  });

  it('appends keyset pages and ignores a repeated file row', async () => {
    apiMock.journalDeviceFiles
      .mockResolvedValueOnce(
        journalResponse([journalEntry(FILE_ONE_ID, 'first.log')], 'next-page', 2),
      )
      .mockResolvedValueOnce(
        journalResponse(
          [journalEntry(FILE_ONE_ID, 'first.log'), journalEntry(FILE_TWO_ID, 'second.log')],
          null,
          2,
        ),
      );
    enabled = true;
    await renderHook();

    await act(async () => {
      await latest?.loadMore();
    });

    expect(apiMock.journalDeviceFiles.mock.calls[1][0]).toMatchObject({
      deviceId: DEVICE_ID,
      cursor: 'next-page',
    });
    expect(latest?.entries.map((entry) => entry.fileId)).toEqual([FILE_ONE_ID, FILE_TWO_ID]);
    expect(latest?.nextCursor).toBeNull();
    expect(latest?.totalCount).toBe(2);
  });

  it('keeps load failures visible and supports retry', async () => {
    apiMock.journalDeviceFiles.mockRejectedValueOnce(
      new HttpRequestError(500, 'registry unavailable'),
    );
    enabled = true;
    await renderHook();

    expect(latest?.error?.status).toBe(500);
    expect(latest?.totalCount).toBeNull();
    expect(latest?.error?.message).toContain('Помилка завантаження журналу синхронізації');

    apiMock.journalDeviceFiles.mockResolvedValueOnce(
      journalResponse([journalEntry(FILE_ONE_ID, 'recovered.log')]),
    );
    await act(async () => {
      await latest?.reload();
    });

    expect(latest?.error).toBeNull();
    expect(latest?.entries[0].name).toBe('recovered.log');
  });
});
