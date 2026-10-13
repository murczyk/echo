/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  DeviceAudioTranscriptionStatusRsp,
  DeviceAudioDetails,
} from '../../../../../Bindings';
import { HttpRequestError } from '../../../services/api/client';
import { useDeviceAudioEditor } from '../use-device-audio-editor';
import { useDeviceAudioTranscription } from '../use-device-audio-transcription';

const api = vi.hoisted(() => ({
  status: vi.fn(),
  retry: vi.fn(),
  notify: vi.fn(),
  detail: vi.fn(),
  save: vi.fn(),
}));
vi.mock('../../../services/api/device-audio', () => ({
  getDeviceAudioDetail: api.detail,
  saveDeviceAudioTranscription: api.save,
  getDeviceAudioTranscriptionStatus: api.status,
  retryDeviceAudioTranscription: api.retry,
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => ({ notify: api.notify }),
}));
let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useDeviceAudioTranscription>;
const merge = vi.fn();
function Harness({ id = 'one', active = true, ready = true } = {}) {
  state = useDeviceAudioTranscription('device', id, active, ready, merge);
  return null;
}
function response(
  state: NonNullable<DeviceAudioTranscriptionStatusRsp['snapshot']>['state'] = 'queued',
): DeviceAudioTranscriptionStatusRsp {
  return {
    snapshot: {
      version: state,
      text: state === 'succeeded' ? 'auto' : null,
      state,
      retryAt: null,
      message: null,
    },
    availability: {
      deviceEnabled: true,
      globalEnabled: true,
      canEditManual: true,
      canManageSetting: true,
      canRetry: state === 'failed',
      blockedReason: null,
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  api.status.mockResolvedValue(response());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it('retains the first status while details load and refreshes after cached preparation', async () => {
  api.status.mockResolvedValueOnce(response('succeeded'));
  await act(async () => root.render(<Harness ready={false} />));
  expect(merge).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness />));
  expect(merge).toHaveBeenCalledWith(response('succeeded').snapshot, response().availability);
  await act(async () => state.refresh());
  expect(api.status).toHaveBeenLastCalledWith(
    { deviceId: 'device', audioId: 'one', knownVersion: 'succeeded' },
    expect.anything(),
  );
});

it.each([
  'not_requested',
  'succeeded',
  'no_speech',
  'failed',
  'outcome_unknown',
  'cancelled',
] as const)(
  'keeps polling %s at one second and merges unchanged-version capabilities',
  async (terminal) => {
    const first = response(terminal);
    api.status.mockResolvedValueOnce(first).mockResolvedValue({
      snapshot: null,
      availability: { ...first.availability, deviceEnabled: false },
    });
    await act(async () => root.render(<Harness />));
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(api.status).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(state.availability?.deviceEnabled).toBe(false);
    expect(merge).toHaveBeenLastCalledWith(
      first.snapshot,
      expect.objectContaining({ deviceEnabled: false }),
    );
  },
);

it('coalesces refresh during a slow poll and drops stale replies on selection/context change', async () => {
  const slow = deferred<DeviceAudioTranscriptionStatusRsp>();
  api.status.mockReturnValueOnce(slow.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => {
    state.refresh();
    state.refresh();
  });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(api.status).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<Harness id="two" />));
  expect(api.status).toHaveBeenCalledTimes(2);
  merge.mockClear();
  await act(async () => slow.resolve(response('succeeded')));
  expect(merge).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness id="two" active={false} />));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api.status).toHaveBeenCalledTimes(2);
});

it.each([401, 403, 404])('stops on denied status %s', async (code) => {
  api.status.mockRejectedValue(new HttpRequestError(code, 'denied'));
  await act(async () => root.render(<Harness />));
  expect(state.accessDenied).toBe(true);
  await act(async () => {
    state.refresh();
  });
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(api.status).toHaveBeenCalledTimes(1);
  expect(api.notify).toHaveBeenCalledTimes(1);
});

it('deduplicates transient-error toasts, backs off and resumes one-second polling', async () => {
  api.status
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(response());
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(api.status).toHaveBeenCalledTimes(2);
  expect(api.notify).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(api.status).toHaveBeenCalledTimes(3);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(api.status).toHaveBeenCalledTimes(4);
});

it('deduplicates explicit retry and refreshes after a conflict without retrying inference', async () => {
  api.status.mockResolvedValue(response('failed'));
  const retry = deferred<never>();
  api.retry.mockReturnValue(retry.promise);
  await act(async () => root.render(<Harness />));
  await act(async () => {
    void state.retry();
    void state.retry();
  });
  expect(api.retry).toHaveBeenCalledTimes(1);
  expect(state.retrying).toBe(true);
  api.status.mockResolvedValue(response('outcome_unknown'));
  await act(async () => retry.reject(new HttpRequestError(409, 'recovery_required')));
  expect(state.snapshot?.state).toBe('outcome_unknown');
  expect(state.retrying).toBe(false);
  expect(api.status).toHaveBeenCalledTimes(2);
  await act(async () => state.retry());
  expect(api.retry).toHaveBeenCalledTimes(1);
});

it('runs one immediate refresh after a slow poll and observes another session retry', async () => {
  const slow = deferred<DeviceAudioTranscriptionStatusRsp>();
  api.status
    .mockReturnValueOnce(slow.promise)
    .mockResolvedValueOnce(response('queued'))
    .mockResolvedValue(response('succeeded'));
  await act(async () => root.render(<Harness />));
  await act(async () => {
    state.refresh();
    state.refresh();
  });
  await act(async () => slow.resolve(response('failed')));
  expect(api.status).toHaveBeenCalledTimes(2);
  expect(state.snapshot?.state).toBe('queued');
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(state.snapshot?.text).toBe('auto');
  expect(api.retry).not.toHaveBeenCalled();
});

it('restores cached automatic text after a delayed conflict detail without changing draft or manual CAS', async () => {
  let editor!: ReturnType<typeof useDeviceAudioEditor>;
  const initial: DeviceAudioDetails = {
    audio: {
      id: 'one',
      deviceId: 'device',
      name: 'one.wav',
      recordingStartedAt: '',
      recordingEndedAt: '',
      durationSeconds: 1,
      processed: false,
      processingVersion: 'processing',
    },
    transcription: { text: 'base', textVersion: 'manual-v1' },
    automaticTranscription: response().snapshot!,
    transcriptionAvailability: response().availability,
    canEdit: true,
  };
  api.detail.mockResolvedValue(initial);
  function EditorHarness() {
    editor = useDeviceAudioEditor('device', 'one', true);
    state = useDeviceAudioTranscription(
      'device',
      'one',
      true,
      editor.confirmed !== null,
      editor.mergeAutomatic,
    );
    return null;
  }
  await act(async () => root.render(<EditorHarness />));
  await act(async () => editor.setDraft('my draft'));
  const reread = deferred<DeviceAudioDetails>();
  api.detail.mockReturnValue(reread.promise);
  api.save.mockRejectedValue(new HttpRequestError(409, 'conflict'));
  await act(async () => {
    void editor.save();
  });
  expect(api.detail).toHaveBeenCalledTimes(2);
  api.status
    .mockResolvedValueOnce(response('succeeded'))
    .mockResolvedValue({ snapshot: null, availability: response().availability });
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(editor.detail?.automaticTranscription.text).toBe('auto');
  await act(async () =>
    reread.resolve({ ...initial, transcription: { text: 'theirs', textVersion: 'manual-v2' } }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(editor.detail?.automaticTranscription.text).toBe('auto');
  expect(editor.draft).toBe('my draft');
  expect(editor.conflict).toEqual({ text: 'theirs', textVersion: 'manual-v2' });
  expect(editor.confirmed).toEqual(initial.transcription);
});

it('reports access denial even after a deduplicated transient outage and stops polling', async () => {
  api.status
    .mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValue(new HttpRequestError(403, 'access revoked'));
  await act(async () => root.render(<Harness />));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(state.accessDenied).toBe(true);
  expect(api.notify).toHaveBeenCalledTimes(2);
  expect(api.notify).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: expect.stringContaining('access revoked') }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api.status).toHaveBeenCalledTimes(2);
});
