/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { headDeviceAudioContent } from '../../../../services/api/device-audio';
import { HttpRequestError } from '../../../../services/api/client';
import { DeviceAudioPlayer } from '../DeviceAudioPlayer';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../../services/api/device-audio', () => ({ headDeviceAudioContent: vi.fn() }));
vi.mock('../../../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => ({ notify }),
}));
class TestPlayer extends HTMLElement {
  audio!: HTMLAudioElement;
  autoplay = true;
  play = vi.fn(async () => {});
  pause = vi.fn(() => this.audio?.pause());
  setSrc = vi.fn((source: string) => {
    this.audio.src = source;
  });
  setSrcImmediate = vi.fn((source: string) => {
    this.audio.src = source;
  });
  retryCurrentSource = vi.fn(() => {
    this.createAudio();
    this.bindAudioEvents();
    this.audio.src = this.getAttribute('src')!;
  });
  createAudio() {
    this.audio = document.createElement('audio');
    this.audio.pause = vi.fn();
    this.audio.load = vi.fn();
  }
  showLoading() {}
  bindAudioEvents() {
    this.audio.addEventListener('canplay', () => {
      if (this.autoplay) void this.play();
    });
  }
  connectedCallback() {
    this.createAudio();
    this.bindAudioEvents();
    this.audio.src = this.getAttribute('src')!;
  }
}
if (!customElements.get('custom-audio-player'))
  customElements.define('custom-audio-player', TestPlayer);
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('localStorage', new Storage());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function player() {
  const value = container.querySelector<TestPlayer>('custom-audio-player');
  expect(value).not.toBeNull();
  return value!;
}
it('inactive_player_cannot_restart_from_late_canplay_or_retry', async () => {
  window.localStorage.setItem('echo-device-audio-device-one', '{"autoplay":true}');
  await act(async () => root.render(<DeviceAudioPlayer deviceId="device" audioId="one" />));
  const old = player();
  const native = old.audio;
  await act(async () => {
    old.audio.dispatchEvent(new Event('waiting'));
  });
  expect(container.textContent).toContain('Очікування аудіо');
  await act(async () => {
    old.audio.dispatchEvent(new Event('canplay'));
  });
  expect(container.textContent).not.toContain('Очікування аудіо');
  const play = old.play;
  const calls = play.mock.calls.length;
  await act(async () =>
    root.render(<DeviceAudioPlayer deviceId="device" audioId="one" active={false} />),
  );
  await act(async () => {
    native.dispatchEvent(new Event('canplay'));
    void old.play();
    old.retryCurrentSource();
    old.setSrc('/obsolete');
    old.setSrcImmediate('/obsolete');
  });
  expect(play.mock.calls.length).toBe(calls);
  expect(native.getAttribute('src')).toBeNull();
  expect(native.pause).toHaveBeenCalled();
  expect(native.load).toHaveBeenCalled();
  expect(window.localStorage.getItem('echo-device-audio-device-one')).toBe('{"autoplay":true}');
});
it('auth_probe_cannot_update_another_audio', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(headDeviceAudioContent).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await act(async () => root.render(<DeviceAudioPlayer deviceId="device" audioId="one" />));
  const old = player();
  await act(async () => {
    old.audio.dispatchEvent(new Event('error'));
  });
  expect(headDeviceAudioContent).toHaveBeenCalledWith(
    'device',
    'one',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  await act(async () => root.render(<DeviceAudioPlayer deviceId="device" audioId="two" />));
  const current = player();
  await act(async () => reject(new HttpRequestError(403, 'obsolete')));
  expect(current.getAttribute('src')).toBe('/api/device/audio/device/two/content');
  expect(container.textContent).not.toContain('недоступне');
  expect(notify).not.toHaveBeenCalled();
  vi.mocked(headDeviceAudioContent).mockRejectedValueOnce(new HttpRequestError(404, 'missing'));
  await act(async () => {
    current.audio.dispatchEvent(new Event('error'));
  });
  expect(container.textContent).toContain('Аудіо недоступне');
  expect(current.audio.getAttribute('src')).toBeNull();
  expect(notify).toHaveBeenCalled();
});

it('retry discards the previous native events and pending access probe', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(headDeviceAudioContent).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await act(async () => root.render(<DeviceAudioPlayer deviceId="device" audioId="one" />));
  const instance = player();
  const play = instance.play;
  const previous = instance.audio;
  await act(async () => previous.dispatchEvent(new Event('error')));
  await act(async () => instance.retryCurrentSource());
  const native = instance.audio;
  const calls = play.mock.calls.length;
  await act(async () => {
    previous.dispatchEvent(new Event('canplay'));
    reject(new HttpRequestError(403, 'previous attempt'));
  });
  expect(play.mock.calls.length).toBe(calls);
  expect(container.textContent).not.toContain('недоступне');
  expect(native.getAttribute('src')).toBe('/api/device/audio/device/one/content');
  await act(async () => root.render(<DeviceAudioPlayer deviceId="device" audioId="one" />));
  expect(player()).toBe(instance);
  expect(player().audio).toBe(native);
});
