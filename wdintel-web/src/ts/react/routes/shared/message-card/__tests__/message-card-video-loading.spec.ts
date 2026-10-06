/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadManagedVideo } from '../message-card-video-loading';

describe('managed video readiness', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stops retries at the deadline and cancels the active request', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 503, headers: { 'Retry-After': '60' } }));
    const ready = vi.fn();
    const failed = vi.fn();
    loadManagedVideo('/api/messenger/media/deadline', ready, failed);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
    const calls = fetchSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchSpy).toHaveBeenCalledTimes(calls);
  });

  it('aborts a stalled request after 30 seconds and recovers on retry', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            signal = options?.signal as AbortSignal;
            signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 206 }));
    const ready = vi.fn();
    const failed = vi.fn();
    loadManagedVideo('/api/messenger/media/stalled', ready, failed);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(ready).toHaveBeenCalledWith('/api/messenger/media/stalled/playback');
    expect(failed).not.toHaveBeenCalled();
  });

  it('uses the original URL returned by an unsupported-format redirect', async () => {
    const response = new Response(null, { status: 206 });
    Object.defineProperty(response, 'url', { value: '/api/messenger/media/unsupported' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const ready = vi.fn();
    const failed = vi.fn();
    const stop = loadManagedVideo('/api/messenger/media/unsupported', ready, failed);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith('/api/messenger/media/unsupported'));
    expect(failed).not.toHaveBeenCalled();
    stop();
  });

  it('reports terminal preparation failure without retrying', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 422 }));
    const ready = vi.fn();
    const failed = vi.fn();
    loadManagedVideo('/api/messenger/media/failed', ready, failed);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
  });

  it('ignores a response that arrives after the preview closes', async () => {
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const ready = vi.fn();
    const failed = vi.fn();
    const stop = loadManagedVideo('/api/messenger/media/closed', ready, failed);
    stop();
    finish(new Response(null, { status: 206 }));
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
});
