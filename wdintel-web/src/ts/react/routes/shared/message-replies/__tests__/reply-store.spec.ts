import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMessageReplies } from '../../../../services/api/message-replies';
import { ReplyStore } from '../reply-store';

vi.mock('../../../../services/api/message-replies', () => ({ fetchMessageReplies: vi.fn() }));
const fetchReplies = vi.mocked(fetchMessageReplies);
type Response = Awaited<ReturnType<typeof fetchMessageReplies>>;
const response = (deleted = false): Response => ({
  replies: [
    {
      id: 1,
      threadId: 10,
      originalSignalMessageId: 10,
      replySignalMessageId: 20,
      createdAt: 100,
      deleted,
      originalDeleted: false,
      replyDeleted: deleted,
    },
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
  it('retries a first hydration invalidated in flight without waiting for another polling cycle (#3612)', async () => {
    let resolve!: (value: Response) => void;
    fetchReplies.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    fetchReplies.mockResolvedValue(response());
    const store = new ReplyStore('Duty', vi.fn());
    store.attach(20);
    await settle();
    store.invalidate([20]);
    resolve({ replies: [], replyMessages: [] });
    await settle();
    await settle();
    expect(store.get(20).loaded).toBe(true);
    expect(store.get(20).relations).toHaveLength(1);
    expect(fetchReplies).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it('hydrates siblings for a reply anchor and invalidates its whole thread (#3612)', async () => {
    const thread = response();
    thread.replies.push({ ...thread.replies[0], id: 2, replySignalMessageId: 30, createdAt: 200 });
    thread.replyMessages.push({
      id: 30,
      timestamp: 30,
      createdAt: 300,
      preview: 'Sibling',
      href: '/rer-duty-neo?m=30',
    });
    fetchReplies.mockResolvedValue(thread);
    const store = new ReplyStore('Duty', vi.fn());
    store.attach(20);
    await settle();
    expect(store.get(20).relations).toHaveLength(2);
    expect(store.get(20).messages.get(30)?.preview).toBe('Sibling');
    store.invalidate([30]);
    const deletedHead = {
      ...thread,
      replies: thread.replies.map((relation) => ({
        ...relation,
        originalSignalMessageId: null,
        originalDeleted: true,
        deleted: true,
      })),
      replyMessages: thread.replyMessages.filter((message) => message.id !== 10),
    };
    fetchReplies.mockResolvedValue(deletedHead);
    await store.flush();
    expect(store.get(20).relations).toHaveLength(2);
    expect(store.get(20).messages.get(30)?.preview).toBe('Sibling');
    expect(store.get(20).messages.has(10)).toBe(false);
    store.dispose();
  });

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
    let resolveFresh!: (value: Response) => void;
    fetchReplies.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    fetchReplies.mockReturnValueOnce(
      new Promise((done) => {
        resolveFresh = done;
      }),
    );
    const store = new ReplyStore('Analysis', vi.fn());
    store.attach(10);
    await settle();
    store.invalidate([10]);
    resolve(response());
    await settle();
    expect(store.get(10).relations).toHaveLength(0);
    resolveFresh(response(true));
    await settle();
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
    const edited = response();
    edited.replyMessages[1].preview = 'Edited reply';
    fetchReplies.mockResolvedValue(edited);
    store.invalidate([20]);
    await store.flush();
    expect(store.get(10).messages.get(20)?.preview).toBe('Edited reply');
    fetchReplies.mockResolvedValue({ replies: [], replyMessages: [] });
    await store.flush();
    expect(store.get(10).relations).toHaveLength(0);
    expect(store.get(10).loaded).toBe(true);
    store.dispose();
  });

  it('shows the committed reply after saving during an older in-flight refresh', async () => {
    let resolve!: (value: Response) => void;
    fetchReplies.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const store = new ReplyStore('Duty', vi.fn());
    store.attach(10);
    await settle();
    store.invalidate([10]);
    fetchReplies.mockResolvedValue(response());
    await store.flush();
    resolve({ replies: [], replyMessages: [] });
    await settle();
    await settle();
    expect(store.get(10).messages.get(20)?.preview).toBe('Reply');
    expect(store.get(10).relations).toHaveLength(1);
    store.dispose();
  });
});
