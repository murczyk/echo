/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DUTY_FEED_BACKGROUND_REQUEST_DEADLINE_MS,
  DUTY_FEED_REQUEST_TIMEOUT_MESSAGE,
  withDutyFeedRequestDeadline,
} from './dutyFeedRequestDeadline';

describe('withDutyFeedRequestDeadline', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['signal reason', 'generic abort'])(
    'reports an explicit timeout when a stalled request rejects with %s',
    async (rejectionKind) => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const result = withDutyFeedRequestDeadline(
        DUTY_FEED_BACKGROUND_REQUEST_DEADLINE_MS,
        (requestSignal) => {
          signal = requestSignal;
          return new Promise<never>((_, reject) => {
            requestSignal.addEventListener('abort', () =>
              reject(
                rejectionKind === 'signal reason'
                  ? requestSignal.reason
                  : new DOMException('signal is aborted without reason', 'AbortError'),
              ),
            );
          });
        },
      );
      const rejection = expect(result).rejects.toMatchObject({
        name: 'AbortError',
        message: DUTY_FEED_REQUEST_TIMEOUT_MESSAGE,
      });

      await vi.advanceTimersByTimeAsync(64_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await rejection;
      expect(signal?.reason).toMatchObject({
        name: 'AbortError',
        message: DUTY_FEED_REQUEST_TIMEOUT_MESSAGE,
      });
    },
  );

  it('preserves failures unrelated to the deadline', async () => {
    const failure = new Error('request failed');
    await expect(
      withDutyFeedRequestDeadline(DUTY_FEED_BACKGROUND_REQUEST_DEADLINE_MS, () =>
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
  });
});
