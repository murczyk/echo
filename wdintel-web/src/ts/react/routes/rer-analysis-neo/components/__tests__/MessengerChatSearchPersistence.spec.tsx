/**
 * @vitest-environment happy-dom
 */
import { act, forwardRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessengersMessageItem } from '../../../../../../Bindings';

const apiMock = vi.hoisted(() => ({
  listMessengersChatMembers: vi.fn(),
  listMessengersMessages: vi.fn(),
  updateMessengersChatReadState: vi.fn(),
}));
vi.mock('../../../../services/api/analysis-messengers', () => apiMock);
vi.mock('../../../../components/PowerSnackbar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../components/PowerSnackbar')>()),
  useOptionalPowerSnackbar: () => ({ notify: vi.fn() }),
}));
vi.mock('../../../shared/message-feed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/message-feed')>()),
  MessageFeed: forwardRef(() => <div data-feed-mock />),
}));

import { MessengerChatView } from '../MessengerChatView';

const message = (id: string, headline: string | null = null): MessengersMessageItem => ({
  id,
  externalId: id,
  sentAt: Date.UTC(2026, 8, 12, 12),
  text: `text ${id}`,
  isOutgoing: false,
  hasMedia: null,
  senderChatMemberId: null,
  attachments: [],
  telegram: null,
  headline,
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

// The real search bar inside the real chat view: closing the bar must not cost the reader their search.
describe('search bar state across closing and reopening it', () => {
  let container: HTMLDivElement;
  let root: Root;

  const click = (element: Element | null | undefined) =>
    act(async () => void element?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const toggle = () => click(container.querySelector('[data-messenger-chat-search-toggle]'));
  const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Пошук у чаті"]');
  const hits = () => container.querySelectorAll('[data-messenger-search-hit]');
  const bar = () => container.querySelector<HTMLElement>('[data-messenger-chat-search]');
  const searchCalls = () =>
    apiMock.listMessengersMessages.mock.calls.filter(([req]) => req.query != null);

  beforeEach(() => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/rer-analysis-neo?leftPanelTab=messenger');
    apiMock.listMessengersChatMembers.mockReset().mockResolvedValue({ items: [] });
    apiMock.updateMessengersChatReadState.mockReset();
    apiMock.listMessengersMessages.mockReset().mockImplementation(async (req) => ({
      items:
        req.query == null
          ? [message('m1')]
          : [message('m2', 'вогонь по танках'), message('m1', 'ще танк')],
      olderCursor: null,
      newerCursor: null,
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <MessengerChatView
          account={{ id: 'a1', name: 'Me', phone: '' }}
          chat={chat}
          title="Team"
          initialAnchorId={null}
          onBack={() => undefined}
        />,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    window.history.replaceState({}, '', '/');
  });

  it('keeps the text and the hits while the bar is closed, and shows them again without asking again', async () => {
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    await toggle();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input()!,
        'танк',
      );
      input()!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(350)));
    expect(hits()).toHaveLength(2);
    expect(searchCalls()).toHaveLength(1);

    // Closed: hidden from the page (and from tabbing), but still there.
    await toggle();
    expect(bar()?.parentElement?.hidden).toBe(true);
    expect(input()?.value).toBe('танк');

    await toggle();
    expect(bar()?.parentElement?.hidden).toBe(false);
    expect(input()?.value).toBe('танк');
    // The press on the header button was outside the field, so the list is folded; a click on the input brings it back.
    await click(input());
    expect(hits()).toHaveLength(2);
    expect(searchCalls()).toHaveLength(1);
  });

  it('does not mount the search at all before the button is first pressed', () => {
    expect(bar()).toBeNull();
    expect(searchCalls()).toHaveLength(0);
  });
});
