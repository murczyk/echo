/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpRequestError } from '../../services/api/client';
import { useDeviceFileCounts } from './use-device-file-counts';

const apiMock = vi.hoisted(() => ({
  countDeviceFileSubtrees: vi.fn(),
}));

vi.mock('../../services/api/devices', () => apiMock);

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const DIRECTORY_ID = '018f0000-0000-7000-8000-000000000002';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: ReturnType<typeof useDeviceFileCounts> | null = null;

function Harness() {
  latest = useDeviceFileCounts({ deviceId: DEVICE_ID, enabled: true });
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness />);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
  vi.clearAllMocks();
});

describe('useDeviceFileCounts', () => {
  it('serializes count batches and merges results by directory ID', async () => {
    const rootCounts = deferred<{ counts: { entryId: string; fileCount: number }[] }>();
    const directoryCounts = deferred<{ counts: { entryId: string; fileCount: number }[] }>();
    apiMock.countDeviceFileSubtrees
      .mockReturnValueOnce(rootCounts.promise)
      .mockReturnValueOnce(directoryCounts.promise);

    act(() => {
      latest?.enqueue({ parentEntryId: null, directoryEntryIds: [ROOT_ID] });
      latest?.enqueue({ parentEntryId: ROOT_ID, directoryEntryIds: [DIRECTORY_ID] });
    });
    await flush();

    expect(apiMock.countDeviceFileSubtrees).toHaveBeenCalledTimes(1);
    expect(latest?.loading).toBe(true);

    rootCounts.resolve({ counts: [{ entryId: ROOT_ID, fileCount: 12_345 }] });
    await flush();
    expect(apiMock.countDeviceFileSubtrees).toHaveBeenCalledTimes(2);

    directoryCounts.resolve({ counts: [{ entryId: DIRECTORY_ID, fileCount: 7 }] });
    await flush();

    expect(latest?.countsByEntryId).toEqual({ [ROOT_ID]: 12_345, [DIRECTORY_ID]: 7 });
    expect(latest?.loading).toBe(false);
  });

  it('keeps failed counts retryable without discarding successful tree state', async () => {
    apiMock.countDeviceFileSubtrees.mockRejectedValueOnce(
      new HttpRequestError(500, 'count failed'),
    );

    act(() => latest?.enqueue({ parentEntryId: null, directoryEntryIds: [ROOT_ID] }));
    await flush();

    expect(latest?.error?.status).toBe(500);
    expect(latest?.loading).toBe(false);

    apiMock.countDeviceFileSubtrees.mockResolvedValueOnce({
      counts: [{ entryId: ROOT_ID, fileCount: 3 }],
    });
    act(() => latest?.retry());
    await flush();

    expect(apiMock.countDeviceFileSubtrees).toHaveBeenCalledTimes(2);
    expect(latest?.countsByEntryId).toEqual({ [ROOT_ID]: 3 });
    expect(latest?.error).toBeNull();
  });
});
