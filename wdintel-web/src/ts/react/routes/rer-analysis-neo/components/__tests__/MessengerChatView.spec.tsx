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

  const mount = (initialAnchorId: string | null = null) =>
    act(async () =>
      root.render(
        <MessengerChatView
          account={{ id: 'a1', name: 'Me', phone: '' }}
          chat={chat}
          title="Team"
          initialAnchorId={initialAnchorId}
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
});
