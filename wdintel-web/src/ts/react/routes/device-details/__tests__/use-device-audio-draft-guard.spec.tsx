/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDeviceAudioEditor } from '../use-device-audio-editor';
import { useDeviceAudioDraftGuard } from '../use-device-audio-draft-guard';
import { DeviceAudioLeaveDialog } from '../components/DeviceAudioLeaveDialog';
import {
  getDeviceAudioDetail,
  saveDeviceAudioTranscription,
} from '../../../services/api/device-audio';
import {
  prepareForcedNavigation,
  installNavigationGuard,
  requestNavigation,
} from '../../../../browser/navigation-guard';

vi.mock('../../../services/api/device-audio', () => ({
  getDeviceAudioDetail: vi.fn(),
  saveDeviceAudioTranscription: vi.fn(),
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => ({ notify: vi.fn() }),
}));
let root: Root;
let container: HTMLDivElement;
let editor: ReturnType<typeof useDeviceAudioEditor>;
let guard: ReturnType<typeof useDeviceAudioDraftGuard>;
let cleanup: () => void;
function Harness() {
  editor = useDeviceAudioEditor('device', 'one', true);
  guard = useDeviceAudioDraftGuard(editor);
  return <DeviceAudioLeaveDialog guard={guard} editor={editor} />;
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
beforeEach(async () => {
  vi.resetAllMocks();
  window.history.replaceState({}, '', '/device');
  cleanup = installNavigationGuard();
  vi.mocked(getDeviceAudioDetail).mockResolvedValue({
    audio: {
      id: 'one',
      deviceId: 'device',
      name: 'recording.wav',
      recordingStartedAt: '2026-10-03T00:00:00Z',
      recordingEndedAt: '2026-10-03T00:00:01Z',
      durationSeconds: 1,
      processed: false,
      processingVersion: 'p1',
    },
    transcription: { text: 'base', textVersion: 'v1' },
    automaticTranscription: {
      version: 'auto-v1',
      text: 'automatic original',
      state: 'succeeded',
      retryAt: null,
      message: null,
    },
    transcriptionAvailability: {
      deviceEnabled: true,
      globalEnabled: true,
      canEditManual: true,
      canManageSetting: true,
      canRetry: false,
      blockedReason: null,
    },
    canEdit: true,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await act(async () => editor.setDraft('submitted'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  cleanup();
});
it('#3645 saves the retained manual draft from the leave dialog while viewing the automatic original', async () => {
  await act(async () => editor.setAutomaticView(true));
  let navigated = false;
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = guard.requestIntent(() => {
      navigated = true;
    });
  });
  const save = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ).find((button) => button.textContent === 'Зберегти')!;
  expect(save.disabled).toBe(false);
  vi.mocked(saveDeviceAudioTranscription).mockResolvedValueOnce({
    audioId: 'one',
    transcription: { text: 'submitted', textVersion: 'v2' },
  });
  await act(async () => save.click());
  expect(await pending).toBe(true);
  expect(navigated).toBe(true);
  expect(editor.confirmed?.text).toBe('submitted');
  expect(editor.detail?.automaticTranscription.text).toBe('automatic original');
  expect(saveDeviceAudioTranscription).toHaveBeenCalledWith({
    deviceId: 'device',
    audioId: 'one',
    text: 'submitted',
    expectedTextVersion: 'v1',
  });
});
it('save_before_intent_waits_for_current_draft and a newer edit requires another decision', async () => {
  const write = deferred<Awaited<ReturnType<typeof saveDeviceAudioTranscription>>>();
  vi.mocked(saveDeviceAudioTranscription).mockReturnValueOnce(write.promise);
  const intent = vi.fn();
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = guard.requestIntent(intent);
  });
  expect(guard.open).toBe(true);
  expect(intent).not.toHaveBeenCalled();
  await act(async () => {
    void guard.choose('save');
  });
  await act(async () => editor.setDraft('newer'));
  await act(async () =>
    write.resolve({ audioId: 'one', transcription: { text: 'submitted', textVersion: 'v2' } }),
  );
  expect(editor.draft).toBe('newer');
  expect(guard.open).toBe(true);
  expect(intent).not.toHaveBeenCalled();
  vi.mocked(saveDeviceAudioTranscription).mockResolvedValueOnce({
    audioId: 'one',
    transcription: { text: 'newer', textVersion: 'v3' },
  });
  await act(async () => guard.choose('save'));
  expect(await pending).toBe(true);
  expect(intent).toHaveBeenCalledOnce();
});
it('discard_does_not_cancel_explicit_inflight_save', async () => {
  const write = deferred<Awaited<ReturnType<typeof saveDeviceAudioTranscription>>>();
  vi.mocked(saveDeviceAudioTranscription).mockReturnValue(write.promise);
  await act(async () => {
    void editor.save();
  });
  await act(async () => editor.setDraft('newer'));
  const intent = vi.fn();
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = guard.requestIntent(intent);
  });
  await act(async () => guard.choose('discard'));
  expect(await pending).toBe(true);
  expect(intent).toHaveBeenCalledOnce();
  expect(editor.draft).toBe('submitted');
  expect(editor.saving).toBe(true);
  await act(async () =>
    write.resolve({ audioId: 'one', transcription: { text: 'submitted', textVersion: 'v2' } }),
  );
  expect(editor.confirmed?.text).toBe('submitted');
});
it('cancel_preserves_player_and_draft and only one intent can wait', async () => {
  const intent = vi.fn();
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = guard.requestIntent(intent);
  });
  expect(await guard.requestIntent(vi.fn())).toBe(false);
  await act(async () => guard.choose('cancel'));
  expect(await pending).toBe(false);
  expect(editor.draft).toBe('submitted');
  expect(intent).not.toHaveBeenCalled();
});
it('unknown save cannot authorize an exit and forced auth clears beforeunload without waiting', async () => {
  vi.mocked(saveDeviceAudioTranscription).mockRejectedValue(new TypeError('lost response'));
  vi.mocked(getDeviceAudioDetail).mockResolvedValue({
    audio: editor.detail!.audio,
    transcription: { text: 'submitted', textVersion: 'v2' },
    canEdit: true,
  });
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = requestNavigation('/later');
  });
  await act(async () => guard.choose('save'));
  expect(window.location.pathname).toBe('/device');
  expect(guard.open).toBe(true);
  await act(async () => editor.setDraft('keep'));
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  await act(async () => prepareForcedNavigation());
  expect(await pending).toBe(false);
  expect(guard.open).toBe(false);
  const forcedUnload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(forcedUnload);
  expect(forcedUnload.defaultPrevented).toBe(false);
});
