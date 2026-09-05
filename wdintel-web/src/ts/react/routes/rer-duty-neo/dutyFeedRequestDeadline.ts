// DUTY_FEED_COUNT_DEADLINE_SYNC: cover the sequential
// `ANALYTICS_QUERY_TIMEOUT_MS_DEFAULT` and `POSTGRES_RUNTIME_STATEMENT_TIMEOUT_MS_DEFAULT`
// defaults in `wdintel-rs/src/config.rs`, plus 5 seconds for response/transport allowance.
// Runtime backend overrides are not synchronized here.
export const DUTY_FEED_BACKGROUND_REQUEST_DEADLINE_MS = 65_000;
export const DUTY_FEED_PAGINATION_REQUEST_DEADLINE_MS = 35_000;

export async function withDutyFeedRequestDeadline<T>(
  deadlineMs: number,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}
