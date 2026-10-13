/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  DeviceAudio,
  DeviceAudioDetails,
  SetDeviceAudioProcessingRsp,
} from '../../../../../Bindings';
import {
  getDeviceAudioDetail,
  listDeviceAudio,
  setDeviceAudioProcessing,
} from '../../../services/api/device-audio';
import { useDeviceAudio } from '../use-device-audio';
import { useDeviceAudioEditor } from '../use-device-audio-editor';

vi.mock('../../../services/api/device-audio', () => ({
  listDeviceAudio: vi.fn(),
  getDeviceAudioDetail: vi.fn(),
  setDeviceAudioProcessing: vi.fn(),
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => ({ notify: vi.fn() }),
}));
let root: Root;
let container: HTMLDivElement;
let audio: ReturnType<typeof useDeviceAudio>;
let editor: ReturnType<typeof useDeviceAudioEditor>;
function Harness() {
  audio = useDeviceAudio('device', true);
  editor = useDeviceAudioEditor('device', audio.selectedAudioId, true, audio);
  return (
    <input
      aria-label="draft"
      value={editor.draft}
      onChange={(event) => editor.setDraft(event.target.value)}
    />
  );
}
const row: DeviceAudio = {
  id: 'one',
  deviceId: 'device',
  name: 'recording.wav',
  recordingStartedAt: '2026-10-03T00:00:00Z',
  recordingEndedAt: '2026-10-03T00:00:01Z',
  durationSeconds: 1,
  processed: false,
  processingVersion: 'status-one',
};
const detail: DeviceAudioDetails = {
  audio: row,
  transcription: { text: 'saved', textVersion: 'text-one' },
  automaticTranscription: {
    version: 'auto-empty',
    text: null,
    state: 'not_requested',
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
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(listDeviceAudio).mockResolvedValue({ audio: [row], nextCursor: null });
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function open() {
  await act(async () => root.render(<Harness />));
  await act(async () => audio.setUnprocessedOnly(true));
  await act(async () => audio.selectAudio('one'));
  expect(editor.confirmed?.text).toBe('saved');
}
it('draft typed during a processing write remains bound after confirmed removal', async () => {
  await open();
  const writing = deferred<SetDeviceAudioProcessingRsp>();
  vi.mocked(setDeviceAudioProcessing).mockReturnValue(writing.promise);
  vi.mocked(listDeviceAudio).mockResolvedValue({ audio: [], nextCursor: null });
  let pending!: Promise<void>;
  await act(async () => {
    pending = audio.setProcessed('one', true);
  });
  await act(async () => editor.setDraft('new draft while waiting'));
  await act(async () => {
    writing.resolve({ audioId: 'one', processed: true, processingVersion: 'status-two' });
    await pending;
  });
  expect(audio.rows).toEqual([]);
  expect(audio.selectedAudioId).toBe('one');
  expect(editor.draft).toBe('new draft while waiting');
  expect(editor.dirty).toBe(true);
  expect(editor.canEdit).toBe(true);
  expect(container.querySelector('input')?.value).toBe('new draft while waiting');
});
it('foreign processing refresh retains the editor and old detail only updates independent text', async () => {
  await open();
  await act(async () => editor.setDraft('retained draft'));
  const reading = deferred<DeviceAudioDetails>();
  vi.mocked(getDeviceAudioDetail).mockReturnValueOnce(reading.promise);
  let pending!: Promise<void>;
  await act(async () => {
    pending = editor.reload();
  });
  vi.mocked(listDeviceAudio).mockResolvedValue({ audio: [], nextCursor: null });
  await act(async () => audio.reload());
  expect(audio.rows).toEqual([]);
  expect(audio.selectedAudioId).toBe('one');
  await act(async () => {
    reading.resolve(detail);
    await pending;
  });
  expect(editor.draft).toBe('retained draft');
  expect(editor.confirmed?.textVersion).toBe('text-one');
  expect(editor.canEdit).toBe(true);
});
