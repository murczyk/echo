/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Virtuoso needs a real layout; this stand-in renders every item.
vi.mock('react-virtuoso', () => {
  const list = ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => ReactNode;
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={index}>{itemContent(index, item)}</div>
      ))}
    </div>
  );
  return { Virtuoso: list, VirtuosoGrid: list };
});
const apiMock = vi.hoisted(() => ({
  listMessengersChats: vi.fn(),
  listMessengersChatMembers: vi.fn(),
  listMessengersMessages: vi.fn(),
  listMessengersContacts: vi.fn(),
  listMessengersAttachments: vi.fn(),
  countMessengersAttachments: vi.fn(),
}));
vi.mock('../../../../services/api/analysis-messengers', () => apiMock);
vi.mock('../../messenger-gallery-thumbnails', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../messenger-gallery-thumbnails')>()),
  useGalleryThumbnail: () => ({ url: '', src: 'blob:thumb', failed: false }),
}));

import { MessengerWorkspace } from '../MessengerWorkspace';

const account = { id: 'a1', name: 'Me', phone: '+10' };
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
const photo = {
  chatId: 'c1',
  messageId: 'm7',
  sentAt: Date.UTC(2026, 7, 28),
  senderChatMemberId: null,
  attachment: {
    media: {
      id: 'p1',
      contentType: 'image/jpeg',
      fileName: 'p1.jpg',
      sizeBytes: 2048,
      href: '/api/messenger/media/p1',
      transcription: null,
      ocr: null,
      summary: null,
      coordinateStatus: null,
      kmzConversionStatus: null,
      positions: [],
    },
    externalId: 'p1',
    createdAt: null,
    telegram: null,
  },
};

describe('the gallery of an account in the messenger workspace', () => {
  let container: HTMLDivElement;
  let root: Root;
  const mount = () => act(async () => root.render(<MessengerWorkspace account={account} />));
  const click = (selector: string) =>
    act(async () => {
      container
        .querySelector<HTMLElement>(selector)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  const view = () => container.querySelector('[data-messenger-gallery-view]');
  const navItem = () => container.querySelector<HTMLElement>('[data-messenger-nav="gallery"]')!;

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
    apiMock.listMessengersChats.mockReset().mockResolvedValue({ items: [chat] });
    apiMock.listMessengersChatMembers.mockReset().mockResolvedValue({ items: [] });
    apiMock.listMessengersMessages
      .mockReset()
      .mockResolvedValue({ items: [], olderCursor: null, newerCursor: null });
    apiMock.listMessengersContacts
      .mockReset()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    apiMock.countMessengersAttachments.mockReset().mockResolvedValue({
      items: [{ telegramMediaType: 'photo', count: 42 }],
    });
    apiMock.listMessengersAttachments
      .mockReset()
      .mockResolvedValue({ items: [photo], olderCursor: null, newerCursor: null });
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

  it('opens from the "Галерея" item of the sidebar for the whole account, and goes back', async () => {
    await mount();
    expect(view()).toBeNull();
    await click('[data-messenger-nav="gallery"]');
    expect(view()).not.toBeNull();
    expect(navItem().dataset.selected).toBe('true');
    expect(window.location.search).toContain('messengerView=gallery');
    // The account scope: no chat.
    expect(apiMock.listMessengersAttachments).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'a1', chatId: null }),
      expect.anything(),
    );
    // The counts of the whole account are in the labels of the tabs.
    expect(apiMock.countMessengersAttachments).toHaveBeenCalledWith(
      { accountId: 'a1', chatId: null },
      expect.anything(),
    );
    expect(container.textContent).toContain('Фото (42)');
    expect(container.textContent).toContain('Відео (0)');

    await click('button[aria-label="Назад до акаунта"]');
    expect(view()).toBeNull();
    expect(window.location.search).not.toContain('messengerView');
  });

  it('opens from the rail too', async () => {
    await mount();
    await click('button[aria-label="Згорнути панель акаунту"]');
    await click('[data-messenger-rail-nav="gallery"]');
    expect(view()).not.toBeNull();
    expect(
      container.querySelector<HTMLElement>('[data-messenger-rail-nav="gallery"]')!.dataset.selected,
    ).toBe('true');
  });

  it('opens the chat of an item at its message', async () => {
    await mount();
    await click('[data-messenger-nav="gallery"]');
    await click('button[aria-label="Перейти до повідомлення"]');
    expect(view()).toBeNull();
    expect(apiMock.listMessengersMessages).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'c1', aroundMessageId: 'm7' }),
      expect.anything(),
    );
    expect(container.querySelector('[data-messenger-chat-view]')).not.toBeNull();
  });
});
