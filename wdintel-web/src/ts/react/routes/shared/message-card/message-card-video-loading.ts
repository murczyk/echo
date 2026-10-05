import { handleUnauthorizedMediaResponse } from './message-card-media-fetch';

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DEADLINE_MS = 120_000;
const RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;

function retryDelay(response: Response | null, attempt: number): number {
  const fallback = Math.min(MAX_RETRY_DELAY_MS, RETRY_DELAY_MS * 2 ** attempt);
  const retryAfter = response?.headers.get('Retry-After');
  if (!retryAfter) return fallback;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.max(fallback, seconds * 1_000);
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(fallback, date - Date.now()) : fallback;
}

export function loadManagedVideo(
  source: string,
  onReady: (url: string) => void,
  onError: (cause: unknown) => void,
): () => void {
  const playbackUrl = `${source.replace(/\/$/, '')}/playback`;
  let stopped = false;
  let attempt = 0;
  let retryTimer: number | undefined;
  let request: AbortController | undefined;
  const stop = () => {
    stopped = true;
    request?.abort();
    window.clearTimeout(retryTimer);
    window.clearTimeout(deadlineTimer);
  };
  const fail = (cause: unknown) => {
    if (stopped) return;
    stop();
    onError(cause);
  };
  const deadlineTimer = window.setTimeout(
    () => fail(new Error('Video loading timed out')),
    RETRY_DEADLINE_MS,
  );
  const scheduleRetry = (response: Response | null) => {
    if (stopped) return;
    const delay = retryDelay(response, attempt++);
    retryTimer = window.setTimeout(() => void fetchVideo(), delay);
  };
  const fetchVideo = async () => {
    request = new AbortController();
    const timeout = window.setTimeout(() => request?.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(playbackUrl, {
        credentials: 'same-origin',
        headers: { Range: 'bytes=0-0', 'X-Echo-Media-Cache-Preflight': '1' },
        signal: request.signal,
      });
    } catch {
      window.clearTimeout(timeout);
      scheduleRetry(null);
      return;
    }
    window.clearTimeout(timeout);
    if (stopped) {
      void response.body?.cancel();
      return;
    }
    handleUnauthorizedMediaResponse(response, playbackUrl);
    try {
      await response.body?.cancel();
    } catch {}
    if (stopped) return;
    if ([408, 425, 429].includes(response.status) || response.status >= 500) {
      scheduleRetry(response);
      return;
    }
    if (!response.ok) {
      fail(new Error(`Video loading failed with status ${response.status}`));
      return;
    }
    const resolved = response.url || playbackUrl;
    stop();
    onReady(resolved);
  };
  void fetchVideo();
  return stop;
}
