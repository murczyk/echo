export const DUTY_FEED_REQUEST_HARD_DEADLINE_MS = 10_000;

export async function withDutyFeedRequestDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DUTY_FEED_REQUEST_HARD_DEADLINE_MS);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}
