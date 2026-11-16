/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Virtuoso needs a real layout; this stand-in renders the first 5 items, so "virtual" is visible in the DOM.
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => ReactNode;
  }) => (
    <div data-virtuoso>
      {data.slice(0, 5).map((item, index) => (
        <div key={index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));
const apiMock = vi.hoisted(() => ({
  listMessengersChats: vi.fn(),
  listMessengersChatMembers: vi.fn(),
  listMessengersMessages: vi.fn(),
  listMessengersContacts: vi.fn(),
}));
vi.mock('../../../../services/api/analysis-messengers', () => apiMock);

import { MessengerWorkspace } from '../MessengerWorkspace';

const account = { id: 'a1', name: 'Me', phone: '+10', username: 'me', userId: '7' };
const chats = (count: number) => ({
  items: Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    chatType: 'PRIVATE',
    title: `Chat ${index}`,
    messengerType: 'Telegram',
    externalId: `p${index}`,
    username: null,
    membersCount: null,
    accountMemberStatus: null,
    lastMessageDate: null,
    telegram: null,
    oldestReadAt: null,
    newestReadAt: null,
    unreadCount: 0,
    totalCount: 0,
  })),
});

describe('the chat lists of the messenger sidebar', () => {
  let container: HTMLDivElement;
  let root: Root;
  const mount = async (count: number) => {
    apiMock.listMessengersChats.mockResolvedValue(chats(count));
    await act(async () => root.render(<MessengerWorkspace account={account} />));
  };
  const full = () => container.querySelector<HTMLElement>('aside[aria-label="Навігація акаунту"]')!;
  const rail = () => container.querySelector<HTMLElement>('[data-messenger-sidebar-rail]')!;

  beforeEach(() => {
    // Node 25+ shadows the DOM storage with its own, which has no methods without a file.
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=a1',
    );
    apiMock.listMessengersChatMembers.mockResolvedValue({ items: [] });
    apiMock.listMessengersMessages.mockResolvedValue({
      items: [],
      olderCursor: null,
      newerCursor: null,
    });
    apiMock.listMessengersContacts.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    delete (window as { localStorage?: Storage }).localStorage;
    act(() => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/');
  });

  it('keeps a short list as plain rows', async () => {
    await mount(10);
    expect(full().querySelector('[data-messenger-virtual-list]')).toBeNull();
    expect(full().querySelectorAll('[data-messenger-chat]')).toHaveLength(10);
  });

  it('virtualizes a long list in the full sidebar', async () => {
    await mount(200);
    expect(full().querySelector('[data-messenger-virtual-list]')).not.toBeNull();
    expect(full().querySelectorAll('[data-messenger-chat]')).toHaveLength(5);
  });

  it('virtualizes a long list in the rail once its kind is opened', async () => {
    await mount(200);
    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-messenger-rail-section-toggle="private"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(rail().querySelector('[data-messenger-virtual-list]')).not.toBeNull();
    expect(rail().querySelectorAll('[data-messenger-rail-chat]')).toHaveLength(5);
  });
});
