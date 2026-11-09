/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowseDeviceFilesRsp, DeviceFileTreeEntry } from '../../../../../Bindings';
import { HttpRequestError } from '../../../services/api/client';
import { useDeviceDirectory } from '../use-device-directory';
import { useDeviceFileBrowseRequests } from '../use-device-file-browse-requests';
import { buildBrowseDeviceFilesReq } from '../helpers';

const api = vi.hoisted(() => ({ browseDeviceFiles: vi.fn() }));
vi.mock('../../../services/api/devices', () => api);

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const DIRECTORY_ID = '018f0000-0000-7000-8000-000000000001';
const OTHER_DIRECTORY_ID = '018f0000-0000-7000-8000-000000000002';

function entry(entryId: string): DeviceFileTreeEntry {
  return {
    entryId,
    parentEntryId: DIRECTORY_ID,
    kind: 'file',
    fileId: entryId,
    name: 'report.txt',
    pathComponents: ['report.txt'],
    absolutePath: 'C:\\report.txt',
    hasContent: true,
    mimeType: 'text/plain',
    extension: 'txt',
    contentUploadedAt: null,
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    createdAt: '2026-11-03T09:00:00Z',
    updatedAt: '2026-11-03T09:00:00Z',
    revision: 1,
    syncId: null,
    sourceFileState: null,
    tags: [],
    archive: null,
    isArchive: false,
    archiveOrigin: null,
    virtualPath: null,
    isFavorite: false,
    isViewed: false,
    sizeBytes: 100,
  };
}

function page(entryId: string, nextCursor: string | null = null): BrowseDeviceFilesRsp {
  return {
    archiveSource: null,
    entries: [entry(entryId)],
    breadcrumbs: [{ entryId: DIRECTORY_ID, name: 'C:\\', archiveRevision: null }],
    nextCursor,
  };
}

let root: Root;
let container: HTMLDivElement;
let directoryId: string | null;
let favoritesOnly: boolean;
let latest: ReturnType<typeof useDeviceDirectory>;

function Harness() {
  latest = useDeviceDirectory({
    deviceId: DEVICE_ID,
    entryId: directoryId,
    enabled: true,
    roots: [],
    tagFilter: { tagIds: [], tagMatch: 'any', untagged: false },
    favoritesOnly,
  });
  return null;
}

async function render() {
  await act(async () => root.render(<Harness />));
}

beforeEach(() => {
  directoryId = DIRECTORY_ID;
  favoritesOnly = false;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

describe('#3930 directory navigation', () => {
  it('keeps a shared folder request alive after tree cancellation and rechecks access after a denied refresh', async () => {
    let requests!: ReturnType<typeof useDeviceFileBrowseRequests>;
    function SharedHarness() {
      requests = useDeviceFileBrowseRequests('device/session/filters');
      return null;
    }
    await act(async () => root.render(<SharedHarness />));
    const response = Promise.withResolvers<BrowseDeviceFilesRsp>();
    api.browseDeviceFiles.mockReturnValueOnce(response.promise);
    const request = buildBrowseDeviceFilesReq({
      deviceId: DEVICE_ID,
      parentEntryId: DIRECTORY_ID,
      cursor: null,
      tagFilter: { tagIds: [], tagMatch: 'any', untagged: false },
      sortBy: 'name',
      sortDirection: 'ascending',
    });
    const main = requests.read(request, { signal: new AbortController().signal });
    const treeController = new AbortController();
    const tree = requests.read(
      { ...request, sortBy: null, sortDirection: null, includeBreadcrumbs: false },
      { signal: treeController.signal },
    );
    const cancelledTree = expect(tree).rejects.toHaveProperty('name', 'AbortError');
    treeController.abort();
    await cancelledTree;
    expect(api.browseDeviceFiles).toHaveBeenCalledTimes(1);
    expect(api.browseDeviceFiles.mock.calls[0][1].signal.aborted).toBe(false);
    response.resolve(page('visible'));
    await expect(main).resolves.toMatchObject({ entries: [{ entryId: 'visible' }] });

    api.browseDeviceFiles.mockRejectedValueOnce(new HttpRequestError(403, 'revoked'));
    await expect(requests.readFresh(request)).rejects.toHaveProperty('status', 403);
    api.browseDeviceFiles.mockResolvedValueOnce(page('authorized-again'));
    await expect(requests.read(request)).resolves.toMatchObject({
      entries: [{ entryId: 'authorized-again' }],
    });
    expect(api.browseDeviceFiles).toHaveBeenCalledTimes(3);
  });

  it('restores loaded parent pages and continues from their cursor after visiting a child', async () => {
    api.browseDeviceFiles
      .mockResolvedValueOnce(page('first', 'second-page'))
      .mockResolvedValueOnce(page('second', 'third-page'))
      .mockResolvedValueOnce(page('child'))
      .mockResolvedValueOnce(page('third'));
    await render();
    await act(async () => latest.loadMore());

    directoryId = OTHER_DIRECTORY_ID;
    await render();
    directoryId = DIRECTORY_ID;
    await render();
    expect(latest.entries.map((item) => item.entryId)).toEqual(['first', 'second']);
    expect(latest.nextCursor).toBe('third-page');
    expect(api.browseDeviceFiles).toHaveBeenCalledTimes(3);

    await act(async () => latest.loadMore());
    expect(api.browseDeviceFiles.mock.calls[3][0].cursor).toBe('third-page');
    expect(latest.entries.map((item) => item.entryId)).toEqual(['first', 'second', 'third']);
  });

  it('discards saved parent pages when access is revoked in a child', async () => {
    api.browseDeviceFiles
      .mockResolvedValueOnce(page('private-parent'))
      .mockResolvedValueOnce(page('private-child', 'next-page'))
      .mockRejectedValueOnce(new HttpRequestError(403, 'forbidden'))
      .mockRejectedValueOnce(new HttpRequestError(403, 'forbidden'));
    await render();
    directoryId = OTHER_DIRECTORY_ID;
    await render();
    await act(async () => latest.loadMore());
    directoryId = DIRECTORY_ID;
    await render();
    expect(api.browseDeviceFiles).toHaveBeenCalledTimes(4);
    expect(latest.entries).toEqual([]);
    expect(latest.error?.status).toBe(403);
  });

  it('discards saved folders on refresh and on filter changes', async () => {
    api.browseDeviceFiles
      .mockResolvedValueOnce(page('parent'))
      .mockResolvedValueOnce(page('child'))
      .mockResolvedValueOnce(page('refreshed-child'))
      .mockResolvedValueOnce(page('refreshed-parent'))
      .mockResolvedValueOnce(page('favorite'))
      .mockResolvedValueOnce(page('unfiltered'));
    await render();
    directoryId = OTHER_DIRECTORY_ID;
    await render();
    await act(async () => latest.refresh());
    directoryId = DIRECTORY_ID;
    await render();
    expect(latest.entries.map((item) => item.entryId)).toEqual(['refreshed-parent']);
    favoritesOnly = true;
    await render();
    favoritesOnly = false;
    await render();
    expect(latest.entries.map((item) => item.entryId)).toEqual(['unfiltered']);
    expect(api.browseDeviceFiles).toHaveBeenCalledTimes(6);
  });

  it('aborts an old directory request and never displays its late response after navigation', async () => {
    const previous = Promise.withResolvers<BrowseDeviceFilesRsp>();
    api.browseDeviceFiles.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(page('new'));
    await render();
    const previousSignal = api.browseDeviceFiles.mock.calls[0][1].signal as AbortSignal;

    directoryId = OTHER_DIRECTORY_ID;
    await render();
    expect(previousSignal.aborted).toBe(true);
    expect(latest.entries.map((item) => item.entryId)).toEqual(['new']);

    await act(async () => previous.resolve(page('stale', 'stale-cursor')));
    expect(latest.entries.map((item) => item.entryId)).toEqual(['new']);
    expect(latest.nextCursor).toBeNull();
    expect(api.browseDeviceFiles.mock.calls[1][0]).toMatchObject({
      parentEntryId: OTHER_DIRECTORY_ID,
      includeBreadcrumbs: true,
      cursor: null,
    });
  });

  it('resets pagination on filter changes and ignores an in-flight unfiltered page', async () => {
    const previous = Promise.withResolvers<BrowseDeviceFilesRsp>();
    api.browseDeviceFiles
      .mockResolvedValueOnce(page('initial', 'next-page'))
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValueOnce(page('favorite'));
    await render();
    act(() => void latest.loadMore());
    expect(api.browseDeviceFiles.mock.calls[1][0].cursor).toBe('next-page');

    favoritesOnly = true;
    await render();
    expect(api.browseDeviceFiles.mock.calls[2][0]).toMatchObject({
      favoritesOnly: true,
      cursor: null,
    });
    await act(async () => previous.resolve(page('unfiltered', 'old-next')));
    expect(latest.entries.map((item) => item.entryId)).toEqual(['favorite']);
    expect(latest.nextCursor).toBeNull();
  });

  it('clears already loaded files and breadcrumbs when access is revoked during pagination', async () => {
    api.browseDeviceFiles
      .mockResolvedValueOnce(page('private', 'next-page'))
      .mockRejectedValueOnce(new HttpRequestError(403, 'forbidden'));
    await render();
    expect(latest.entries).toHaveLength(1);

    await act(async () => latest.loadMore());
    expect(latest.entries).toEqual([]);
    expect(latest.breadcrumbs).toEqual([]);
    expect(latest.nextCursor).toBeNull();
    expect(latest.error?.status).toBe(403);
    expect(latest.loadingMore).toBe(false);
  });

  it('continues a filtered scan when a server page has no matches but still has a cursor', async () => {
    favoritesOnly = true;
    api.browseDeviceFiles
      .mockResolvedValueOnce({ entries: [], breadcrumbs: [], nextCursor: 'scan-next' })
      .mockResolvedValueOnce(page('favorite'));
    await render();
    expect(latest.entries).toEqual([]);
    expect(latest.nextCursor).toBe('scan-next');

    await act(async () => latest.loadMore());
    expect(api.browseDeviceFiles.mock.calls[1][0]).toMatchObject({
      cursor: 'scan-next',
      favoritesOnly: true,
    });
    expect(latest.entries.map((item) => item.entryId)).toEqual(['favorite']);
  });
});
