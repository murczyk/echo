/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cachedGalleryThumbnail,
  clearGalleryThumbnailCache,
  GALLERY_THUMBNAIL_CACHE_BYTES,
  holdGalleryThumbnail,
  requestGalleryThumbnail,
} from '../messenger-gallery-thumbnails';

const answer = (status: number) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    blob: async () => new Blob(['jpeg']),
  }) as Response;

describe('gallery thumbnail cache', () => {
  const fetchMock = vi.fn();
  let counter = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    counter = 0;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => `blob:t${(counter += 1)}`);
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    clearGalleryThumbnailCache();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('downloads once, then serves the object URL from the cache', async () => {
    fetchMock.mockResolvedValue(answer(200));
    const first = requestGalleryThumbnail('/t/1');
    await expect(first.promise).resolves.toBe('blob:t1');
    expect(cachedGalleryThumbnail('/t/1')).toBe('blob:t1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin' });
  });

  it('shares one request between tiles that ask at the same time', async () => {
    fetchMock.mockResolvedValue(answer(200));
    const a = requestGalleryThumbnail('/t/1');
    const b = requestGalleryThumbnail('/t/1');
    await Promise.all([a.promise, b.promise]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks again with a growing pause while the thumbnail is being made', async () => {
    fetchMock
      .mockResolvedValueOnce(answer(202))
      .mockResolvedValueOnce(answer(202))
      .mockResolvedValue(answer(200));
    const request = requestGalleryThumbnail('/t/1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock.mock.calls[1][0]).toBe('/t/1?retry=1');
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(request.promise).resolves.toBe('blob:t1');
    expect(fetchMock.mock.calls[2][0]).toBe('/t/1?retry=2');
  });

  it('gives up after the retries, and does not ask again during the cooldown', async () => {
    fetchMock.mockResolvedValue(answer(202));
    const request = requestGalleryThumbnail('/t/1');
    const failure = expect(request.promise).rejects.toThrow('thumbnail 202');
    await vi.advanceTimersByTimeAsync(60_000);
    await failure;
    expect(fetchMock).toHaveBeenCalledTimes(7);

    await expect(requestGalleryThumbnail('/t/1').promise).rejects.toThrow('recently failed');
    expect(fetchMock).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(30_000);
    fetchMock.mockResolvedValue(answer(200));
    await expect(requestGalleryThumbnail('/t/1').promise).resolves.toBe('blob:t1');
  });

  it('does not retry an answer that will not change', async () => {
    fetchMock.mockResolvedValue(answer(422));
    await expect(requestGalleryThumbnail('/t/1').promise).rejects.toThrow('thumbnail 422');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the request when the last tile lets go, but not while another still waits', async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const a = requestGalleryThumbnail('/t/1');
    const b = requestGalleryThumbnail('/t/1');
    const settled = Promise.allSettled([a.promise, b.promise]);
    a.release();
    expect(signal?.aborted).toBe(false);
    b.release();
    expect(signal?.aborted).toBe(true);
    await settled;
    // An abort is not a failure of the thumbnail: it can be asked for at once.
    fetchMock.mockResolvedValue(answer(200));
    await expect(requestGalleryThumbnail('/t/1').promise).resolves.toBe('blob:t1');
  });

  it('keeps what fits in the byte cap, newest last, and revokes the rest', async () => {
    const megabyte = new Uint8Array(1024 * 1024);
    fetchMock.mockImplementation(async () => ({
      ...answer(200),
      blob: async () => new Blob([megabyte]),
    }));
    const fit = GALLERY_THUMBNAIL_CACHE_BYTES / megabyte.length;
    for (let index = 0; index <= fit; index += 1) {
      await requestGalleryThumbnail(`/t/${index}`).promise;
    }
    expect(cachedGalleryThumbnail('/t/0')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:t1');
    expect(cachedGalleryThumbnail('/t/1')).not.toBeNull();
    expect(cachedGalleryThumbnail(`/t/${fit}`)).not.toBeNull();
  });

  it('does not evict a route that a tile holds, and evicts it after the release', async () => {
    const megabyte = new Uint8Array(1024 * 1024);
    fetchMock.mockImplementation(async () => ({
      ...answer(200),
      blob: async () => new Blob([megabyte]),
    }));
    const fit = GALLERY_THUMBNAIL_CACHE_BYTES / megabyte.length;
    await requestGalleryThumbnail('/t/held').promise;
    const release = holdGalleryThumbnail('/t/held');
    for (let index = 0; index <= fit; index += 1) {
      await requestGalleryThumbnail(`/t/${index}`).promise;
    }
    // Not read through the cache here: that would refresh it and hide the eviction order.
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:t1');
    // Its turn comes with the next thumbnail once nothing holds it.
    release();
    await requestGalleryThumbnail('/t/next').promise;
    expect(cachedGalleryThumbnail('/t/held')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:t1');
  });

  it('keeps the cached entry when a route is downloaded again', async () => {
    fetchMock.mockResolvedValue(answer(200));
    await expect(requestGalleryThumbnail('/t/1').promise).resolves.toBe('blob:t1');
    await expect(requestGalleryThumbnail('/t/1').promise).resolves.toBe('blob:t1');
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:t2');
    expect(cachedGalleryThumbnail('/t/1')).toBe('blob:t1');
  });

  it('keeps a single entry that is over the cap by itself', async () => {
    fetchMock.mockImplementation(async () => ({
      ...answer(200),
      blob: async () => new Blob([new Uint8Array(GALLERY_THUMBNAIL_CACHE_BYTES + 1)]),
    }));
    await requestGalleryThumbnail('/t/big').promise;
    expect(cachedGalleryThumbnail('/t/big')).not.toBeNull();
  });
});
