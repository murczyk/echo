/** @vitest-environment happy-dom */
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FilePreviewLifecycleProps } from '../../../shared/message-card/attachment-preview/file-preview-source';
import type { DeviceFilePreviewSource } from '../../use-device-file-preview';
import { DeviceFileMediaPreview } from '../DeviceFileMediaPreview';

const source: DeviceFilePreviewSource = {
  key: 'device/file/1',
  deviceId: 'device',
  fileId: 'file',
  revision: 1,
  fileName: 'video.mp4',
  extension: 'mp4',
  contentType: 'video/mp4',
  sizeBytes: 3,
  originalHref: '/api/device/files/device/file/revisions/1/content',
};
const fetchMock = vi.fn<typeof fetch>();
let root: Root;
let container: HTMLDivElement;
let controller: AbortController;
let cleanups: Set<() => void>;
let lifecycle: FilePreviewLifecycleProps;
const onError = vi.fn();
const checkAccess = vi.fn<() => Promise<boolean>>();
const retry = vi.fn();
const onDurationChange = vi.fn();
function response() {
  return new Response(new Uint8Array([7]), {
    status: 206,
    headers: { 'content-range': 'bytes 0-0/3', 'content-length': '1' },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function render(selected = source, kind: 'audio' | 'video' = 'video') {
  await act(async () =>
    root.render(
      <DeviceFileMediaPreview
        source={selected}
        kind={kind}
        lifecycle={lifecycle}
        checkAccess={checkAccess}
        onRetry={retry}
        onDurationChange={onDurationChange}
      />,
    ),
  );
}
beforeEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  controller = new AbortController();
  cleanups = new Set();
  lifecycle = {
    signal: controller.signal,
    onError,
    isCurrent: () => !controller.signal.aborted,
    registerCleanup: (cleanup) => {
      cleanups.add(cleanup);
      return () => {
        cleanups.delete(cleanup);
      };
    },
  };
  checkAccess.mockResolvedValue(true);
  fetchMock.mockResolvedValue(response());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('assigns only an exact one-byte checked Range URL to native video', async () => {
  const gate = deferred<Response>();
  fetchMock.mockReturnValueOnce(gate.promise);
  await render();
  expect(container.querySelector('video')).toBeNull();
  await act(async () => gate.resolve(response()));
  const video = container.querySelector('video')!;
  expect(video.getAttribute('src')).toBe('/api/device/files/device/file/revisions/1/preview/media');
  expect(video.controls).toBe(false);
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/preview/media'),
    expect.objectContaining({ headers: expect.objectContaining({ Range: 'bytes=0-0' }) }),
  );
});
it('rejects a non-Range preflight without starting playback', async () => {
  fetchMock.mockResolvedValue(new Response(new Uint8Array([7]), { status: 200 }));
  await render();
  expect(container.querySelector('video')).toBeNull();
  expect(container.textContent).toContain('Сервер не підтвердив доступ');
});
it('zero bytes remain empty and never start preflight or native playback', async () => {
  await render({ ...source, sizeBytes: 0 });
  expect(container.textContent).toContain('Файл порожній');
  expect(container.querySelector('video,custom-audio-player')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
it('rechecks access after opaque native failure before classifying a codec', async () => {
  await render();
  const video = container.querySelector('video')!;
  const gate = deferred<boolean>();
  checkAccess.mockReturnValueOnce(gate.promise);
  Object.defineProperty(video, 'error', { value: { code: 4 }, configurable: true });
  await act(async () => video.dispatchEvent(new Event('error')));
  expect(video.getAttribute('src')).toBeNull();
  expect(container.textContent).not.toContain('кодек');
  await act(async () => gate.resolve(true));
  expect(container.textContent).toContain('кодек');
  expect(onError.mock.calls[0][0]).toMatchObject({ status: 415 });
});
it('denied native failure cannot be reported as an unsupported codec', async () => {
  await render();
  const video = container.querySelector('video')!;
  Object.defineProperty(video, 'error', { value: { code: 4 }, configurable: true });
  checkAccess.mockResolvedValueOnce(false);
  await act(async () => video.dispatchEvent(new Event('error')));
  expect(video.getAttribute('src')).toBeNull();
  expect(container.textContent).not.toContain('кодек');
  expect(onError).not.toHaveBeenCalled();
});
it('#3930 does not report a cancelled play request as a media access failure', async () => {
  await render();
  const video = container.querySelector('video')!;
  vi.mocked(video.play).mockRejectedValueOnce(
    new DOMException('Playback interrupted', 'AbortError'),
  );
  await act(async () => video.click());
  expect(video.play).toHaveBeenCalledOnce();
  expect(checkAccess).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(video.getAttribute('src')).toContain('/preview/media');
});
it('a superseded preflight cannot become the source after A to B to A', async () => {
  const first = deferred<Response>(),
    second = deferred<Response>(),
    third = deferred<Response>();
  fetchMock
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  await render();
  await render({ ...source, key: 'device/other/1', fileId: 'other' });
  await render();
  await act(async () => {
    first.resolve(response());
    second.resolve(response());
  });
  expect(container.querySelector('video')).toBeNull();
  await act(async () => third.resolve(response()));
  expect(container.querySelector('video')?.getAttribute('src')).toContain(
    '/device/file/revisions/1/preview/media',
  );
});
it('session cancellation aborts preflight and prevents a late native source', async () => {
  const gate = deferred<Response>();
  fetchMock.mockReturnValueOnce(gate.promise);
  await render();
  const signal = fetchMock.mock.calls[0][1]?.signal;
  await act(async () => {
    controller.abort();
    cleanups.forEach((cleanup) => cleanup());
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => gate.resolve(response()));
  expect(container.querySelector('video')).toBeNull();
});
it('Devices watchdog starts a fresh 75 seconds for a seek and stops the obsolete source', async () => {
  vi.useFakeTimers();
  await render();
  const video = container.querySelector('video')!;
  await act(async () => video.dispatchEvent(new Event('canplay')));
  await act(async () => video.dispatchEvent(new Event('seeking')));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(74_999);
  });
  expect(checkAccess).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(checkAccess).toHaveBeenCalled();
  expect(video.getAttribute('src')).toBeNull();
  expect(container.textContent).toContain('надто довго');
});
it('session teardown pauses and clears an already assigned native source', async () => {
  await render();
  const video = container.querySelector('video')!;
  await act(async () => {
    controller.abort();
    cleanups.forEach((cleanup) => cleanup());
  });
  expect(video.getAttribute('src')).toBeNull();
  expect(video.pause).toHaveBeenCalled();
  expect(video.load).toHaveBeenCalled();
});
it('#3930 reports native video duration and ignores metadata from a replaced file', async () => {
  fetchMock.mockImplementation(async () => response());
  await render();
  const first = container.querySelector('video')!;
  Object.defineProperty(first, 'duration', { value: 123.5, configurable: true });
  await act(async () => first.dispatchEvent(new Event('loadedmetadata')));
  expect(onDurationChange).toHaveBeenLastCalledWith(123.5);
  await render({ ...source, key: 'device/other/1', fileId: 'other' });
  onDurationChange.mockClear();
  await act(async () => first.dispatchEvent(new Event('durationchange')));
  expect(onDurationChange).not.toHaveBeenCalled();
  const current = container.querySelector('video')!;
  Object.defineProperty(current, 'duration', { value: 456, configurable: true });
  await act(async () => current.dispatchEvent(new Event('durationchange')));
  expect(onDurationChange).toHaveBeenLastCalledWith(456);
  await act(async () => controller.abort());
  onDurationChange.mockClear();
  await act(async () => current.dispatchEvent(new Event('loadedmetadata')));
  expect(onDurationChange).not.toHaveBeenCalled();
});
it('bounds wheel zoom and drag to the visible video and resets through the shared badge', async () => {
  await render();
  const video = container.querySelector('video')!;
  const stage = container.querySelector<HTMLElement>('[aria-label="Відеоперегляд"]')!;
  Object.defineProperties(stage, { clientWidth: { value: 200 }, clientHeight: { value: 100 } });
  Object.defineProperties(video, { clientWidth: { value: 200 }, clientHeight: { value: 100 } });
  vi.spyOn(video, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const wheel = new WheelEvent('wheel', { deltaY: -1000, cancelable: true });
  Object.defineProperty(wheel, 'ctrlKey', { value: true });
  await act(async () => stage.dispatchEvent(wheel));
  await act(async () =>
    video.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 20, clientY: 20 }),
    ),
  );
  await act(async () =>
    stage.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 1,
        clientX: 1_000,
        clientY: 1_000,
      }),
    ),
  );
  expect(video.style.transform).toBe('translate(300px, 150px) scale(4)');
  await act(async () =>
    stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })),
  );
  await act(async () => video.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(video.play).not.toHaveBeenCalled();
  const reset = container.querySelector<HTMLButtonElement>(
    '[aria-label="Скинути масштаб (100%)"]',
  )!;
  await act(async () => reset.click());
  expect(video.style.transform).toBe('translate(0px, 0px) scale(1)');
});
it('the zoom badge and shared playback controls do not start a video drag', async () => {
  await render();
  const video = container.querySelector('video')!;
  const stage = container.querySelector<HTMLElement>('[aria-label="Відеоперегляд"]')!;
  await act(async () => stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  const reset = container.querySelector<HTMLButtonElement>(
    '[aria-label="Скинути масштаб (100%)"]',
  )!;
  Object.defineProperties(stage, { clientWidth: { value: 200 }, clientHeight: { value: 100 } });
  Object.defineProperties(video, { clientWidth: { value: 200 }, clientHeight: { value: 100 } });
  vi.spyOn(video, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  await act(async () =>
    reset.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 }),
    ),
  );
  await act(async () =>
    stage.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 200, clientY: 200 }),
    ),
  );
  expect(video.style.transform).toBe('translate(0px, 0px) scale(1.5)');
  await act(async () =>
    stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })),
  );
  await act(async () =>
    container
      .querySelector('[data-attachment-preview-video-controls] button')!
      .dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, clientX: 20, clientY: 95 }),
      ),
  );
  await act(async () =>
    stage.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 2, clientX: 200, clientY: 0 }),
    ),
  );
  expect(video.style.transform).toBe('translate(0px, 0px) scale(1.5)');
  expect(video.controls).toBe(false);
});

class NativeAudioPlayer extends HTMLElement {
  audio!: HTMLAudioElement;
  autoplay = true;
  playSpy = vi.fn(async () => {});
  play = () => this.playSpy();
  pause = () => this.audio?.pause();
  setSrc = (href: string) => {
    this.audio.src = href;
  };
  setSrcImmediate = (href: string) => {
    this.audio.src = href;
  };
  bindAudioEvents() {
    this.audio.addEventListener('canplay', () => {
      if (this.autoplay) void this.play();
      this.dispatchEvent(new Event('canplay'));
    });
  }
  retryCurrentSource() {
    this.audio = document.createElement('audio');
    this.shadowRoot!.replaceChildren(this.audio);
    this.bindAudioEvents();
    this.audio.src = this.getAttribute('src')!;
  }
  connectedCallback() {
    this.attachShadow({ mode: 'open' });
    this.autoplay = true;
    this.retryCurrentSource();
  }
}
if (!customElements.get('custom-audio-player'))
  customElements.define('custom-audio-player', NativeAudioPlayer);
const audioSource = {
  ...source,
  fileName: 'audio.wav',
  extension: 'wav',
  contentType: 'audio/wav',
};
function metadataWithoutVideo(video: HTMLVideoElement) {
  Object.defineProperties(video, {
    readyState: { configurable: true, value: 1 },
    duration: { configurable: true, value: 3 },
    videoWidth: { configurable: true, value: 0 },
    videoHeight: { configurable: true, value: 0 },
  });
}
function mediaPrefixResponse(asset: 'audio.mp3' | 'video.mpeg') {
  const bytes = readFileSync(`tests/e2e/fixtures/device-file-preview/${asset}`);
  return new Response(bytes.subarray(0, 10), {
    status: 206,
    headers: { 'content-range': `bytes 0-9/${bytes.length}`, 'content-length': '10' },
  });
}
it('#3930 replaces ambiguous MPEG video only after audio metadata and retires the old player', async () => {
  const selected = { ...source, fileName: 'recording.mpeg', extension: 'mpeg', contentType: '' };
  await render(selected);
  const video = container.querySelector('video')!;
  expect(container.querySelector('custom-audio-player')).toBeNull();
  metadataWithoutVideo(video);
  await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
  const player = container.querySelector<NativeAudioPlayer>('custom-audio-player')!;
  expect(player).not.toBeNull();
  expect(container.querySelector('video')).toBeNull();
  expect(video.getAttribute('src')).toBeNull();
  expect(video.pause).toHaveBeenCalled();
  await act(async () => player.audio.dispatchEvent(new Event('canplay')));
  expect(player.playSpy).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce(response());
  await render({
    ...selected,
    key: 'device/file/2',
    revision: 2,
    originalHref: '/api/device/files/device/file/revisions/2/content',
  });
  expect(container.querySelector('custom-audio-player')).toBeNull();
  expect(container.querySelector('video')).not.toBeNull();
  expect(player.audio.getAttribute('src')).toBeNull();
  await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
  expect(container.querySelector('custom-audio-player')).toBeNull();
});
it('#3930 keeps explicitly declared video in the video player when metadata has no dimensions', async () => {
  await render({ ...source, fileName: 'clip.mpeg', extension: 'mpeg', contentType: 'video/mpeg' });
  const video = container.querySelector('video')!;
  fetchMock.mockResolvedValueOnce(mediaPrefixResponse('video.mpeg'));
  metadataWithoutVideo(video);
  await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
  expect(container.querySelector('video')).toBe(video);
  expect(container.querySelector('custom-audio-player')).toBeNull();
  expect(onError).not.toHaveBeenCalled();
});
it('#3930 verifies MPEG audio bytes when the stored MIME was inferred as video', async () => {
  await render({ ...source, fileName: 'audio.mpeg', extension: 'mpeg', contentType: 'video/mpeg' });
  const video = container.querySelector('video')!;
  fetchMock.mockResolvedValueOnce(mediaPrefixResponse('audio.mp3'));
  metadataWithoutVideo(video);
  await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/device/files/device/file/revisions/1/preview/media',
    expect.objectContaining({ headers: expect.objectContaining({ Range: 'bytes=0-9' }) }),
  );
  expect(container.querySelector('video')).toBeNull();
  expect(container.querySelector('custom-audio-player')).not.toBeNull();
  expect(video.getAttribute('src')).toBeNull();
});
it('#3930 cancels an ignored signature Range without reading the full media response', async () => {
  await render({ ...source, fileName: 'audio.mpeg', extension: 'mpeg', contentType: 'video/mpeg' });
  const video = container.querySelector('video')!;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
  metadataWithoutVideo(video);
  await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(container.querySelector('custom-audio-player')).toBeNull();
  expect(container.querySelector('video')).toBe(video);
});
it('#3930 aborts a signature probe on revision change and ignores its late audio result', async () => {
  const selected = {
    ...source,
    fileName: 'audio.mpeg',
    extension: 'mpeg',
    contentType: 'video/mpeg',
  };
  await render(selected);
  const video = container.querySelector('video')!;
  const probe = deferred<Response>();
  let signal: AbortSignal | undefined;
  fetchMock.mockImplementationOnce(async (_, options) => {
    signal = options?.signal ?? undefined;
    return probe.promise;
  });
  metadataWithoutVideo(video);
  await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
  fetchMock.mockResolvedValueOnce(response());
  await render({
    ...source,
    key: 'device/next/1',
    fileId: 'next',
    originalHref: '/api/device/files/device/next/revisions/1/content',
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => probe.resolve(mediaPrefixResponse('audio.mp3')));
  expect(container.querySelector('custom-audio-player')).toBeNull();
  expect(container.querySelector('video')).not.toBeNull();
  expect(onError).not.toHaveBeenCalled();
});
it('#3930 forwards revoked access during signature probing without switching to audio', async () => {
  await render({ ...source, fileName: 'audio.mpeg', extension: 'mpeg', contentType: 'video/mpeg' });
  const video = container.querySelector('video')!;
  fetchMock.mockResolvedValueOnce(new Response('denied', { status: 403 }));
  metadataWithoutVideo(video);
  await act(async () => video.dispatchEvent(new Event('loadedmetadata')));
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  expect(container.querySelector('custom-audio-player')).toBeNull();
});
it('audio uses a revision key, no message endpoints, and suppresses initial autoplay', async () => {
  await render(audioSource, 'audio');
  const player = container.querySelector<NativeAudioPlayer>('custom-audio-player')!;
  expect(player.getAttribute('storage-key')).toBe('echo-device-file-preview-device/file/1');
  expect(player.hasAttribute('wave-src')).toBe(false);
  expect(player.hasAttribute('spectrum-src')).toBe(false);
  await act(async () => player.audio.dispatchEvent(new Event('canplay')));
  expect(player.playSpy).not.toHaveBeenCalled();
  await act(async () => player.play());
  expect(player.playSpy).toHaveBeenCalledTimes(1);
});
it('audio teardown closes shadow media and forbids late retry or canplay restarts', async () => {
  vi.useFakeTimers();
  await render(audioSource, 'audio');
  const player = container.querySelector<NativeAudioPlayer>('custom-audio-player')!;
  const native = player.audio;
  await act(async () => {
    controller.abort();
    cleanups.forEach((cleanup) => cleanup());
  });
  await act(async () => {
    native.dispatchEvent(new Event('canplay'));
    player.retryCurrentSource();
    player.setSrc('/obsolete');
    player.setSrcImmediate('/obsolete');
    await player.play();
  });
  expect(native.getAttribute('src')).toBeNull();
  expect(native.pause).toHaveBeenCalled();
  expect(native.load).toHaveBeenCalled();
  expect(player.playSpy).not.toHaveBeenCalled();
  await act(async () => {
    native.dispatchEvent(new Event('seeking'));
    native.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(75_000);
  });
  expect(checkAccess).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});
it('#3930 tracks audio duration across native retries and discards obsolete metadata', async () => {
  await render(audioSource, 'audio');
  const player = container.querySelector<NativeAudioPlayer>('custom-audio-player')!;
  const first = player.audio;
  Object.defineProperty(first, 'duration', { value: 12.5, configurable: true });
  await act(async () => first.dispatchEvent(new Event('loadedmetadata')));
  expect(onDurationChange).toHaveBeenLastCalledWith(12.5);
  await act(async () => player.retryCurrentSource());
  onDurationChange.mockClear();
  await act(async () => first.dispatchEvent(new Event('durationchange')));
  expect(onDurationChange).not.toHaveBeenCalled();
  Object.defineProperty(player.audio, 'duration', { value: 15, configurable: true });
  await act(async () => player.audio.dispatchEvent(new Event('durationchange')));
  expect(onDurationChange).toHaveBeenLastCalledWith(15);
  await act(async () => controller.abort());
  onDurationChange.mockClear();
  await act(async () => player.audio.dispatchEvent(new Event('loadedmetadata')));
  expect(onDurationChange).not.toHaveBeenCalled();
});
it('each audio seek has the Devices watchdog instead of MessageCard timeout', async () => {
  vi.useFakeTimers();
  await render(audioSource, 'audio');
  const player = container.querySelector<NativeAudioPlayer>('custom-audio-player')!;
  await act(async () => player.audio.dispatchEvent(new Event('canplay')));
  await act(async () => player.audio.dispatchEvent(new Event('seeking')));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(74_999);
  });
  expect(checkAccess).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(checkAccess).toHaveBeenCalledTimes(1);
  expect(player.audio.getAttribute('src')).toBeNull();
  expect(container.textContent).toContain('надто довго');
});
