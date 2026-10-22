import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMessageReplies } from '../../../../services/api/message-replies';
import { ReplyStore } from '../reply-store';

vi.mock('../../../../services/api/message-replies', () => ({ fetchMessageReplies: vi.fn() }));
const fetchReplies = vi.mocked(fetchMessageReplies);
type Response = Awaited<ReturnType<typeof fetchMessageReplies>>;
const response = (deleted = false): Response => ({
  replies: [
    { id: 1, originalSignalMessageId: 10, replySignalMessageId: 20, createdAt: 100, deleted },
  ],
  replyMessages: deleted
    ? []
    : [
        { id: 10, timestamp: 10, createdAt: 100, preview: 'Original', href: '/rer-duty-neo?m=10' },
        { id: 20, timestamp: 20, createdAt: 200, preview: 'Reply', href: '/rer-duty-neo?m=20' },
      ],
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => vi.resetAllMocks());

// Regression: https://github.com/echoua/echo/issues/3612
describe('reply refresh scheduling and stale deletion protection', () => {
  it('loads a mounted batch once and waits for scheduled reconciliation after event bursts', async () => {
    fetchReplies.mockResolvedValue(response());
    const store = new ReplyStore('Duty', vi.fn());
    const detach = store.attach(10);
    store.attach(20);
    await settle();
    expect(fetchReplies).toHaveBeenCalledTimes(1);
    expect(store.get(10).relations).toHaveLength(1);
    store.invalidate([20]);
    store.invalidate([20]);
    await settle();
    expect(fetchReplies).toHaveBeenCalledTimes(1);
    fetchReplies.mockResolvedValue(response(true));
    await store.flush();
    expect(store.get(10).relations[0].deleted).toBe(true);
    expect(store.get(10).messages.has(20)).toBe(false);
    detach();
    store.dispose();
  });

  it('does not restore a stale preview when deletion arrives during an in-flight response', async () => {
    let resolve!: (value: Response) => void;
    fetchReplies.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const store = new ReplyStore('Analysis', vi.fn());
    store.attach(10);
    await settle();
    store.invalidate([10]);
    resolve(response());
    await settle();
    expect(store.get(10).relations).toHaveLength(0);
    fetchReplies.mockResolvedValue(response(true));
    await store.flush();
    expect(store.get(10).relations[0].deleted).toBe(true);
    expect(store.get(10).messages.has(20)).toBe(false);
    store.dispose();
  });

  it('recovers missed events and failed hydration on the next scheduled refresh', async () => {
    const onError = vi.fn();
    fetchReplies.mockRejectedValueOnce(new Error('offline'));
    const store = new ReplyStore('Duty', onError);
    store.attach(10);
    await settle();
    expect(onError).toHaveBeenCalledOnce();
    fetchReplies.mockResolvedValue(response());
    await store.flush();
    expect(store.get(10).messages.get(20)?.preview).toBe('Reply');
    fetchReplies.mockResolvedValue({ replies: [], replyMessages: [] });
    await store.flush();
    expect(store.get(10).relations).toHaveLength(0);
    store.dispose();
  });
});
