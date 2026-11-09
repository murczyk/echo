/** @vitest-environment happy-dom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeviceFileRoot, FileBreadcrumb, LocateDeviceFileRsp } from '../../../../../Bindings';
import { HttpRequestError } from '../../../services/api/client';
import { useLinkedDeviceFile, type DeviceFileSelectionState } from '../use-linked-device-file';

const api = vi.hoisted(() => ({
  locateDeviceFile: vi.fn(),
  revealFile: vi.fn(),
  redirectToLogin: vi.fn(),
}));
vi.mock('../../../services/api/devices', () => ({ locateDeviceFile: api.locateDeviceFile }));
vi.mock('../../../auth-redirect', () => ({ redirectToLogin: api.redirectToLogin }));
const DEVICE = '018f0000-0000-7000-8000-000000000000';
const FILE = '018f0000-0000-7000-8000-000000000001';
const ROOT = '018f0000-0000-7000-8000-000000000002';
const OTHER = '018f0000-0000-7000-8000-000000000003';
const NOW = '2026-11-03T09:00:00Z';
const response = (id = FILE): LocateDeviceFileRsp => ({
  rootEntryId: ROOT,
  currentRevision: 2,
  ancestors: [],
  file: {
    entryId: id,
    fileId: id,
    parentEntryId: ROOT,
    kind: 'file',
    name: 'report.txt',
    pathComponents: ['report.txt'],
    absolutePath: 'C:\\report.txt',
    hasContent: true,
    mimeType: 'text/plain',
    extension: 'txt',
    contentUploadedAt: NOW,
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
    syncId: null,
    sourceFileState: null,
    tags: [],
    archive: null,
  },
});
const roots: DeviceFileRoot[] = [
  {
    entryId: ROOT,
    deviceId: DEVICE,
    parentEntryId: null,
    kind: 'directory',
    name: 'C:\\',
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    contentUploadedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    tags: [],
  },
];
let root: Root;
let container: HTMLDivElement;
let selected: DeviceFileSelectionState;
let error: string | null;
let breadcrumbs: FileBreadcrumb[];
function Harness({
  fileId = FILE,
  rootsLoading = false,
  showRoots = false,
  syncId = null,
}: { fileId?: string; rootsLoading?: boolean; showRoots?: boolean; syncId?: string | null } = {}) {
  const [selection, setSelection] = useState<DeviceFileSelectionState>(null);
  const [path, setPath] = useState<FileBreadcrumb[]>([]);
  selected = selection;
  breadcrumbs = path;
  error = useLinkedDeviceFile({
    deviceId: DEVICE,
    syncId,
    enabled: true,
    linkedFile: { fileId, revision: 1 },
    selection,
    setSelection,
    roots: showRoots ? roots : [],
    rootsLoading,
    revealFile: api.revealFile,
    fileBreadcrumbs: path,
    setFileBreadcrumbs: setPath,
  });
  return null;
}
beforeEach(() => {
  vi.resetAllMocks();
  api.locateDeviceFile.mockResolvedValue(response());
  api.revealFile.mockResolvedValue(false);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('#3930 opens a pinned historical revision with no matching tree roots', async () => {
  await act(async () => root.render(<Harness />));
  expect(selected).toMatchObject({
    deviceId: DEVICE,
    syncId: null,
    revisionPinned: true,
    file: { fileId: FILE, revision: 1, hasContent: true },
  });
  expect(breadcrumbs).toEqual([{ entryId: ROOT, name: 'C:\\', archiveRevision: null }]);
  expect(error).toBeNull();
  expect(api.revealFile).not.toHaveBeenCalled();
  expect(api.locateDeviceFile).toHaveBeenCalledTimes(1);
});

it('#3930 opens while roots are loading, then reveals without fetching the file again', async () => {
  await act(async () => root.render(<Harness rootsLoading showRoots />));
  expect(selected?.file.revision).toBe(1);
  expect(api.revealFile).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness showRoots />));
  expect(api.revealFile).toHaveBeenCalledTimes(1);
  expect(selected?.file.revision).toBe(1);
  expect(error).toBeNull();
  expect(api.locateDeviceFile).toHaveBeenCalledTimes(1);
});

it('#3930 does not wait for or require tree expansion to select the file', async () => {
  let finish!: (value: boolean) => void;
  api.revealFile.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => root.render(<Harness showRoots />));
  expect(selected?.file.fileId).toBe(FILE);
  await act(async () => finish(false));
  expect(selected?.file.fileId).toBe(FILE);
  expect(error).toBeNull();
});

it('#3930 reports an optional tree failure without discarding the authorized preview', async () => {
  api.revealFile.mockRejectedValue(new HttpRequestError(500, 'tree unavailable'));
  await act(async () => root.render(<Harness showRoots />));
  expect(selected?.file.fileId).toBe(FILE);
  expect(error).toContain('Не вдалося показати файл у дереві');
});

for (const status of [401, 403, 404]) {
  it(`#3930 reports locate ${status} even when filters removed every root`, async () => {
    api.locateDeviceFile.mockRejectedValue(new HttpRequestError(status, 'unavailable'));
    await act(async () => root.render(<Harness />));
    expect(selected).toBeNull();
    expect(error).toContain('Не вдалося відкрити файл за посиланням');
    expect(api.revealFile).not.toHaveBeenCalled();
    expect(api.redirectToLogin).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });
}

it('#3930 keeps session membership checks despite an unavailable tree', async () => {
  await act(async () => root.render(<Harness syncId={OTHER} />));
  expect(selected).toBeNull();
  expect(error).toContain('Файл не належить вибраній сесії');
  expect(api.revealFile).not.toHaveBeenCalled();
});

it('#3930 ignores a late locate response after following another file link', async () => {
  let finish!: (value: LocateDeviceFileRsp) => void;
  api.locateDeviceFile
    .mockImplementationOnce(
      () =>
        new Promise<LocateDeviceFileRsp>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(response(OTHER));
  await act(async () => root.render(<Harness />));
  const signal = api.locateDeviceFile.mock.calls[0][1].signal;
  await act(async () => root.render(<Harness fileId={OTHER} />));
  expect(signal.aborted).toBe(true);
  expect(selected?.file.fileId).toBe(OTHER);
  await act(async () => finish(response()));
  expect(selected?.file.fileId).toBe(OTHER);
  expect(error).toBeNull();
});
