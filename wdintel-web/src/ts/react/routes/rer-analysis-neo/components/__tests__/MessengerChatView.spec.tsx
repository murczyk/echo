/**
 * @vitest-environment happy-dom
 */
import { act, forwardRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessengersMessageItem } from '../../../../../../Bindings';
import type { MessageFeedProps } from '../../../shared/message-feed';

const apiMock = vi.hoisted(() => ({
  listMessengersChatMembers: vi.fn(),
  listMessengersMessages: vi.fn(),
  updateMessengersChatReadState: vi.fn(),
}));
vi.mock('../../../../services/api/analysis-messengers', () => apiMock);
const snackbar = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('../../../../components/PowerSnackbar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../components/PowerSnackbar')>()),
  useOptionalPowerSnackbar: () => snackbar,
}));

// The real feed needs layout to ask for edge pages; here the test asks for them itself.
const feedProps = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../../shared/message-feed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/message-feed')>()),
  MessageFeed: forwardRef((props: unknown, _ref) => {
    feedProps.current = props;
    return <div data-feed-mock />;
  }),
}));

import { MessengerChatView } from '../MessengerChatView';

const latestFeed = () => feedProps.current as MessageFeedProps<MessengersMessageItem, string>;

const message = (id: string, sentAt = Date.UTC(2026, 8, 12, 12)): MessengersMessageItem => ({
  id,
  externalId: id,
  sentAt,
  text: `text ${id}`,
  isOutgoing: false,
  hasMedia: null,
  senderChatMemberId: null,
  attachments: [],
  telegram: null,
});

const chat = {
  id: 'c1',
  chatType: 'GROUP',
  title: 'Team',
  messengerType: 'Telegram',
  externalId: 'c1',
  username: null,
  membersCount: null,
  accountMemberStatus: null,
  lastMessageDate: null,
  telegram: null,
  oldestReadAt: null,
  newestReadAt: null,
  unreadCount: 0,
  totalCount: 0,
};

describe('MessengerChatView', () => {
  let container: HTMLDivElement;
  let root: Root;

  const mount = (
    initialAnchorId: string | null = null,
    openChat: typeof chat = chat,
    openAtUnread = false,
  ) =>
    act(async () =>
      root.render(
        <MessengerChatView
          account={{ id: 'a1', name: 'Me', phone: '' }}
          chat={openChat}
          title="Team"
          initialAnchorId={initialAnchorId}
          openAtUnread={openAtUnread}
          onBack={() => undefined}
        />,
      ),
    );

  beforeEach(() => {
    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=a1',
    );
    feedProps.current = null;
    snackbar.notify.mockReset();
    apiMock.listMessengersChatMembers.mockReset().mockResolvedValue({ items: [] });
    apiMock.listMessengersMessages.mockReset();
    apiMock.updateMessengersChatReadState.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/');
  });

  it('lets the feed ask for the failed page again after the paging error is retried', async () => {
    apiMock.listMessengersMessages
      .mockResolvedValueOnce({ items: [message('msg2')], olderCursor: 'o1', newerCursor: 'n' })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [message('msg1')], olderCursor: null, newerCursor: 'n0' });
    await mount();

    await act(async () => void latestFeed().scrollOptions.onLoadOlder());
    expect(container.textContent).toContain('offline');
    const keyBefore = latestFeed().scrollOptions.edgeLoadRetryKey;

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[role="alert"] button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // A new key is what makes the feed forget that it already asked for this edge.
    expect(latestFeed().scrollOptions.edgeLoadRetryKey).not.toBe(keyBefore);
    expect(container.textContent).not.toContain('offline');
    await act(async () => void latestFeed().scrollOptions.onLoadOlder());
    expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'o1', direction: 'Older' }),
      expect.anything(),
    );
    expect(latestFeed().items.map((item) => item.id)).toEqual(['msg1', 'msg2']);
  });

  it('goes to the start of the chat through the feed arrow', async () => {
    apiMock.listMessengersMessages
      .mockResolvedValueOnce({ items: [message('msg9')], olderCursor: 'o', newerCursor: 'n' })
      .mockResolvedValueOnce({ items: [message('msg1')], olderCursor: null, newerCursor: 'n1' });
    await mount();
    expect(latestFeed().oldestNavigation).toMatchObject({ oldestLoaded: false });

    await act(async () => latestFeed().oldestNavigation?.onClick());
    expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ direction: 'Oldest', cursor: null }),
      expect.anything(),
    );
    expect(latestFeed().items.map((item) => item.id)).toEqual(['msg1']);
    expect(latestFeed().oldestNavigation).toMatchObject({ oldestLoaded: true });
  });

  it('does not ask for pages beyond the ends of the chat', async () => {
    apiMock.listMessengersMessages.mockResolvedValueOnce({
      items: [message('msg1')],
      olderCursor: null,
      newerCursor: 'n',
    });
    await mount();

    await act(async () => void latestFeed().scrollOptions.onLoadOlder());
    await act(async () => void latestFeed().scrollOptions.onLoadNewer?.());

    expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(1);
  });

  describe('a link to a message', () => {
    it('says so when the message is gone and the chat opens at its end', async () => {
      apiMock.listMessengersMessages.mockResolvedValue({
        items: [message('m2')],
        olderCursor: null,
        newerCursor: null,
      });
      await mount('gone');
      expect(snackbar.notify).toHaveBeenCalledTimes(1);
      expect(snackbar.notify.mock.calls[0][0]).toMatchObject({ severity: 'warning' });
    });

    it('says nothing when the message is there, or when there is no anchor', async () => {
      apiMock.listMessengersMessages.mockResolvedValue({
        items: [message('m1'), message('m2')],
        olderCursor: null,
        newerCursor: null,
      });
      await mount('m1');
      expect(snackbar.notify).not.toHaveBeenCalled();
      await mount(null);
      expect(snackbar.notify).not.toHaveBeenCalled();
    });
  });

  describe('position in the address bar', () => {
    // The newest page reaches the chat end, as when the reader is within the last messages.
    const newestPage = () => ({
      items: [message('m2'), message('m1')],
      olderCursor: 'o',
      newerCursor: 'n',
    });
    const scrollTo = (scrollTop: number) =>
      act(async () =>
        latestFeed().scrollerProps?.onScroll?.({
          currentTarget: { scrollHeight: 1000, clientHeight: 300, scrollTop },
        } as unknown as React.UIEvent<HTMLDivElement>),
      );
    // The write is debounced.
    const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 350))));

    it('keeps the first visible message while the window reaches the chat end but the reader is above it', async () => {
      apiMock.listMessengersMessages.mockResolvedValueOnce(newestPage());
      await mount();
      await act(async () => latestFeed().scrollOptions.onFirstVisibleMessage?.('m1', 0));
      await scrollTo(100);
      await settle();
      expect(window.location.search).toContain('messengerChat=c1');
      expect(window.location.search).toContain('messengerAnchor=m1');
    });

    it('drops the anchor when the reader is at the end of the chat', async () => {
      apiMock.listMessengersMessages.mockResolvedValueOnce(newestPage());
      await mount();
      await act(async () => latestFeed().scrollOptions.onFirstVisibleMessage?.('m1', 0));
      await scrollTo(100);
      await settle();
      await scrollTo(700);
      await settle();
      expect(window.location.search).toContain('messengerChat=c1');
      expect(window.location.search).not.toContain('messengerAnchor');
    });
  });

  describe('date pill', () => {
    // Noon UTC keeps the day the same in every time zone that matters here. The matches use word
    // boundaries because the year 2025 also contains a 5.
    const march5 = Date.UTC(2025, 2, 5, 12);
    const march7 = Date.UTC(2025, 2, 7, 12);
    const pill = () => container.querySelector('.pointer-events-none')?.textContent ?? null;

    it('starts from the newest message when the chat opens at its end', async () => {
      apiMock.listMessengersMessages.mockResolvedValueOnce({
        items: [message('m2', march7), message('m1', march5)],
        olderCursor: null,
        newerCursor: 'n',
      });
      await mount();
      expect(pill()).toMatch(/\b7\b/);
      expect(pill()).not.toMatch(/\b5\b/);
    });

    it('starts from the anchor message when the chat opens at a saved position', async () => {
      apiMock.listMessengersMessages.mockResolvedValueOnce({
        items: Array.from({ length: 50 }, (_, i) =>
          i === 20 ? message('m1', march5) : message(`n${i}`, march7),
        ),
        olderCursor: 'o',
        newerCursor: 'n',
      });
      // The anchor sits in the middle of the page, so neither end of it has its date.
      await mount('m1');
      expect(pill()).toMatch(/\b5\b/);
    });

    it('follows the first visible message and keeps its label when that message leaves the window', async () => {
      apiMock.listMessengersMessages.mockResolvedValueOnce({
        items: [message('m2', march7), message('m1', march5)],
        olderCursor: null,
        newerCursor: 'n',
      });
      await mount();
      await act(async () => latestFeed().scrollOptions.onFirstVisibleMessage?.('m1', 0));
      expect(pill()).toMatch(/\b5\b/);

      await act(async () => latestFeed().scrollOptions.onFirstVisibleMessage?.('gone', 0));
      expect(pill()).toMatch(/\b5\b/);
    });

    it('is not shown for an empty chat', async () => {
      apiMock.listMessengersMessages.mockResolvedValueOnce({
        items: [],
        olderCursor: null,
        newerCursor: null,
      });
      await mount();
      expect(pill()).toBeNull();
    });
  });

  describe('read state', () => {
    const at = (id: string, sentAt: number) => message(id, sentAt);
    // Newest first, as the API sends it: m1 and m2 were read, m3 and m4 were not.
    const page = () => ({
      items: [at('m4', 400), at('m3', 300), at('m2', 200), at('m1', 100)],
      olderCursor: null,
      newerCursor: null,
    });
    const readTo200 = { ...chat, oldestReadAt: 100, newestReadAt: 200, unreadCount: 2 };
    const dividerOf = (id: string) => {
      const item = latestFeed().items.find((entry) => entry.id === id)!;
      return (latestFeed().renderMessage!(item) as { props: { unreadDivider: string | null } })
        .props.unreadDivider;
    };
    const dividers = (...ids: string[]) => ids.map(dividerOf);
    const goToUnreadButton = () =>
      container.querySelector<HTMLButtonElement>('[data-messenger-go-to-unread]');
    const clickGoToUnread = () =>
      act(async () =>
        goToUnreadButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
      );
    const target = () => latestFeed().scrollOptions.navigationTarget?.messageId ?? null;

    it('puts the divider above the first message sent after the read span', async () => {
      apiMock.listMessengersMessages.mockResolvedValue(page());
      await mount(null, readTo200);
      expect(dividers('m1', 'm2', 'm3', 'm4')).toEqual([null, null, 'Ви зупинились тут', null]);
    });

    it('puts a divider above the span when unread history lies before it', async () => {
      apiMock.listMessengersMessages.mockResolvedValue(page());
      await mount(null, { ...chat, oldestReadAt: 300, newestReadAt: 400, unreadCount: 2 });
      expect(dividers('m1', 'm2', 'm3', 'm4')).toEqual([null, null, 'Вище — непрочитані', null]);
    });

    it('keeps the divider where it was when the chat opened, whatever the reader writes meanwhile', async () => {
      apiMock.listMessengersMessages.mockResolvedValue(page());
      await mount(null, readTo200);
      await mount(null, { ...readTo200, newestReadAt: 400, unreadCount: 0 });
      expect(dividerOf('m3')).toBe('Ви зупинились тут');
    });

    it('draws no divider for a chat never read, or fully read', async () => {
      apiMock.listMessengersMessages.mockResolvedValue(page());
      await mount();
      expect(dividers('m1', 'm2', 'm3', 'm4')).toEqual([null, null, null, null]);
      expect(goToUnreadButton()).toBeNull();
      await mount(null, { ...chat, oldestReadAt: 100, newestReadAt: 400, unreadCount: 0 });
      expect(goToUnreadButton()).toBeNull();
    });

    it('draws no divider when the window begins with unread messages: the boundary is above it', async () => {
      apiMock.listMessengersMessages.mockResolvedValue({
        items: [at('m4', 400), at('m3', 300)],
        olderCursor: 'o',
        newerCursor: null,
      });
      await mount(null, readTo200);
      expect(dividers('m3', 'm4')).toEqual([null, null]);
    });

    it('goes to the divider without a request when the first unread message is loaded', async () => {
      apiMock.listMessengersMessages.mockResolvedValue(page());
      await mount(null, readTo200);
      await clickGoToUnread();
      expect(target()).toBe('m3');
      expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(1);
    });

    it('opens the page around the read bound when the first unread message is not loaded', async () => {
      apiMock.listMessengersMessages
        .mockResolvedValueOnce({ items: [at('m9', 900)], olderCursor: 'o', newerCursor: null })
        .mockResolvedValueOnce(page());
      await mount(null, readTo200);
      expect(goToUnreadButton()?.textContent).toContain('2');
      await clickGoToUnread();
      expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ aroundSentAt: 200, cursor: null, direction: null }),
        expect.anything(),
      );
      expect(latestFeed().items.map((item) => item.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
      expect(target()).toBe('m3');
    });

    it('goes to the newest unread history message when everything after the span is read', async () => {
      // The span reaches the newest message; the history before it was never read.
      const history = { ...chat, oldestReadAt: 300, newestReadAt: 400, unreadCount: 2 };
      apiMock.listMessengersMessages.mockResolvedValueOnce({
        items: [at('m4', 400), at('m3', 300)],
        olderCursor: 'o',
        newerCursor: null,
      });
      await mount(null, history);
      apiMock.listMessengersMessages.mockResolvedValueOnce({
        items: [at('m3', 300), at('m2', 200), at('m1', 100)],
        olderCursor: null,
        newerCursor: null,
      });
      await clickGoToUnread();
      // Nothing newer than the span exists, so the only request is the one around its lower bound.
      expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(2);
      expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ aroundSentAt: 299 }),
        expect.anything(),
      );
      expect(target()).toBe('m2');
    });

    it('goes to the unread history message above the divider when it is loaded', async () => {
      apiMock.listMessengersMessages.mockResolvedValue(page());
      await mount(null, { ...chat, oldestReadAt: 300, newestReadAt: 400, unreadCount: 2 });
      await clickGoToUnread();
      expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(1);
      expect(target()).toBe('m2');
    });

    it('says so when there is nothing unread to go to', async () => {
      apiMock.listMessengersMessages.mockResolvedValue({
        items: [at('m2', 200), at('m1', 100)],
        olderCursor: null,
        newerCursor: null,
      });
      await mount(null, { ...chat, oldestReadAt: 100, newestReadAt: 200, unreadCount: 5 });
      await clickGoToUnread();
      expect(target()).toBeNull();
      expect(snackbar.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'info' }));
    });

    describe('opening at the first unread message', () => {
      const newestFirst = (...items: ReturnType<typeof at>[]) => ({
        items,
        olderCursor: null,
        newerCursor: null,
      });
      const lastRequest = () => apiMock.listMessengersMessages.mock.calls.at(-1)![0];
      const landing = () => latestFeed().scrollOptions.navigationTarget?.messageId ?? null;

      it('lands on the first message after the read span, with one request', async () => {
        apiMock.listMessengersMessages.mockResolvedValue(
          newestFirst(at('m4', 400), at('m3', 300), at('m2', 200), at('m1', 100)),
        );
        await mount(null, readTo200, true);
        expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(1);
        expect(lastRequest()).toMatchObject({ aroundSentAt: 200, cursor: null, direction: null });
        expect(landing()).toBe('m3');
        // The feed starts at the landing message, not at the end.
        expect(latestFeed().scrollOptions.policy?.initialPosition).toBe('start');
      });

      it('lands on the newest unread history message when everything after the span is read', async () => {
        apiMock.listMessengersMessages
          .mockResolvedValueOnce(newestFirst(at('m4', 400), at('m3', 300)))
          .mockResolvedValueOnce(newestFirst(at('m3', 300), at('m2', 200), at('m1', 100)));
        await mount(null, { ...chat, oldestReadAt: 300, newestReadAt: 400, unreadCount: 2 }, true);
        expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(2);
        expect(lastRequest()).toMatchObject({ aroundSentAt: 299 });
        expect(landing()).toBe('m2');
      });

      it('opens at the end when finding the first unread message fails', async () => {
        apiMock.listMessengersMessages
          .mockRejectedValueOnce(new Error('bad request'))
          .mockResolvedValueOnce(newestFirst(at('m4', 400), at('m3', 300)));
        await mount(null, readTo200, true);
        // The second request is the newest page, no error screen.
        expect(lastRequest()).toMatchObject({ aroundSentAt: null, aroundMessageId: null });
        expect(container.textContent).not.toContain('bad request');
        expect(latestFeed().items.map((item) => item.id)).toEqual(['m3', 'm4']);
        expect(landing()).toBeNull();
      });

      it('opens at the end when the counts disagree with the messages', async () => {
        apiMock.listMessengersMessages.mockResolvedValue(newestFirst(at('m2', 200), at('m1', 100)));
        await mount(null, { ...chat, oldestReadAt: 100, newestReadAt: 200, unreadCount: 5 }, true);
        expect(landing()).toBeNull();
        expect(latestFeed().scrollOptions.policy?.initialPosition).toBe('end');
      });

      it('opens at the newest page for a link, a message anchor, a chat never read or one read to its end', async () => {
        apiMock.listMessengersMessages.mockResolvedValue(
          newestFirst(at('m4', 400), at('m3', 300), at('m2', 200), at('m1', 100)),
        );
        // Each case is a chat opened afresh, as choosing a chat is.
        const open = async (...args: Parameters<typeof mount>) => {
          act(() => root.unmount());
          root = createRoot(container);
          apiMock.listMessengersMessages.mockClear();
          await mount(...args);
        };
        // Chosen in the list: an around request. From a link (the flag is off): the newest page, no `aroundSentAt`.
        await open(null, readTo200, false);
        expect(lastRequest()).toMatchObject({ aroundSentAt: null });
        expect(landing()).toBeNull();
        // A message anchor wins over the first unread.
        await open('m1', readTo200, true);
        expect(lastRequest()).toMatchObject({ aroundMessageId: 'm1', aroundSentAt: null });
        // Never read, and read to the end.
        await open(null, { ...chat, unreadCount: 4 }, true);
        expect(lastRequest()).toMatchObject({ aroundSentAt: null, aroundMessageId: null });
        await open(null, { ...chat, oldestReadAt: 100, newestReadAt: 400, unreadCount: 0 }, true);
        expect(lastRequest()).toMatchObject({ aroundSentAt: null, aroundMessageId: null });
      });
    });

    it('writes the read span once the reader settles on messages and reports the answer', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const onReadState = vi.fn();
        apiMock.listMessengersMessages.mockResolvedValue(page());
        apiMock.updateMessengersChatReadState.mockResolvedValue({
          oldestReadAt: 100,
          newestReadAt: 400,
          unreadCount: 0,
        });
        await act(async () =>
          root.render(
            <MessengerChatView
              account={{ id: 'a1', name: 'Me', phone: '' }}
              chat={readTo200}
              title="Team"
              initialAnchorId={null}
              onBack={() => undefined}
              onReadState={onReadState}
            />,
          ),
        );
        await act(async () => latestFeed().scrollOptions.onVisibleMessages?.(['m3', 'm4']));
        await act(async () => void (await vi.advanceTimersByTimeAsync(1500)));
        expect(apiMock.updateMessengersChatReadState).toHaveBeenCalledWith({
          accountId: 'a1',
          chatId: 'c1',
          oldestReadAt: 300,
          newestReadAt: 400,
        });
        expect(onReadState).toHaveBeenCalledWith('c1', {
          oldestReadAt: 100,
          newestReadAt: 400,
          unreadCount: 0,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
