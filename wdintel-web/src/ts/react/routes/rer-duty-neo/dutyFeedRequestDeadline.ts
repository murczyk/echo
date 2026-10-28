// DUTY_FEED_COUNT_DEADLINE_SYNC: cover the sequential
// `ANALYTICS_QUERY_TIMEOUT_MS_DEFAULT` and `POSTGRES_RUNTIME_STATEMENT_TIMEOUT_MS_DEFAULT`
// defaults in `wdintel-rs/src/config.rs`, plus 5 seconds for response/transport allowance.
// Runtime backend overrides are not synchronized here.
export const DUTY_FEED_BACKGROUND_REQUEST_DEADLINE_MS = 65_000;
export const DUTY_FEED_PAGINATION_REQUEST_DEADLINE_MS = 35_000;
export const DUTY_FEED_REQUEST_TIMEOUT_MESSAGE = 'Сервер не відповів вчасно. Спробуйте ще раз.';

export async function withDutyFeedRequestDeadline<T>(
  deadlineMs: number,
  request: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timeoutError = new DOMException(DUTY_FEED_REQUEST_TIMEOUT_MESSAGE, 'AbortError');
  const timeout = setTimeout(() => controller.abort(timeoutError), deadlineMs);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
