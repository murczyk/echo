export const DUTY_FEED_BACKGROUND_REQUEST_DEADLINE_MS = 10_000;
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
