/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceFile, SyncDeviceFilesRsp } from '../../../../../Bindings';
import { useDeviceFilesSync } from '.././use-device-files.sync';
import { HttpRequestError } from '../../../services/api/client';

const apiMock = vi.hoisted(() => ({ syncDeviceFiles: vi.fn() }));
vi.mock('../../../services/api/devices', () => apiMock);

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const FILE_ID = '018f0000-0000-7000-8000-000000000002';
const SYNC_ID = '018f0000-0000-7000-8000-000000000003';
const NOW = '2026-07-24T08:00:00Z';

function buildFile(absolutePath: string): DeviceFile {
  return {
    fileId: FILE_ID,
    deviceId: DEVICE_ID,
    parentEntryId: ROOT_ID,
    rootEntryId: ROOT_ID,
    absolutePath,
    hasContent: false,
    name: absolutePath.split('\\').at(-1) ?? absolutePath,
    pathComponents: [absolutePath],
    mimeType: null,
    extension: null,
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 1,
    syncId: SYNC_ID,
    sourceFileState: null,
    tags: [],
  };
}

function accepted(index: number, absolutePath: string): SyncDeviceFilesRsp['results'][number] {
  return {
    Accepted: {
      index,
      operation: 'created',
      fileId: FILE_ID,
      revision: 1,
      file: buildFile(absolutePath),
    },
  };
}

function syncResponse(results: SyncDeviceFilesRsp['results']): SyncDeviceFilesRsp {
  const acceptedCount = results.filter((result) => 'Accepted' in result).length;
  const rejectedCount = results.length - acceptedCount;
  return {
    sync: {
      syncId: SYNC_ID,
      deviceId: DEVICE_ID,
      mode: 'automatic',
      status: rejectedCount === 0 ? 'completed' : 'completed_with_errors',
      nextBatchIndex: 1,
      counts: {
        received: results.length,
        accepted: acceptedCount,
        created: acceptedCount,
        updated: 0,
        rejected: rejectedCount,
      },
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
      expiresAt: null,
    },
    results,
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

// @test-scope safeguard: prevents accepted file-sync rows from being resubmitted or Windows paths from being changed before persistence.
describe('useDeviceFilesSync', () => {
  it('freezes submit indices and resubmits only rejected rows', async () => {
    apiMock.syncDeviceFiles
      .mockResolvedValueOnce(
        syncResponse([
          accepted(0, 'C:\\accepted.log'),
          {
            Rejected: {
              index: 1,
              code: 'validation',
              message: 'invalid path',
              fieldErrors: [{ path: 'files[1].absolute_path', message: 'invalid path' }],
            },
          },
        ]),
      )
      .mockResolvedValueOnce(syncResponse([accepted(0, 'C:\\corrected.log')]));
    await renderHarness();

    act(() => latest?.openSync());
    const firstRowId = latest!.rows[0].localId;
    act(() => {
      latest?.changeRowField(firstRowId, 'absolutePath', 'C:\\accepted.log');
      latest?.addRow();
    });
    const secondRowId = latest!.rows[1].localId;
    act(() => latest?.changeRowField(secondRowId, 'absolutePath', 'C:\\rejected.log'));

    await act(async () => {
      await latest?.submit();
    });

    expect(
      apiMock.syncDeviceFiles.mock.calls[0][0].files.map(
        (file: { absolutePath: string }) => file.absolutePath,
      ),
    ).toEqual(['C:\\accepted.log', 'C:\\rejected.log']);
    expect(latest!.rows[0].result?.kind).toBe('accepted');
    expect(latest!.rows[1].result?.kind).toBe('rejected');
    expect(latest!.rows[1].fieldErrors.absolutePath).toBe('invalid path');
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(latest!.syncSummary?.counts).toMatchObject({ accepted: 1, rejected: 1 });

    act(() => latest?.changeRowField(secondRowId, 'absolutePath', 'C:\\corrected.log'));
    await act(async () => {
      await latest?.submit();
    });

    expect(apiMock.syncDeviceFiles.mock.calls[1][0].files).toHaveLength(1);
    expect(apiMock.syncDeviceFiles.mock.calls[1][0].files[0].absolutePath).toBe(
      'C:\\corrected.log',
    );
    expect(latest!.rows.every((row) => row.result?.kind === 'accepted')).toBe(true);
    expect(onCommitted).toHaveBeenCalledTimes(2);
  });

  it('submits the exact Windows path without a path-syntax selector', async () => {
    const absolutePath =
      'D:\\Counter-Strike Source v34 HD\\cstrike\\sound\\weapons\\csgo\\c4\\c4_disarm.wav';
    apiMock.syncDeviceFiles.mockResolvedValue(syncResponse([]));
    await renderHarness();
    act(() => latest?.openSync());
    const rowId = latest!.rows[0].localId;
    act(() => {
      latest?.changeRowField(rowId, 'absolutePath', absolutePath);
    });

    await act(async () => {
      await latest?.submit();
    });

    expect(apiMock.syncDeviceFiles).toHaveBeenCalledWith({
      deviceId: DEVICE_ID,
      files: [
        expect.objectContaining({
          absolutePath,
        }),
      ],
    });
  });

  // @test-scope safeguard: prevents duplicate file synchronization and silent row changes while a submitted batch is pending.
  it('blocks duplicate submit and row mutation while a request is in flight', async () => {
    const pending = deferred<SyncDeviceFilesRsp>();
    apiMock.syncDeviceFiles.mockReturnValue(pending.promise);
    await renderHarness();
    act(() => latest?.openSync());
    const rowId = latest!.rows[0].localId;
    act(() => latest?.changeRowField(rowId, 'absolutePath', 'C:\\stable.log'));

    let firstSubmit: Promise<void> | undefined;
    act(() => {
      firstSubmit = latest?.submit();
      void latest?.submit();
      latest?.changeRowField(rowId, 'absolutePath', 'C:\\mutated.log');
      latest?.addRow();
    });

    expect(apiMock.syncDeviceFiles).toHaveBeenCalledTimes(1);
    expect(latest!.rows).toHaveLength(1);
    expect(latest!.rows[0].absolutePath).toBe('C:\\stable.log');

    pending.resolve(syncResponse([accepted(0, 'C:\\stable.log')]));
    await act(async () => {
      await firstSubmit;
    });
  });

  // @test-scope safeguard: prevents automatic retries from duplicating a file synchronization whose server outcome is unknown.
  it('does not retry an uncertain transport failure automatically', async () => {
    apiMock.syncDeviceFiles.mockRejectedValue(new HttpRequestError(0, 'network down'));
    await renderHarness();
    act(() => latest?.openSync());
    const rowId = latest!.rows[0].localId;
    act(() => latest?.changeRowField(rowId, 'absolutePath', 'C:\\uncertain.log'));

    await act(async () => {
      await latest?.submit();
      await Promise.resolve();
    });

    expect(apiMock.syncDeviceFiles).toHaveBeenCalledTimes(1);
    expect(latest!.transportUncertain).toBe(true);
    expect(latest!.batchError).toContain('Результат запиту невідомий');
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  // @test-scope safeguard: prevents edits or synchronization after the operator loses the device file-sync capability.
  it('blocks mutations after sync capability is revoked', async () => {
    await renderHarness();
    act(() => latest?.openSync());
    const rowId = latest!.rows[0].localId;
    act(() => latest?.changeRowField(rowId, 'absolutePath', 'C:\\before-revoke.log'));

    canSync = false;
    await renderHarness();
    act(() => {
      latest?.changeRowField(rowId, 'absolutePath', 'C:\\after-revoke.log');
      void latest?.submit();
    });

    expect(latest!.rows[0].absolutePath).toBe('C:\\before-revoke.log');
    expect(latest!.open).toBe(false);
    expect(apiMock.syncDeviceFiles).not.toHaveBeenCalled();
  });
});
