/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { DeviceFileSelection } from '../device-file-archive';
import { useDeviceFileMarkers } from '../use-device-file-markers';
import { markDeviceFileViewed, markDeviceFileUnviewed } from '../../../services/api/devices';

vi.mock('../../../services/api/devices', () => ({
  markDeviceFileViewed: vi.fn(),
  markDeviceFileUnviewed: vi.fn(),
  setDeviceFileFavorite: vi.fn(),
}));

it('#3930 preserves viewed writes during rapid file navigation and cancels them on device change', async () => {
  const requests: { signal: AbortSignal; resolve: (value: unknown) => void }[] = [];
  vi.mocked(markDeviceFileViewed).mockImplementation(
    (_req, options) =>
      new Promise((resolve) => {
        requests.push({ signal: options!.signal!, resolve });
      }),
  );
  const file = {
    entryId: 'file-a',
    fileId: 'file-a',
    revision: 1,
    hasContent: true,
    isViewed: false,
  } as DeviceFileSelection;
  const container = document.createElement('div');
  const root = createRoot(container);
  let state: ReturnType<typeof useDeviceFileMarkers>;
  function Harness({ device, file }: { device: string; file: DeviceFileSelection | null }) {
    state = useDeviceFileMarkers(device, file);
    return null;
  }
  try {
    await act(async () => root.render(<Harness device="a" file={file} />));
    await act(async () =>
      root.render(<Harness device="a" file={{ ...file, entryId: 'file-b', fileId: 'file-b' }} />),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0].signal.aborted).toBe(false);
    await act(async () => requests[0].resolve({ isViewed: true, isFavorite: false }));
    expect(state!.withMarkers(file).isViewed).toBe(true);
    await act(async () => root.render(<Harness device="b" file={null} />));
    expect(requests[1].signal.aborted).toBe(true);
    await act(async () => requests[1].resolve({ isViewed: true, isFavorite: false }));
    expect(state!.withMarkers({ ...file, entryId: 'file-b', fileId: 'file-b' }).isViewed).toBe(
      false,
    );
  } finally {
    act(() => root.unmount());
    vi.clearAllMocks();
  }
});

it('#3930 serializes manual viewed changes and retains the previous marker after a failed write', async () => {
  const request = Promise.withResolvers<{ isViewed: boolean; isFavorite: boolean }>();
  vi.mocked(markDeviceFileUnviewed)
    .mockReturnValueOnce(request.promise)
    .mockResolvedValueOnce({ isViewed: false, isFavorite: false });
  vi.mocked(markDeviceFileViewed).mockResolvedValue({ isViewed: true, isFavorite: false });
  const file = {
    entryId: 'file',
    fileId: 'file',
    revision: 1,
    isViewed: true,
    hasContent: true,
  } as DeviceFileSelection;
  const container = document.createElement('div');
  const root = createRoot(container);
  let state: ReturnType<typeof useDeviceFileMarkers>;
  let selectedFile: DeviceFileSelection | null = null;
  function Harness() {
    state = useDeviceFileMarkers('device', selectedFile);
    return null;
  }
  try {
    await act(async () => root.render(<Harness />));
    act(() => {
      void state!.toggleViewed(file);
      void state!.toggleViewed(file);
    });
    expect(markDeviceFileUnviewed).toHaveBeenCalledTimes(1);
    expect(state!.viewedPending.has('file/1')).toBe(true);
    await act(async () => request.reject(new Error('Saving failed')));
    expect(state!.withMarkers(file).isViewed).toBe(true);
    expect(state!.viewedPending.size).toBe(0);
    expect(state!.error).toContain('Saving failed');
    await act(async () => state!.toggleViewed(file));
    expect(state!.withMarkers(file).isViewed).toBe(false);
    await act(async () => state!.toggleViewed(file));
    expect(markDeviceFileViewed).toHaveBeenCalledTimes(1);
    expect(state!.withMarkers(file).isViewed).toBe(true);
    const unread = Promise.withResolvers<{ isViewed: boolean; isFavorite: boolean }>();
    vi.mocked(markDeviceFileUnviewed).mockReturnValueOnce(unread.promise);
    act(() => void state!.toggleViewed(file));
    selectedFile = file;
    await act(async () => root.render(<Harness />));
    await act(async () => unread.resolve({ isViewed: false, isFavorite: false }));
    expect(markDeviceFileViewed).toHaveBeenCalledTimes(2);
    expect(state!.withMarkers(file).isViewed).toBe(true);
  } finally {
    act(() => root.unmount());
    vi.clearAllMocks();
  }
});
