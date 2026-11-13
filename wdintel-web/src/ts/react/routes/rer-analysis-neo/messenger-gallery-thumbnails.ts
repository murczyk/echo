import { useEffect, useState } from 'react';

import { handleUnauthorizedMediaResponse } from '../shared/message-card/message-card-media-fetch';

// A session-wide cache of the thumbnails the gallery has shown, as object URLs (kontur's `useMediaUrl` does the same). The
// thumbnail route is a handler that checks the role and the access in the database on every request, so even a 304
// costs the server work; a tile that scrolls away and comes back should cost nothing. The same cache holds the originals of
// small photos that are shown instead of a thumbnail (`MessengerGalleryThumb.tsx`), which the server sends as `no-store`, so the
// browser never keeps them. The cap is in bytes: 100 MB is about 900 such originals (up to 200 KB, about 110 KB on average) or over
// 6000 thumbnails (10 to 20 KB), some 40 screens of scrolling back and forth. The cache lives as long as the page and is not cleared
// on a chat change, so the cap is the memory it holds for the rest of the session (blobs sit in the browser's blob store, not in the
// JS heap, and can go to disk). Lower it if weak machines show memory trouble.
export const GALLERY_THUMBNAIL_CACHE_BYTES = 100 * 1024 * 1024;
// A thumbnail that failed is not asked for again for this long, so scrolling back and forth over a broken one does not repeat it.
const FAILURE_COOLDOWN_MS = 30_000;
// The server answers 202 while it makes a thumbnail; these pauses are the same as the shared thumbs use, shortened to ~35 s in all.
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000, 10_000] as const;
const PENDING_STATUS = 202;

const cache = new Map<string, { objectUrl: string; bytes: number }>();
let cachedBytes = 0;
// The routes that mounted tiles show or wait for. Eviction skips them: revoking a URL that a tile holds breaks its image.
const holds = new Map<string, number>();
const failedAt = new Map<string, number>();
type Inflight = { promise: Promise<string>; controller: AbortController; refs: number };
const inflight = new Map<string, Inflight>();

const abortError = () => new DOMException('Aborted', 'AbortError');

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

const canBeRetried = (status: number) =>
  status === 408 || status === 425 || status === 429 || status >= 500;

async function download(
  url: string,
  signal: AbortSignal,
): Promise<{ objectUrl: string; bytes: number }> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(attempt === 0 ? url : `${url}?retry=${attempt}`, {
      credentials: 'same-origin',
      headers: { Accept: 'image/jpeg' },
      signal,
    });
    handleUnauthorizedMediaResponse(response, url);
    if (response.ok && response.status !== PENDING_STATUS) {
      const blob = await response.blob();
      return { objectUrl: URL.createObjectURL(blob), bytes: blob.size };
    }
    if (
      (response.status !== PENDING_STATUS && !canBeRetried(response.status)) ||
      attempt >= RETRY_DELAYS_MS.length
    ) {
      throw new Error(`thumbnail ${response.status}`);
    }
    await sleep(RETRY_DELAYS_MS[attempt], signal);
  }
}

function remember(url: string, entry: { objectUrl: string; bytes: number }) {
  cache.set(url, entry);
  cachedBytes += entry.bytes;
  // Oldest first; the newest entry stays even when it alone is over the cap.
  for (const [key, evicted] of cache) {
    if (cachedBytes <= GALLERY_THUMBNAIL_CACHE_BYTES) break;
    if (key === url || holds.has(key)) continue;
    cache.delete(key);
    cachedBytes -= evicted.bytes;
    URL.revokeObjectURL(evicted.objectUrl);
  }
}

// Marks a route as in use by a mounted tile until the returned function is called.
export function holdGalleryThumbnail(url: string): () => void {
  holds.set(url, (holds.get(url) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holds.get(url) ?? 1) - 1;
    if (left > 0) holds.set(url, left);
    else holds.delete(url);
  };
}

// The cached thumbnail of a route, or null. Reading it marks it as the most recently used.
export function cachedGalleryThumbnail(url: string): string | null {
  const entry = cache.get(url);
  if (entry == null) return null;
  cache.delete(url);
  cache.set(url, entry);
  return entry.objectUrl;
}

// One shared request per route however many tiles ask, and it is cancelled when the last of them lets go (a fast scroll
// past a tile must not leave its request, or its retries, running).
export function requestGalleryThumbnail(url: string): {
  promise: Promise<string>;
  release: () => void;
} {
  const lastFailure = failedAt.get(url);
  if (lastFailure != null && Date.now() - lastFailure < FAILURE_COOLDOWN_MS) {
    return { promise: Promise.reject(new Error('thumbnail recently failed')), release: () => {} };
  }
  let entry = inflight.get(url);
  if (entry == null) {
    const controller = new AbortController();
    const created: Inflight = {
      controller,
      refs: 0,
      promise: download(url, controller.signal)
        .then((downloaded) => {
          failedAt.delete(url);
          remember(url, downloaded);
          return downloaded.objectUrl;
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) failedAt.set(url, Date.now());
          throw reason;
        })
        .finally(() => {
          if (inflight.get(url) === created) inflight.delete(url);
        }),
    };
    inflight.set(url, created);
    entry = created;
  }
  const held = entry;
  held.refs += 1;
  let released = false;
  return {
    promise: held.promise,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs === 0) held.controller.abort();
    },
  };
}

export function clearGalleryThumbnailCache() {
  for (const { controller } of inflight.values()) controller.abort();
  inflight.clear();
  for (const { objectUrl } of cache.values()) URL.revokeObjectURL(objectUrl);
  cache.clear();
  cachedBytes = 0;
  failedAt.clear();
}

type ThumbnailState = { url: string; src: string | null; failed: boolean };

// The thumbnail of a route as an object URL: at once when it is cached, otherwise after the request, `failed` when it
// gave up. The request is cancelled when the tile unmounts.
export function useGalleryThumbnail(url: string): ThumbnailState {
  const [state, setState] = useState<ThumbnailState>(() => ({
    url,
    src: cachedGalleryThumbnail(url),
    failed: false,
  }));
  useEffect(() => {
    const release = holdGalleryThumbnail(url);
    const hit = cachedGalleryThumbnail(url);
    if (hit != null) {
      setState((previous) =>
        previous.url === url && previous.src === hit ? previous : { url, src: hit, failed: false },
      );
      return release;
    }
    setState({ url, src: null, failed: false });
    const request = requestGalleryThumbnail(url);
    let stopped = false;
    request.promise.then(
      (src) => {
        if (!stopped) setState({ url, src, failed: false });
      },
      () => {
        if (!stopped) setState({ url, src: null, failed: true });
      },
    );
    return () => {
      stopped = true;
      request.release();
      release();
    };
  }, [url]);
  return state.url === url ? state : { url, src: cachedGalleryThumbnail(url), failed: false };
}
