/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessengersChatReadState, MessengersMessageItem } from '../../../../../Bindings';

const apiMock = vi.hoisted(() => ({ updateMessengersChatReadState: vi.fn() }));
vi.mock('../../../services/api/analysis-messengers', () => apiMock);

import { READ_DEBOUNCE_MS, useMessengerReadTracking } from '../use-messenger-read-tracking';

const message = (id: string, sentAt: number): MessengersMessageItem => ({
  id,
  externalId: id,
  sentAt,
  text: id,
  isOutgoing: null,
  hasMedia: null,
  senderChatMemberId: null,
  attachments: [],
  telegram: null,
});

type Props = {
  messages: MessengersMessageItem[];
  oldestReadAt: number | null;
  newestReadAt: number | null;
  chatId?: string;
  windowKey?: number;
};
let seen: (ids: readonly string[]) => void;
const onReadState = vi.fn<(chatId: string, state: MessengersChatReadState) => void>();

function Probe({ chatId = 'c1', windowKey = 0, ...props }: Props) {
  seen = useMessengerReadTracking({
    accountId: 'a1',
    chatId,
    windowKey,
    onReadState,
    ...props,
  }).onVisibleMessages;
  return null;
}

describe('useMessengerReadTracking', () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = (props: Props) => act(async () => root.render(<Probe {...props} />));
  const see = (...ids: string[]) => act(async () => seen(ids));
  const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(READ_DEBOUNCE_MS)));

  beforeEach(() => {
    vi.useFakeTimers();
    onReadState.mockReset();
    apiMock.updateMessengersChatReadState
      .mockReset()
      .mockResolvedValue({ oldestReadAt: 1, newestReadAt: 2, unreadCount: 0 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const window100 = [message('a', 100), message('b', 200), message('c', 300), message('d', 400)];

  it('writes the span of what was seen once the reader settles, for a chat never read', async () => {
    await render({ messages: window100, oldestReadAt: null, newestReadAt: null });
    await see('b');
    await see('c', 'd');
    expect(apiMock.updateMessengersChatReadState).not.toHaveBeenCalled();
    await settle();
    expect(apiMock.updateMessengersChatReadState).toHaveBeenCalledTimes(1);
    expect(apiMock.updateMessengersChatReadState).toHaveBeenCalledWith({
      accountId: 'a1',
      chatId: 'c1',
      oldestReadAt: 200,
      newestReadAt: 400,
    });
    expect(onReadState).toHaveBeenCalledWith('c1', {
      oldestReadAt: 1,
      newestReadAt: 2,
      unreadCount: 0,
    });
  });

  it('writes nothing for messages already inside the read span', async () => {
    await render({ messages: window100, oldestReadAt: 100, newestReadAt: 300 });
    await see('a', 'b', 'c');
    await settle();
    expect(apiMock.updateMessengersChatReadState).not.toHaveBeenCalled();
  });

  it('widens a span the window reaches into', async () => {
    await render({ messages: window100, oldestReadAt: 100, newestReadAt: 200 });
    await see('d');
    await settle();
    expect(apiMock.updateMessengersChatReadState).toHaveBeenCalledWith(
      expect.objectContaining({ oldestReadAt: 400, newestReadAt: 400 }),
    );
  });

  it('writes nothing when the window does not reach the span: the gap would be marked read', async () => {
    // The span ends at 50, the window starts at 100: unread messages in between are not loaded.
    await render({ messages: window100, oldestReadAt: 10, newestReadAt: 50 });
    await see('c', 'd');
    await settle();
    expect(apiMock.updateMessengersChatReadState).not.toHaveBeenCalled();
    // Nor when the window is entirely older than the span.
    await render({ messages: window100, oldestReadAt: 900, newestReadAt: 950 });
    await see('a');
    await settle();
    expect(apiMock.updateMessengersChatReadState).not.toHaveBeenCalled();
  });

  it('ignores messages that are not in the window', async () => {
    await render({ messages: window100, oldestReadAt: null, newestReadAt: null });
    await see('gone');
    await see();
    await settle();
    expect(apiMock.updateMessengersChatReadState).not.toHaveBeenCalled();
  });

  it('writes what was seen when the reader leaves the chat before the delay is over', async () => {
    await render({ messages: window100, oldestReadAt: null, newestReadAt: null });
    await see('a');
    act(() => root.unmount());
    expect(apiMock.updateMessengersChatReadState).toHaveBeenCalledWith(
      expect.objectContaining({ oldestReadAt: 100, newestReadAt: 100 }),
    );
    root = createRoot(container);
  });

  describe('a jump that replaces the window', () => {
    const newestWindow = [message('n1', 700), message('n2', 800), message('n3', 900)];
    const oldestWindow = [message('o1', 100), message('o2', 200), message('o3', 300)];
    const calls = () =>
      apiMock.updateMessengersChatReadState.mock.calls.map(([req]) => [
        req.oldestReadAt,
        req.newestReadAt,
      ]);
    const never = { oldestReadAt: null, newestReadAt: null };

    it('sends what was seen before the jump as it is, and never merges it with the new window (never read chat)', async () => {
      await render({ messages: newestWindow, ...never });
      await see('n1', 'n3');
      // "Go to the start" within the delay: the oldest page replaces the window.
      await render({ messages: oldestWindow, windowKey: 1, ...never });
      await see('o1', 'o3');
      await settle();
      // One write for the newest page; the oldest page is not next to it, so it is not written, and nothing between is read.
      expect(calls()).toEqual([[700, 900]]);
    });

    it('judges the new window against what was just written, before the server has answered', async () => {
      await render({ messages: newestWindow, ...never });
      await see('n1');
      await render({ messages: oldestWindow, windowKey: 1, ...never });
      await see('o2');
      await settle();
      expect(calls()).toEqual([[700, 700]]);
    });

    it('writes a new window that reaches the written range, separately from the one before it', async () => {
      await render({ messages: newestWindow, ...never });
      await see('n3');
      // The jump lands on a window that overlaps what was written (it holds the message at 900).
      await render({
        messages: [message('x1', 850), message('n3', 900), message('x2', 950)],
        windowKey: 1,
        ...never,
      });
      await see('x2');
      await settle();
      expect(calls()).toEqual([
        [900, 900],
        [950, 950],
      ]);
    });

    it('keeps an earlier write when a later one fails, even though the earlier answer was not shown', async () => {
      let first!: (state: MessengersChatReadState) => void;
      let second!: (reason: Error) => void;
      apiMock.updateMessengersChatReadState
        .mockReset()
        .mockReturnValueOnce(new Promise<MessengersChatReadState>((resolve) => (first = resolve)))
        .mockReturnValueOnce(
          new Promise<MessengersChatReadState>((_, reject) => (second = reject)),
        );
      await render({ messages: newestWindow, ...never });
      await see('n1');
      await settle();
      // The second write goes out while the first is still on its way: only the newest answer is ever shown.
      await see('n3');
      await settle();
      expect(calls()).toEqual([
        [700, 700],
        [900, 900],
      ]);
      await act(async () => second(new Error('offline')));
      await act(async () => first({ oldestReadAt: 700, newestReadAt: 700, unreadCount: 2 }));
      // The first write is stored, the stored span (the props) has not been told: the oldest page is still not next to it.
      await render({ messages: oldestWindow, windowKey: 1, ...never });
      await see('o2');
      await settle();
      expect(calls()).toEqual([
        [700, 700],
        [900, 900],
      ]);
    });

    it('still merges what is seen while the same window only grows', async () => {
      await render({ messages: newestWindow, ...never });
      await see('n3');
      // An older page was loaded above: the same window, the same key.
      await render({ messages: [...oldestWindow, ...newestWindow], ...never });
      await see('o3', 'n1');
      await settle();
      expect(calls()).toEqual([[300, 900]]);
    });

    it('forgets what it wrote when the write failed, so the next scroll of the new window is not blocked by it', async () => {
      apiMock.updateMessengersChatReadState
        .mockReset()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ oldestReadAt: 1, newestReadAt: 2, unreadCount: 0 });
      await render({ messages: newestWindow, ...never });
      await see('n2');
      await render({ messages: oldestWindow, windowKey: 1, ...never });
      // While the first write is in flight the new window is judged against it, and held back.
      await see('o2');
      await settle();
      expect(calls()).toEqual([[800, 800]]);
      // The write failed, so nothing is stored: the next scroll of the oldest page is a fresh start.
      await see('o2');
      await settle();
      expect(calls()).toEqual([
        [800, 800],
        [200, 200],
      ]);
    });
  });

  describe('a hidden tab', () => {
    const setVisibility = (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    afterEach(() => setVisibility('visible'));

    it('reads nothing while hidden, and counts what was on screen once the tab is shown', async () => {
      await render({ messages: window100, oldestReadAt: null, newestReadAt: null });
      setVisibility('hidden');
      await see('b', 'c');
      await settle();
      expect(apiMock.updateMessengersChatReadState).not.toHaveBeenCalled();

      await act(async () => setVisibility('visible'));
      await settle();
      expect(apiMock.updateMessengersChatReadState).toHaveBeenCalledWith(
        expect.objectContaining({ oldestReadAt: 200, newestReadAt: 300 }),
      );
    });

    it('keeps only the latest screen it missed', async () => {
      await render({ messages: window100, oldestReadAt: null, newestReadAt: null });
      setVisibility('hidden');
      await see('a');
      await see('d');
      await act(async () => setVisibility('visible'));
      await settle();
      expect(apiMock.updateMessengersChatReadState).toHaveBeenCalledTimes(1);
      expect(apiMock.updateMessengersChatReadState).toHaveBeenCalledWith(
        expect.objectContaining({ oldestReadAt: 400, newestReadAt: 400 }),
      );
    });
  });

  describe('answers that arrive out of order', () => {
    const answer = (oldestReadAt: number, newestReadAt: number, unreadCount: number) => ({
      oldestReadAt,
      newestReadAt,
      unreadCount,
    });
    // Two writes in flight, the second one (n3 at 900) ran first on the server: it answers with its own span, the first
    // one (n1 at 700) answers with the union.
    const twoInFlight = async () => {
      let first!: (state: MessengersChatReadState) => void;
      let second!: (state: MessengersChatReadState) => void;
      apiMock.updateMessengersChatReadState
        .mockReset()
        .mockReturnValueOnce(new Promise<MessengersChatReadState>((resolve) => (first = resolve)))
        .mockReturnValueOnce(new Promise<MessengersChatReadState>((resolve) => (second = resolve)));
      const window = [message('n1', 700), message('n2', 800), message('n3', 900)];
      await render({ messages: window, oldestReadAt: null, newestReadAt: null });
      await see('n1');
      await settle();
      await see('n3');
      await settle();
      expect(apiMock.updateMessengersChatReadState).toHaveBeenCalledTimes(2);
      return { first, second };
    };
    const shownStates = () => onReadState.mock.calls.map(([, state]) => state);

    it('shows the union even when it answers a request made earlier and arrives last', async () => {
      const { first, second } = await twoInFlight();
      await act(async () => second(answer(900, 900, 8)));
      await act(async () => first(answer(700, 900, 6)));
      expect(shownStates().at(-1)).toEqual(answer(700, 900, 6));
    });

    it('does not let a narrower answer replace the union that came first', async () => {
      const { first, second } = await twoInFlight();
      await act(async () => first(answer(700, 900, 6)));
      await act(async () => second(answer(900, 900, 8)));
      expect(shownStates()).toEqual([answer(700, 900, 6)]);
    });

    it('does not replace what is on screen, e.g. after a refresh, with a narrower answer', async () => {
      let resolve!: (state: MessengersChatReadState) => void;
      apiMock.updateMessengersChatReadState
        .mockReset()
        .mockReturnValueOnce(new Promise<MessengersChatReadState>((r) => (resolve = r)));
      await render({ messages: window100, oldestReadAt: 300, newestReadAt: 300 });
      await see('d');
      await settle();
      expect(apiMock.updateMessengersChatReadState).toHaveBeenCalledTimes(1);
      // While the write is on its way, a refresh of the chat list brings a wider span.
      await render({ messages: window100, oldestReadAt: 300, newestReadAt: 500 });
      await act(async () => resolve(answer(300, 400, 5)));
      expect(onReadState).not.toHaveBeenCalled();
    });
  });

  it('leaves a failed write silent and sends the next one', async () => {
    apiMock.updateMessengersChatReadState.mockRejectedValueOnce(new Error('offline'));
    await render({ messages: window100, oldestReadAt: null, newestReadAt: null });
    await see('a');
    await settle();
    expect(onReadState).not.toHaveBeenCalled();
    await see('b');
    await settle();
    expect(onReadState).toHaveBeenCalledTimes(1);
  });
});
