/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeviceAudioDetails, SaveDeviceAudioTranscriptionRsp } from '../../../../../Bindings';
import {
  getDeviceAudioDetail,
  saveDeviceAudioTranscription,
} from '../../../services/api/device-audio';
import { HttpRequestError } from '../../../services/api/client';
import { useDeviceAudioEditor } from '../use-device-audio-editor';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../services/api/device-audio', () => ({
  getDeviceAudioDetail: vi.fn(),
  saveDeviceAudioTranscription: vi.fn(),
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => ({ notify }),
}));
let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useDeviceAudioEditor>;
function Harness({ id = 'one', canEdit = true }: { id?: string; canEdit?: boolean }) {
  state = useDeviceAudioEditor('device', id, canEdit);
  return (
    <p>
      {state.phase}:{state.draft}
    </p>
  );
}
function detail(text = 'base', version = 'v1', id = 'one'): DeviceAudioDetails {
  return {
    audio: {
      id,
      deviceId: 'device',
      recordingStartedAt: '2026-10-03T00:00:00Z',
      recordingEndedAt: '2026-10-03T00:00:01Z',
      durationSeconds: 1,
      processed: false,
      processingVersion: 'processing',
    },
    transcription: { text, textVersion: version },
    canEdit: true,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function open() {
  await act(async () => root.render(<Harness />));
  expect(state.confirmed?.text).toBe('base');
}
it('newer_draft_survives_older_save_response and serializes writes', async () => {
  const write = deferred<SaveDeviceAudioTranscriptionRsp>();
  vi.mocked(saveDeviceAudioTranscription).mockReturnValue(write.promise);
  await open();
  await act(async () => state.setDraft('submitted'));
  let first!: Promise<boolean>;
  await act(async () => {
    first = state.save();
  });
  expect(state.saving).toBe(true);
  await act(async () => state.setDraft('newer'));
  await act(async () => {
    expect(await state.save()).toBe(false);
  });
  expect(vi.mocked(saveDeviceAudioTranscription).mock.calls.map(([request]) => request)).toEqual([
    { deviceId: 'device', audioId: 'one', text: 'submitted', expectedTextVersion: 'v1' },
  ]);
  await act(async () =>
    write.resolve({ audioId: 'one', transcription: { text: 'submitted', textVersion: 'v2' } }),
  );
  expect(await first).toBe(false);
  expect(state.confirmed).toEqual({ text: 'submitted', textVersion: 'v2' });
  expect(state.draft).toBe('newer');
  expect(state.dirty).toBe(true);
  expect(state.saving).toBe(false);
});
it('unknown_save_reconciles_without_losing_draft or claiming historical failure', async () => {
  const write = deferred<SaveDeviceAudioTranscriptionRsp>();
  vi.mocked(saveDeviceAudioTranscription).mockReturnValue(write.promise);
  await open();
  await act(async () => state.setDraft('committed'));
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = state.save();
  });
  await act(async () => state.setDraft('newer'));
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail('committed', 'v2'));
  await act(async () => write.reject(new HttpRequestError(0, 'lost response')));
  expect(await pending).toBe(false);
  expect(state.confirmed).toEqual({ text: 'committed', textVersion: 'v2' });
  expect(state.draft).toBe('newer');
  expect(state.dirty).toBe(true);
  expect(state.message).toContain('невідом');
  expect(vi.mocked(saveDeviceAudioTranscription)).toHaveBeenCalledTimes(1);
});
it('repeated_conflict_requires_explicit_save with each new current token', async () => {
  vi.mocked(saveDeviceAudioTranscription).mockRejectedValue(new HttpRequestError(409, 'conflict'));
  await open();
  await act(async () => state.setDraft('mine'));
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail('theirs', 'v2'));
  await act(async () => {
    expect(await state.save()).toBe(false);
  });
  expect(state.conflict).toEqual({ text: 'theirs', textVersion: 'v2' });
  expect(state.draft).toBe('mine');
  await act(async () => {
    expect(await state.save()).toBe(false);
  });
  expect(vi.mocked(saveDeviceAudioTranscription)).toHaveBeenCalledTimes(1);
  await act(async () => state.acceptCurrent(false));
  expect(state.confirmed?.textVersion).toBe('v2');
  expect(state.draft).toBe('mine');
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail('new third writer', 'v3'));
  await act(async () => {
    expect(await state.save()).toBe(false);
  });
  expect(state.conflict?.textVersion).toBe('v3');
  expect(vi.mocked(saveDeviceAudioTranscription).mock.calls[1][0].expectedTextVersion).toBe('v2');
});
it('never exposes unknown initial text as empty saved text and preserves draft on archive', async () => {
  vi.mocked(getDeviceAudioDetail).mockRejectedValueOnce(new HttpRequestError(503, 'outage'));
  await act(async () => root.render(<Harness />));
  expect(state.phase).toBe('loadError');
  expect(state.confirmed).toBeNull();
  expect(state.canEdit).toBe(false);
  await act(async () => state.reload());
  await act(async () => state.setDraft(' \n<script>буквально</script>'));
  await act(async () => root.render(<Harness canEdit={false} />));
  expect(state.draft).toBe(' \n<script>буквально</script>');
  expect(state.canEdit).toBe(false);
  await act(async () => {
    expect(await state.save()).toBe(false);
  });
  expect(vi.mocked(saveDeviceAudioTranscription)).not.toHaveBeenCalled();
});
it('discard does not cancel an explicit write and reopening waits for its real outcome', async () => {
  const write = deferred<SaveDeviceAudioTranscriptionRsp>();
  vi.mocked(saveDeviceAudioTranscription).mockReturnValue(write.promise);
  await open();
  await act(async () => state.setDraft('explicit'));
  await act(async () => {
    void state.save();
  });
  await act(async () => state.discard());
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail('other', 'other-version', 'two'));
  await act(async () => root.render(<Harness id="two" />));
  expect(state.draft).toBe('other');
  await act(async () => root.render(<Harness />));
  expect(state.confirmed).toBeNull();
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail('explicit', 'v2'));
  await act(async () =>
    write.resolve({ audioId: 'one', transcription: { text: 'explicit', textVersion: 'v2' } }),
  );
  expect(state.draft).toBe('explicit');
  expect(state.confirmed?.textVersion).toBe('v2');
  expect(vi.mocked(saveDeviceAudioTranscription)).toHaveBeenCalledTimes(1);
});
it('rereading a changed token never silently rebases a dirty draft even when text repeats', async () => {
  await open();
  await act(async () => state.setDraft('own'));
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail('base', 'v3'));
  await act(async () => state.reload());
  expect(state.phase).toBe('conflict');
  expect(state.confirmed?.textVersion).toBe('v1');
  expect(state.draft).toBe('own');
});
it('retrying an unavailable conflict read still requires explicit reconciliation', async () => {
  await open();
  await act(async () => state.setDraft('own'));
  vi.mocked(saveDeviceAudioTranscription).mockRejectedValue(new HttpRequestError(409, 'conflict'));
  vi.mocked(getDeviceAudioDetail).mockRejectedValueOnce(new HttpRequestError(503, 'outage'));
  await act(async () => state.save());
  expect(state.phase).toBe('unknownOutcome');
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail('own', 'v3'));
  await act(async () => state.reload());
  expect(state.phase).toBe('conflict');
  expect(state.confirmed?.textVersion).toBe('v1');
  expect(vi.mocked(saveDeviceAudioTranscription)).toHaveBeenCalledOnce();
});
it('current access rejection retains the draft and signals that native playback must detach', async () => {
  await open();
  await act(async () => state.setDraft('retained'));
  vi.mocked(saveDeviceAudioTranscription).mockRejectedValue(new HttpRequestError(403, 'revoked'));
  vi.mocked(getDeviceAudioDetail).mockRejectedValue(new HttpRequestError(403, 'read revoked'));
  await act(async () => state.save());
  expect(state.draft).toBe('retained');
  expect(state.canEdit).toBe(false);
  expect(state.accessDenied).toBe(true);
});
it('a mutation-only denial rechecks readable archived detail without detaching playback', async () => {
  await open();
  await act(async () => state.setDraft('archived draft'));
  vi.mocked(saveDeviceAudioTranscription).mockRejectedValue(new HttpRequestError(403, 'archived'));
  vi.mocked(getDeviceAudioDetail).mockResolvedValue({ ...detail(), canEdit: false });
  await act(async () => state.save());
  expect(state.accessDenied).toBe(false);
  expect(state.canEdit).toBe(false);
  expect(state.draft).toBe('archived draft');
});
it('an explicitly initiated write completes after unmount without notifying or reconciling another page', async () => {
  const write = deferred<SaveDeviceAudioTranscriptionRsp>();
  vi.mocked(saveDeviceAudioTranscription).mockReturnValue(write.promise);
  await open();
  await act(async () => state.setDraft('submitted'));
  await act(async () => {
    void state.save();
  });
  await act(async () => root.render(null));
  await act(async () => write.reject(new TypeError('lost on an obsolete page')));
  expect(notify).not.toHaveBeenCalled();
  expect(vi.mocked(getDeviceAudioDetail)).toHaveBeenCalledOnce();
});
it('a new editor instance waits for the explicit write from the previous route instance', async () => {
  const write = deferred<SaveDeviceAudioTranscriptionRsp>();
  vi.mocked(saveDeviceAudioTranscription).mockReturnValue(write.promise);
  await open();
  await act(async () => state.setDraft('submitted'));
  await act(async () => {
    void state.save();
  });
  await act(async () => root.render(null));
  await act(async () => root.render(<Harness />));
  expect(state.confirmed).toBeNull();
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail('submitted', 'v2'));
  await act(async () =>
    write.resolve({ audioId: 'one', transcription: { text: 'submitted', textVersion: 'v2' } }),
  );
  expect(state.confirmed?.textVersion).toBe('v2');
  expect(state.draft).toBe('submitted');
});

it('clean authorized reread adopts current text without inventing an unsaved draft', async () => {
  await open();
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail('current external text', 'v2'));
  await act(async () => state.reload());
  expect(state.confirmed?.text).toBe('current external text');
  expect(state.draft).toBe('current external text');
  expect(state.dirty).toBe(false);
});
