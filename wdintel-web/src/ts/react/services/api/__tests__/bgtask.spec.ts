/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client')>()),
  getJson: vi.fn(),
}));

import { getJson, HttpRequestError } from '../client';
import { waitForBgtaskCompletion } from '../bgtask';

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(getJson).mockReset();
});

// @test-scope safeguard: prevents transient polling failures or cancellation from losing or indefinitely retrying a background task.
describe('waitForBgtaskCompletion', () => {
  it('retries a temporary status failure without losing the task', async () => {
    vi.useFakeTimers();
    vi.mocked(getJson)
      .mockRejectedValueOnce(new HttpRequestError(503, 'Temporary failure'))
      .mockResolvedValueOnce({
        running: false,
        loglines: ['Done'],
        finished_with_error: null,
        progress: 100,
      });
    const onProgress = vi.fn();
    const onStatusError = vi.fn();

    const completion = waitForBgtaskCompletion(42, onProgress, { onStatusError });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(completion).resolves.toBeUndefined();

    expect(onStatusError).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(100, 'Done');
    expect(vi.mocked(getJson)).toHaveBeenCalledTimes(2);
  });

  it('stops retrying when polling is aborted', async () => {
    vi.useFakeTimers();
    vi.mocked(getJson).mockRejectedValueOnce(new HttpRequestError(503, 'Temporary failure'));
    const controller = new AbortController();
    const completion = waitForBgtaskCompletion(42, vi.fn(), { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.mocked(getJson)).toHaveBeenCalledTimes(1);
  });
});
