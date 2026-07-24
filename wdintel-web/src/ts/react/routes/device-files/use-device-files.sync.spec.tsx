/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceFile, DeviceFileRoot, SyncDeviceFilesRsp } from '../../../../Bindings';
import { useDeviceFilesSync } from './use-device-files.sync';
import { HttpRequestError } from '../../services/api/client';

const apiMock = vi.hoisted(() => ({ syncDeviceFiles: vi.fn() }));
vi.mock('../../services/api/devices', () => apiMock);

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const FILE_ID = '018f0000-0000-7000-8000-000000000002';
const NOW = '2026-07-24T08:00:00Z';

function buildRoot(): DeviceFileRoot {
  return {
    entryId: ROOT_ID,
    deviceId: DEVICE_ID,
    parentEntryId: null,
    kind: 'directory',
    name: '/',
    pathSyntax: 'posix',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function buildFile(absolutePath: string): DeviceFile {
  return {
    fileId: FILE_ID,
    deviceId: DEVICE_ID,
    parentEntryId: ROOT_ID,
    rootEntryId: ROOT_ID,
    pathSyntax: 'posix',
    absolutePath,
    name: absolutePath.split('/').at(-1) ?? absolutePath,
    pathComponents: [absolutePath],
    mimeType: null,
    extension: null,
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function accepted(index: number, absolutePath: string): SyncDeviceFilesRsp['results'][number] {
  return {
    Accepted: {
      index,
      operation: 'created',
      root: buildRoot(),
      file: buildFile(absolutePath),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: ReturnType<typeof useDeviceFilesSync> | null = null;
let canSync = true;
const onCommitted = vi.fn(async () => undefined);

function Harness() {
  latest = useDeviceFilesSync({ deviceId: DEVICE_ID, canSync, onCommitted });
  return null;
}

async function renderHarness() {
  await act(async () => {
    root?.render(<Harness />);
  });
}

beforeEach(() => {
  canSync = true;
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

describe('useDeviceFilesSync', () => {
  it('freezes submit indices and resubmits only rejected rows', async () => {
    apiMock.syncDeviceFiles
      .mockResolvedValueOnce({
        results: [
          accepted(0, '/accepted.log'),
          {
            Rejected: {
              index: 1,
              error: {
                kind: 'validation',
                message: 'invalid path',
                fieldErrors: [['files[1].absolute_path', 'invalid path']],
              },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ results: [accepted(0, '/corrected.log')] });
    await renderHarness();

    act(() => latest?.openSync());
    const firstRowId = latest!.rows[0].localId;
    act(() => {
      latest?.changeRowField(firstRowId, 'absolutePath', '/accepted.log');
      latest?.addRow();
    });
    const secondRowId = latest!.rows[1].localId;
    act(() => latest?.changeRowField(secondRowId, 'absolutePath', '/rejected.log'));

    await act(async () => {
      await latest?.submit();
    });

    expect(
      apiMock.syncDeviceFiles.mock.calls[0][0].files.map(
        (file: { absolutePath: string }) => file.absolutePath,
      ),
    ).toEqual(['/accepted.log', '/rejected.log']);
    expect(latest!.rows[0].result?.kind).toBe('accepted');
    expect(latest!.rows[1].result?.kind).toBe('rejected');
    expect(latest!.rows[1].fieldErrors.absolutePath).toBe('invalid path');
    expect(onCommitted).toHaveBeenCalledTimes(1);

    act(() => latest?.changeRowField(secondRowId, 'absolutePath', '/corrected.log'));
    await act(async () => {
      await latest?.submit();
    });

    expect(apiMock.syncDeviceFiles.mock.calls[1][0].files).toHaveLength(1);
    expect(apiMock.syncDeviceFiles.mock.calls[1][0].files[0].absolutePath).toBe('/corrected.log');
    expect(latest!.rows.every((row) => row.result?.kind === 'accepted')).toBe(true);
    expect(onCommitted).toHaveBeenCalledTimes(2);
  });

  it('submits the selected Windows syntax with the exact path', async () => {
    const absolutePath =
      'D:\\Counter-Strike Source v34 HD\\cstrike\\sound\\weapons\\csgo\\c4\\c4_disarm.wav';
    apiMock.syncDeviceFiles.mockResolvedValue({ results: [] });
    await renderHarness();
    act(() => latest?.openSync());
    const rowId = latest!.rows[0].localId;
    act(() => {
      latest?.setPathSyntax('windows');
      latest?.changeRowField(rowId, 'absolutePath', absolutePath);
    });

    await act(async () => {
      await latest?.submit();
    });

    expect(apiMock.syncDeviceFiles).toHaveBeenCalledWith({
      deviceId: DEVICE_ID,
      pathSyntax: 'windows',
      files: [
        expect.objectContaining({
          absolutePath,
        }),
      ],
    });
  });

  it('blocks duplicate submit and row mutation while a request is in flight', async () => {
    const pending = deferred<SyncDeviceFilesRsp>();
    apiMock.syncDeviceFiles.mockReturnValue(pending.promise);
    await renderHarness();
    act(() => latest?.openSync());
    const rowId = latest!.rows[0].localId;
    act(() => latest?.changeRowField(rowId, 'absolutePath', '/stable.log'));

    let firstSubmit: Promise<void> | undefined;
    act(() => {
      firstSubmit = latest?.submit();
      void latest?.submit();
      latest?.changeRowField(rowId, 'absolutePath', '/mutated.log');
      latest?.addRow();
    });

    expect(apiMock.syncDeviceFiles).toHaveBeenCalledTimes(1);
    expect(latest!.rows).toHaveLength(1);
    expect(latest!.rows[0].absolutePath).toBe('/stable.log');

    pending.resolve({ results: [accepted(0, '/stable.log')] });
    await act(async () => {
      await firstSubmit;
    });
  });

  it('does not retry an uncertain transport failure automatically', async () => {
    apiMock.syncDeviceFiles.mockRejectedValue(new HttpRequestError(0, 'network down'));
    await renderHarness();
    act(() => latest?.openSync());
    const rowId = latest!.rows[0].localId;
    act(() => latest?.changeRowField(rowId, 'absolutePath', '/uncertain.log'));

    await act(async () => {
      await latest?.submit();
      await Promise.resolve();
    });

    expect(apiMock.syncDeviceFiles).toHaveBeenCalledTimes(1);
    expect(latest!.transportUncertain).toBe(true);
    expect(latest!.batchError).toContain('Результат запиту невідомий');
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it('blocks mutations after sync capability is revoked', async () => {
    await renderHarness();
    act(() => latest?.openSync());
    const rowId = latest!.rows[0].localId;
    act(() => latest?.changeRowField(rowId, 'absolutePath', '/before-revoke.log'));

    canSync = false;
    await renderHarness();
    act(() => {
      latest?.changeRowField(rowId, 'absolutePath', '/after-revoke.log');
      void latest?.submit();
    });

    expect(latest!.rows[0].absolutePath).toBe('/before-revoke.log');
    expect(latest!.open).toBe(false);
    expect(apiMock.syncDeviceFiles).not.toHaveBeenCalled();
  });
});
