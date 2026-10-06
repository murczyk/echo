/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeviceAudio, DeviceAudioDetails, ListDeviceAudioRsp } from '../../../../../Bindings';
import {
  getDeviceAudioDetail,
  listDeviceAudio,
  setDeviceAudioProcessing,
} from '../../../services/api/device-audio';
import { HttpRequestError } from '../../../services/api/client';
import { useDeviceAudio } from '../use-device-audio';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../services/api/device-audio', () => ({
  listDeviceAudio: vi.fn(),
  getDeviceAudioDetail: vi.fn(),
  setDeviceAudioProcessing: vi.fn(),
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => ({ notify }),
}));
let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useDeviceAudio>;
function Harness({
  deviceId = 'first',
  canRead = true,
  syncId = null,
}: {
  deviceId?: string;
  canRead?: boolean;
  syncId?: string | null;
}) {
  state = useDeviceAudio(deviceId, canRead);
  return (
    <div data-sync-id={syncId}>
      {state.error ?? (state.ready && state.rows.length === 0 ? 'empty' : '')}
    </div>
  );
}
const audio = (id: string): DeviceAudio => ({
  id,
  deviceId: 'first',
  recordingStartedAt: '2026-10-03T00:00:00.000001Z',
  recordingEndedAt: '2026-10-03T00:00:01.000001Z',
  durationSeconds: 1,
  processed: false,
  processingVersion: id,
});
const page = (ids: string[], nextCursor: string | null = null): ListDeviceAudioRsp => ({
  audio: ids.map(audio),
  nextCursor,
});
function deferred() {
  let resolve!: (value: ListDeviceAudioRsp) => void;
  let reject!: (value: Error) => void;
  const promise = new Promise<ListDeviceAudioRsp>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it('keeps selection and loaded pages when the same device changes FileSync', async () => {
  vi.mocked(listDeviceAudio)
    .mockResolvedValueOnce(page(['one'], 'tail'))
    .mockResolvedValueOnce(page(['one', 'two']));
  await act(async () => root.render(<Harness />));
  expect(state.rows.map((row) => row.id)).toEqual(['one']);
  await act(async () => {
    state.selectAudio('one');
    await state.loadMore();
  });
  await act(async () => root.render(<Harness syncId="another-session" />));
  expect(state.selectedAudioId).toBe('one');
  expect(state.rows.map((row) => row.id)).toEqual(['one', 'two']);
  expect(vi.mocked(listDeviceAudio).mock.calls.map(([req]) => req)).toEqual([
    { deviceId: 'first', unprocessedOnly: false, limit: 50, cursor: null },
    { deviceId: 'first', unprocessedOnly: false, limit: 50, cursor: 'tail' },
  ]);
});
it('ignores previous device and filter responses including obsolete errors', async () => {
  const old = deferred();
  const filter = deferred();
  vi.mocked(listDeviceAudio)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(page(['current']))
    .mockReturnValueOnce(filter.promise)
    .mockResolvedValueOnce(page(['filtered']));
  await act(async () => root.render(<Harness />));
  const previousSignal = vi.mocked(listDeviceAudio).mock.calls[0][1]?.signal;
  await act(async () => root.render(<Harness deviceId="second" />));
  await act(async () => old.resolve(page(['obsolete'])));
  expect(previousSignal?.aborted).toBe(true);
  expect(state.rows.map((row) => row.id)).toEqual(['current']);
  await act(async () => state.setUnprocessedOnly(true));
  await act(async () => state.setUnprocessedOnly(false));
  await act(async () => filter.reject(new Error('obsolete failure')));
  expect(state.rows.map((row) => row.id)).toEqual(['filtered']);
  expect(state.error).toBeNull();
  expect(notify).not.toHaveBeenCalled();
});
it('keeps first-page and continuation errors visible and retries the failed operation', async () => {
  vi.mocked(listDeviceAudio)
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValueOnce(page(['one'], 'tail'))
    .mockRejectedValueOnce(new Error('tail unavailable'))
    .mockResolvedValueOnce(page(['two']));
  await act(async () => root.render(<Harness />));
  expect(state.ready).toBe(false);
  expect(state.error).toContain('unavailable');
  expect(container.textContent).not.toBe('empty');
  await act(async () => state.reload());
  await act(async () => {
    state.selectAudio('one');
    await state.loadMore();
  });
  expect(state.rows.map((row) => row.id)).toEqual(['one']);
  expect(state.loadMoreError).toContain('tail unavailable');
  expect(state.nextCursor).toBe('tail');
  await act(async () => state.loadMore());
  expect(state.rows.map((row) => row.id)).toEqual(['one', 'two']);
  expect(state.selectedAudioId).toBe('one');
  expect(notify).toHaveBeenCalledTimes(2);
});
it('retains rows and selection when a same-scope refresh fails, and clears access on revoke', async () => {
  vi.mocked(listDeviceAudio)
    .mockResolvedValueOnce(page(['one'], 'tail'))
    .mockRejectedValueOnce(new Error('refresh unavailable'));
  await act(async () => root.render(<Harness />));
  await act(async () => {
    state.selectAudio('one');
    await state.reload();
  });
  expect(state.rows.map((row) => row.id)).toEqual(['one']);
  expect(state.selectedAudioId).toBe('one');
  expect(state.error).toContain('refresh unavailable');
  await act(async () => root.render(<Harness canRead={false} />));
  expect(state.rows).toEqual([]);
  expect(state.selectedAudioId).toBeNull();
  expect(vi.mocked(listDeviceAudio)).toHaveBeenCalledTimes(2);
});
it('failed filter preserves the selected audio and retries the requested filter', async () => {
  const filter = deferred();
  vi.mocked(listDeviceAudio)
    .mockResolvedValueOnce(page(['one'], 'tail'))
    .mockReturnValueOnce(filter.promise)
    .mockResolvedValueOnce(page(['one']));
  await act(async () => root.render(<Harness />));
  await act(async () => state.selectAudio('one'));
  await act(async () => state.setUnprocessedOnly(true));
  expect(state.unprocessedOnly).toBe(false);
  expect(state.selectedAudioId).toBe('one');
  expect(state.rows.map((row) => row.id)).toEqual(['one']);
  await act(async () => filter.reject(new Error('filter unavailable')));
  expect(state.unprocessedOnly).toBe(false);
  expect(state.selectedAudioId).toBe('one');
  expect(state.nextCursor).toBe('tail');
  await act(async () => state.retry());
  expect(vi.mocked(listDeviceAudio).mock.calls.map(([req]) => req.unprocessedOnly)).toEqual([
    false,
    true,
    true,
  ]);
  expect(state.unprocessedOnly).toBe(true);
  expect(state.selectedAudioId).toBe('one');
});
it('external removal retains the bound editor identity without selecting another record', async () => {
  vi.mocked(listDeviceAudio)
    .mockResolvedValueOnce(page(['one', 'two']))
    .mockResolvedValueOnce(page(['two']));
  await act(async () => root.render(<Harness />));
  await act(async () => state.selectAudio('one'));
  await act(async () => state.reload());
  expect(state.selectedAudioId).toBe('one');
  expect(state.rows.map((row) => row.id)).toEqual(['two']);
});

function detail(processed: boolean, version: string): DeviceAudioDetails {
  return {
    audio: { ...audio('one'), processed, processingVersion: version },
    transcription: { text: 'saved text', textVersion: 'text-version' },
    canEdit: true,
  };
}
function statusDeferred() {
  let resolve!: (value: { audioId: string; processed: boolean; processingVersion: string }) => void;
  const promise = new Promise<{ audioId: string; processed: boolean; processingVersion: string }>(
    (done) => {
      resolve = done;
    },
  );
  return { promise, resolve };
}
it('processing conflict retries the same explicit target and suppresses duplicate pending actions', async () => {
  const pending = statusDeferred();
  vi.mocked(listDeviceAudio).mockResolvedValue(page(['one', 'two']));
  vi.mocked(setDeviceAudioProcessing)
    .mockRejectedValueOnce(new HttpRequestError(409, 'changed'))
    .mockRejectedValueOnce(new HttpRequestError(409, 'changed again'))
    .mockReturnValueOnce(pending.promise);
  vi.mocked(getDeviceAudioDetail)
    .mockResolvedValueOnce(detail(false, 'second'))
    .mockResolvedValueOnce(detail(false, 'third'));
  await act(async () => root.render(<Harness />));
  await act(async () => {
    state.selectAudio('one');
    await state.setProcessed('one', true);
  });
  expect(state.processing.one.phase).toBe('conflict');
  expect(state.rows[0].processed).toBe(false);
  await act(async () => state.setProcessed('one', true));
  expect(state.processing.one.phase).toBe('conflict');
  let writing!: Promise<void>;
  await act(async () => {
    writing = state.setProcessed('one', true);
  });
  await act(async () => state.setProcessed('one', false));
  expect(state.processing.one.phase).toBe('pending');
  expect(state.rows[0].processed).toBe(false);
  await act(async () => {
    pending.resolve({ audioId: 'one', processed: true, processingVersion: 'fourth' });
    await writing;
  });
  expect(state.rows[0].processed).toBe(true);
  expect(state.selectedAudioId).toBe('one');
  expect(
    vi
      .mocked(setDeviceAudioProcessing)
      .mock.calls.map(([req]) => [req.processed, req.expectedProcessingVersion]),
  ).toEqual([
    [true, 'one'],
    [true, 'second'],
    [true, 'third'],
  ]);
});
it('unknown processing preserves confirmed rows until reconciliation and never blindly retries', async () => {
  vi.mocked(listDeviceAudio).mockResolvedValue(page(['one']));
  vi.mocked(setDeviceAudioProcessing)
    .mockRejectedValueOnce(new Error('ack lost'))
    .mockResolvedValueOnce({ audioId: 'one', processed: true, processingVersion: 'third' });
  vi.mocked(getDeviceAudioDetail)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(detail(false, 'second'));
  await act(async () => root.render(<Harness />));
  await act(async () => state.setProcessed('one', true));
  expect(state.processing.one.phase).toBe('unknownOutcome');
  expect(state.rows[0].processed).toBe(false);
  await act(async () => state.setProcessed('one', true));
  expect(setDeviceAudioProcessing).toHaveBeenCalledTimes(1);
  await act(async () => state.reconcileProcessing('one'));
  expect(state.processing.one.target).toBe(true);
  expect(state.processing.one.phase).toBe('conflict');
  await act(async () => state.setProcessed('one', true));
  expect(state.rows[0].processed).toBe(true);
  expect(vi.mocked(setDeviceAudioProcessing).mock.calls.map(([req]) => req.processed)).toEqual([
    true,
    true,
  ]);
});
it('old list and status detail cannot revert confirmation while independent text remains readable', async () => {
  const old = deferred();
  vi.mocked(listDeviceAudio)
    .mockResolvedValueOnce(page(['one']))
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({
      audio: [{ ...audio('one'), processed: true, processingVersion: 'new-status' }],
      nextCursor: null,
    });
  vi.mocked(setDeviceAudioProcessing).mockResolvedValue({
    audioId: 'one',
    processed: true,
    processingVersion: 'new-status',
  });
  await act(async () => root.render(<Harness />));
  const epoch = state.processingEpoch();
  let reading!: Promise<void>;
  await act(async () => {
    reading = state.reload();
  });
  await act(async () => state.setProcessed('one', true));
  await act(async () => {
    old.resolve(page(['one']));
    await reading;
  });
  expect(state.rows[0].processed).toBe(true);
  const reread = state.reconcileProcessingDetail(detail(false, 'old-status'), epoch);
  expect(reread.audio.processed).toBe(true);
  expect(reread.audio.processingVersion).toBe('new-status');
  expect(reread.transcription.text).toBe('saved text');
});
it('confirmed processing rejection keeps membership, selection and retry target', async () => {
  vi.mocked(listDeviceAudio).mockResolvedValue(page(['one', 'two'], 'tail'));
  vi.mocked(setDeviceAudioProcessing).mockRejectedValue(new HttpRequestError(403, 'denied'));
  vi.mocked(getDeviceAudioDetail).mockResolvedValue({ ...detail(false, 'one'), canEdit: false });
  await act(async () => root.render(<Harness />));
  await act(async () => {
    state.selectAudio('one');
    await state.setProcessed('one', true);
  });
  expect(state.rows.map((row) => row.id)).toEqual(['one', 'two']);
  expect(state.selectedAudioId).toBe('one');
  expect(state.nextCursor).toBe('tail');
  expect(state.processing.one.phase).toBe('rejected');
  expect(state.processing.one.target).toBe(true);
  expect(state.processing.one.message).toContain('denied');
});

it('confirmed filtered removal restarts traversal, retains bound selection and refresh errors are not empty', async () => {
  const write = statusDeferred();
  vi.mocked(listDeviceAudio)
    .mockResolvedValueOnce(page(['one', 'two'], 'old-tail'))
    .mockResolvedValueOnce(page(['one', 'two'], 'filtered-tail'))
    .mockRejectedValueOnce(new Error('refresh unavailable'))
    .mockResolvedValueOnce(page(['two'], 'new-tail'))
    .mockResolvedValueOnce(page(['three']));
  vi.mocked(setDeviceAudioProcessing).mockReturnValue(write.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => state.setUnprocessedOnly(true));
  await act(async () => state.selectAudio('one'));
  let writing!: Promise<void>;
  await act(async () => {
    writing = state.setProcessed('one', true);
  });
  expect(state.rows.map((row) => row.id)).toEqual(['one', 'two']);
  await act(async () => {
    write.resolve({ audioId: 'one', processed: true, processingVersion: 'new' });
    await writing;
  });
  expect(state.rows.map((row) => row.id)).toEqual(['two']);
  expect(state.selectedAudioId).toBe('one');
  expect(state.unprocessedOnly).toBe(true);
  expect(state.nextCursor).toBeNull();
  expect(state.error).toContain('refresh unavailable');
  await act(async () => state.reload());
  expect(state.nextCursor).toBe('new-tail');
  await act(async () => state.loadMore());
  expect(state.rows.map((row) => row.id)).toEqual(['two', 'three']);
  expect(vi.mocked(listDeviceAudio).mock.calls.map(([req]) => req.cursor)).toEqual([
    null,
    null,
    null,
    null,
    'new-tail',
  ]);
});

it('delayed successful processing acknowledgment cannot roll back a newer authorized read', async () => {
  const write = statusDeferred();
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail(false, 'newer-foreign-version'));
  vi.mocked(listDeviceAudio)
    .mockResolvedValueOnce(page(['one']))
    .mockResolvedValueOnce({
      audio: [{ ...audio('one'), processingVersion: 'newer-foreign-version' }],
      nextCursor: null,
    });
  vi.mocked(setDeviceAudioProcessing).mockReturnValue(write.promise);
  await act(async () => root.render(<Harness />));
  let writing!: Promise<void>;
  await act(async () => {
    writing = state.setProcessed('one', true);
  });
  await act(async () => state.reload());
  await act(async () => {
    write.resolve({ audioId: 'one', processed: true, processingVersion: 'older-own-version' });
    await writing;
  });
  expect(state.rows[0].processed).toBe(false);
  expect(state.rows[0].processingVersion).toBe('newer-foreign-version');
  expect(state.processing.one.phase).toBe('conflict');
  expect(state.processing.one.target).toBe(true);
});

it('same-membership processing ABA retains a selected loaded tail record without restarting first page', async () => {
  const ids = Array.from({ length: 60 }, (_, index) => `record-${index}`);
  vi.mocked(listDeviceAudio)
    .mockResolvedValueOnce(page(ids.slice(0, 50), 'tail'))
    .mockResolvedValueOnce(page(ids.slice(0, 50), 'tail'))
    .mockResolvedValueOnce(page(ids.slice(50)))
    .mockResolvedValueOnce(page(ids.slice(0, 50), 'tail'));
  await act(async () => root.render(<Harness />));
  await act(async () => state.setUnprocessedOnly(true));
  await act(async () => state.loadMore());
  await act(async () => state.selectAudio('record-54'));
  const epoch = state.processingEpoch();
  await act(async () => {
    state.reconcileProcessingDetail(
      {
        ...detail(false, 'ABA-new'),
        audio: { ...audio('record-54'), processingVersion: 'ABA-new' },
      },
      epoch,
    );
  });
  expect(state.rows.some((row) => row.id === 'record-54')).toBe(true);
  expect(state.rows).toHaveLength(60);
  expect(state.selectedAudioId).toBe('record-54');
  expect(state.rows.find((row) => row.id === 'record-54')?.processingVersion).toBe('ABA-new');
});
it('successful authorized unknown reconciliation clears prior playback denial', async () => {
  vi.mocked(listDeviceAudio).mockResolvedValue(page(['one']));
  vi.mocked(setDeviceAudioProcessing).mockRejectedValue(new Error('ack lost'));
  vi.mocked(getDeviceAudioDetail)
    .mockRejectedValueOnce(new HttpRequestError(403, 'revoked'))
    .mockResolvedValueOnce(detail(true, 'current'));
  await act(async () => root.render(<Harness />));
  await act(async () => state.setProcessed('one', true));
  expect(state.processing.one.accessDenied).toBe(true);
  await act(async () => state.reconcileProcessing('one'));
  expect(state.processing.one.accessDenied).toBe(false);
  expect(state.processing.one.canEdit).toBe(true);
  expect(state.rows[0].processed).toBe(true);
});
it('old rejected-status authorization reread cannot overwrite a newer successful action', async () => {
  let resolve!: (value: DeviceAudioDetails) => void;
  const read = new Promise<DeviceAudioDetails>((done) => {
    resolve = done;
  });
  vi.mocked(listDeviceAudio).mockResolvedValue(page(['one']));
  vi.mocked(setDeviceAudioProcessing)
    .mockRejectedValueOnce(new HttpRequestError(403, 'old denial'))
    .mockResolvedValueOnce({ audioId: 'one', processed: true, processingVersion: 'new-status' });
  vi.mocked(getDeviceAudioDetail).mockReturnValue(read);
  await act(async () => root.render(<Harness />));
  let first!: Promise<void>;
  await act(async () => {
    first = state.setProcessed('one', true);
  });
  await act(async () => state.setProcessed('one', true));
  expect(state.rows[0].processed).toBe(true);
  await act(async () => {
    resolve({ ...detail(false, 'one'), canEdit: false });
    await first;
  });
  expect(state.rows[0].processed).toBe(true);
  expect(state.rows[0].processingVersion).toBe('new-status');
  expect(state.processing.one.phase).toBe('ready');
  expect(state.processing.one.canEdit).not.toBe(false);
});
it('409 retry remains blocked until the authorized current-status read completes', async () => {
  let resolve!: (value: DeviceAudioDetails) => void;
  const read = new Promise<DeviceAudioDetails>((done) => {
    resolve = done;
  });
  vi.mocked(listDeviceAudio).mockResolvedValue(page(['one']));
  vi.mocked(setDeviceAudioProcessing)
    .mockRejectedValueOnce(new HttpRequestError(409, 'changed'))
    .mockResolvedValueOnce({ audioId: 'one', processed: true, processingVersion: 'new-status' });
  vi.mocked(getDeviceAudioDetail).mockReturnValue(read);
  await act(async () => root.render(<Harness />));
  let first!: Promise<void>;
  await act(async () => {
    first = state.setProcessed('one', true);
  });
  await act(async () => state.setProcessed('one', true));
  expect(setDeviceAudioProcessing).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve(detail(false, 'current'));
    await first;
  });
  expect(state.processing.one.phase).toBe('conflict');
  await act(async () => state.setProcessed('one', true));
  expect(
    vi.mocked(setDeviceAudioProcessing).mock.calls.map(([req]) => req.expectedProcessingVersion),
  ).toEqual(['one', 'current']);
});

it('another record membership refresh restores the selected tail through the new traversal', async () => {
  const ids = Array.from({ length: 60 }, (_, index) => `record-${index}`);
  const first = {
    audio: [{ ...audio('one'), processed: true }, ...ids.slice(0, 49).map(audio)],
    nextCursor: 'all-tail',
  };
  vi.mocked(listDeviceAudio)
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(page(ids.slice(0, 50), 'tail'))
    .mockResolvedValueOnce(page(ids.slice(50)))
    .mockResolvedValueOnce(page(['one', ...ids.slice(0, 49)], 'new-tail'))
    .mockResolvedValueOnce(page(ids.slice(49)));
  const write = statusDeferred();
  vi.mocked(setDeviceAudioProcessing).mockReturnValue(write.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => state.selectAudio('one'));
  await act(async () => state.setUnprocessedOnly(true));
  await act(async () => state.loadMore());
  let writing!: Promise<void>;
  await act(async () => {
    writing = state.setProcessed('one', false);
  });
  await act(async () => state.selectAudio('record-54'));
  await act(async () => {
    write.resolve({ audioId: 'one', processed: false, processingVersion: 'included' });
    await writing;
  });
  expect(state.rows.some((row) => row.id === 'record-54')).toBe(true);
  expect(state.selectedAudioId).toBe('record-54');
  expect(state.rows).toHaveLength(61);
  expect(new Set(state.rows.map((row) => row.id)).size).toBe(61);
});
it('processing confirmation restarts a pending filter intent with current server state', async () => {
  const write = statusDeferred();
  const old = deferred();
  vi.mocked(listDeviceAudio)
    .mockResolvedValueOnce(page(['one']))
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(page(['two']));
  vi.mocked(setDeviceAudioProcessing).mockReturnValue(write.promise);
  await act(async () => root.render(<Harness />));
  let writing!: Promise<void>;
  await act(async () => {
    writing = state.setProcessed('one', true);
  });
  await act(async () => state.setUnprocessedOnly(true));
  await act(async () => {
    write.resolve({ audioId: 'one', processed: true, processingVersion: 'new' });
    await writing;
  });
  expect(state.unprocessedOnly).toBe(true);
  expect(state.rows.map((row) => row.id)).toEqual(['two']);
  await act(async () => old.resolve(page(['one'])));
  expect(state.rows.map((row) => row.id)).toEqual(['two']);
  expect(vi.mocked(listDeviceAudio).mock.calls.map(([req]) => req.unprocessedOnly)).toEqual([
    false,
    true,
    true,
  ]);
});
it('selection changed during membership refresh is restored through fresh pages', async () => {
  const ids = Array.from({ length: 60 }, (_, index) => `record-${index}`);
  const refresh = deferred();
  const write = statusDeferred();
  vi.mocked(listDeviceAudio)
    .mockResolvedValueOnce({
      audio: [{ ...audio('one'), processed: true }, ...ids.slice(0, 49).map(audio)],
      nextCursor: 'all-tail',
    })
    .mockResolvedValueOnce(page(ids.slice(0, 50), 'tail'))
    .mockResolvedValueOnce(page(ids.slice(50)))
    .mockReturnValueOnce(refresh.promise)
    .mockResolvedValueOnce(page(ids.slice(49)));
  vi.mocked(setDeviceAudioProcessing).mockReturnValue(write.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => state.selectAudio('one'));
  await act(async () => state.setUnprocessedOnly(true));
  await act(async () => state.loadMore());
  let writing!: Promise<void>;
  await act(async () => {
    writing = state.setProcessed('one', false);
  });
  await act(async () => state.selectAudio('record-1'));
  await act(async () => {
    write.resolve({ audioId: 'one', processed: false, processingVersion: 'included' });
    await writing;
  });
  await act(async () => state.selectAudio('record-54'));
  await act(async () => refresh.resolve(page(['one', ...ids.slice(0, 49)], 'new-tail')));
  expect(state.rows.some((row) => row.id === 'record-54')).toBe(true);
  expect(state.selectedAudioId).toBe('record-54');
});
it('opaque version disagreement rereads authority rather than rejecting a newer no-op response', async () => {
  const write = statusDeferred();
  vi.mocked(listDeviceAudio).mockResolvedValue(page(['one']));
  vi.mocked(setDeviceAudioProcessing).mockReturnValue(write.promise);
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail(true, 'latest-noop'));
  await act(async () => root.render(<Harness />));
  let writing!: Promise<void>;
  await act(async () => {
    writing = state.setProcessed('one', true);
  });
  const epoch = state.processingEpoch();
  await act(async () => {
    state.reconcileProcessingDetail(detail(false, 'intermediate-ABA'), epoch);
  });
  await act(async () => {
    write.resolve({ audioId: 'one', processed: true, processingVersion: 'latest-noop' });
    await writing;
  });
  expect(state.rows[0].processed).toBe(true);
  expect(state.rows[0].processingVersion).toBe('latest-noop');
  expect(state.processing.one.phase).toBe('ready');
});
for (const transition of ['device', 'access']) {
  it(`late processing success cannot cross a ${transition} context change`, async () => {
    const write = statusDeferred();
    vi.mocked(listDeviceAudio)
      .mockResolvedValueOnce(page(['one']))
      .mockResolvedValueOnce(page(['another']));
    vi.mocked(setDeviceAudioProcessing).mockReturnValue(write.promise);
    await act(async () => root.render(<Harness />));
    let writing!: Promise<void>;
    await act(async () => {
      writing = state.setProcessed('one', true);
    });
    await act(async () =>
      root.render(
        transition === 'device' ? <Harness deviceId="second" /> : <Harness canRead={false} />,
      ),
    );
    await act(async () => {
      write.resolve({ audioId: 'one', processed: true, processingVersion: 'late' });
      await writing;
    });
    expect(state.rows.map((row) => row.id)).toEqual(transition === 'device' ? ['another'] : []);
    expect(state.processing).toEqual({});
    expect(state.selectedAudioId).toBeNull();
  });
}
it('authorized ordinary detail restores processing permissions after confirmed denial', async () => {
  vi.mocked(listDeviceAudio).mockResolvedValue(page(['one']));
  vi.mocked(setDeviceAudioProcessing).mockRejectedValue(new HttpRequestError(403, 'revoked'));
  vi.mocked(getDeviceAudioDetail).mockRejectedValue(new HttpRequestError(403, 'revoked'));
  await act(async () => root.render(<Harness />));
  await act(async () => state.setProcessed('one', true));
  expect(state.processing.one.accessDenied).toBe(true);
  await act(async () => {
    state.reconcileProcessingDetail(detail(false, 'one'), state.processingEpoch());
  });
  expect(state.processing.one.accessDenied).toBe(false);
  expect(state.processing.one.canEdit).toBe(true);
  expect(state.processing.one.phase).toBe('rejected');
});
it('accepted list summary does not suppress an independent archived permission reread', async () => {
  let resolve!: (value: DeviceAudioDetails) => void;
  const read = new Promise<DeviceAudioDetails>((done) => {
    resolve = done;
  });
  vi.mocked(listDeviceAudio)
    .mockResolvedValueOnce(page(['one']))
    .mockResolvedValueOnce(page(['one']));
  vi.mocked(setDeviceAudioProcessing).mockRejectedValue(new HttpRequestError(403, 'archived'));
  vi.mocked(getDeviceAudioDetail).mockReturnValue(read);
  await act(async () => root.render(<Harness />));
  let writing!: Promise<void>;
  await act(async () => {
    writing = state.setProcessed('one', true);
  });
  await act(async () => state.setUnprocessedOnly(true));
  await act(async () => {
    resolve({ ...detail(false, 'one'), canEdit: false });
    await writing;
  });
  expect(state.processing.one.canEdit).toBe(false);
  expect(state.processing.one.accessDenied).toBe(false);
});
it('old authorized detail cannot restore permission after a newer confirmed denial', async () => {
  vi.mocked(listDeviceAudio).mockResolvedValue(page(['one']));
  vi.mocked(setDeviceAudioProcessing).mockRejectedValue(new HttpRequestError(403, 'revoked'));
  vi.mocked(getDeviceAudioDetail).mockRejectedValue(new HttpRequestError(403, 'revoked'));
  await act(async () => root.render(<Harness />));
  const permissionEpoch = state.beginProcessingPermissionRead('one');
  const epoch = state.processingEpoch();
  await act(async () => state.setProcessed('one', true));
  await act(async () => {
    state.reconcileProcessingDetail(detail(false, 'one'), epoch, permissionEpoch);
  });
  expect(state.processing.one.accessDenied).toBe(true);
  expect(state.processing.one.canEdit).toBe(false);
});
it('old denied permission reread cannot override a newer ordinary authorized detail', async () => {
  let reject!: (error: Error) => void;
  const read = new Promise<DeviceAudioDetails>((_, fail) => {
    reject = fail;
  });
  vi.mocked(listDeviceAudio).mockResolvedValue(page(['one']));
  vi.mocked(setDeviceAudioProcessing).mockRejectedValue(new HttpRequestError(403, 'revoked'));
  vi.mocked(getDeviceAudioDetail).mockReturnValue(read);
  await act(async () => root.render(<Harness />));
  let writing!: Promise<void>;
  await act(async () => {
    writing = state.setProcessed('one', true);
  });
  const permissionEpoch = state.beginProcessingPermissionRead('one');
  await act(async () => {
    state.reconcileProcessingDetail(detail(false, 'one'), state.processingEpoch(), permissionEpoch);
  });
  await act(async () => {
    reject(new HttpRequestError(403, 'older denial'));
    await writing;
  });
  expect(state.processing.one.canEdit).toBe(true);
  expect(state.processing.one.accessDenied).toBe(false);
});
it('parallel manual status rereads share reconciliation and recover denied permissions', async () => {
  let resolveFirst!: (value: DeviceAudioDetails) => void;
  let resolveSecond!: (value: DeviceAudioDetails) => void;
  const first = new Promise<DeviceAudioDetails>((done) => {
    resolveFirst = done;
  });
  const second = new Promise<DeviceAudioDetails>((done) => {
    resolveSecond = done;
  });
  vi.mocked(listDeviceAudio).mockResolvedValue(page(['one']));
  vi.mocked(setDeviceAudioProcessing).mockRejectedValue(new Error('ack lost'));
  vi.mocked(getDeviceAudioDetail)
    .mockRejectedValueOnce(new HttpRequestError(403, 'revoked'))
    .mockReturnValueOnce(first)
    .mockReturnValueOnce(second);
  await act(async () => root.render(<Harness />));
  await act(async () => state.setProcessed('one', true));
  let rereadFirst!: Promise<void>;
  let rereadSecond!: Promise<void>;
  await act(async () => {
    rereadFirst = state.reconcileProcessing('one');
  });
  await act(async () => {
    rereadSecond = state.reconcileProcessing('one');
  });
  await act(async () => {
    resolveFirst(detail(true, 'current'));
    await rereadFirst;
  });
  await act(async () => {
    resolveSecond(detail(true, 'current'));
    await rereadSecond;
  });
  expect(state.processing.one.canEdit).toBe(true);
  expect(state.processing.one.accessDenied).toBe(false);
  expect(getDeviceAudioDetail).toHaveBeenCalledTimes(2);
});
it('another audio confirmation cannot suppress the selected audio current detail', async () => {
  vi.mocked(listDeviceAudio).mockResolvedValue(page(['one', 'two']));
  vi.mocked(setDeviceAudioProcessing).mockResolvedValue({
    audioId: 'two',
    processed: true,
    processingVersion: 'two-current',
  });
  await act(async () => root.render(<Harness />));
  const epoch = state.processingEpoch();
  await act(async () => state.setProcessed('two', true));
  let current!: DeviceAudioDetails;
  await act(async () => {
    current = state.reconcileProcessingDetail(detail(true, 'one-foreign'), epoch);
  });
  expect(current.audio.processed).toBe(true);
  expect(state.rows.find((row) => row.id === 'one')?.processingVersion).toBe('one-foreign');
  expect(state.rows.find((row) => row.id === 'two')?.processingVersion).toBe('two-current');
});
