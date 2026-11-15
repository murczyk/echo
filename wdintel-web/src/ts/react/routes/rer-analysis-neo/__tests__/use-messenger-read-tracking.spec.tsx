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
};
let seen: (ids: readonly string[]) => void;
const onReadState = vi.fn<(chatId: string, state: MessengersChatReadState) => void>();

function Probe({ chatId = 'c1', ...props }: Props) {
  seen = useMessengerReadTracking({
    accountId: 'a1',
    chatId,
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

  it('shows only the newest answer', async () => {
    let resolveFirst!: (state: MessengersChatReadState) => void;
    apiMock.updateMessengersChatReadState
      .mockReset()
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce({ oldestReadAt: 100, newestReadAt: 400, unreadCount: 0 });
    await render({ messages: window100, oldestReadAt: null, newestReadAt: null });
    await see('a');
    await settle();
    await see('d');
    await settle();
    await act(async () => resolveFirst({ oldestReadAt: 100, newestReadAt: 100, unreadCount: 3 }));
    expect(onReadState).toHaveBeenCalledTimes(1);
    expect(onReadState).toHaveBeenCalledWith('c1', expect.objectContaining({ unreadCount: 0 }));
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
