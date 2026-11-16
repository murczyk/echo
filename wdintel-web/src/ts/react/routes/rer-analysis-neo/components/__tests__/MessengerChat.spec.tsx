/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessengersMessageItem } from '../../../../../../Bindings';

const apiMock = vi.hoisted(() => ({
  listMessengersChats: vi.fn(),
  listMessengersChatMembers: vi.fn(),
  listMessengersMessages: vi.fn(),
}));
vi.mock('../../../../services/api/analysis-messengers', () => apiMock);

import { MessengerWorkspace } from '../MessengerWorkspace';

const account = { id: 'a1', name: 'Me', phone: '' };

const chat = (id: string, chatType: string, title: string) => ({
  id,
  chatType,
  title,
  messengerType: 'Telegram',
  externalId: id,
  username: null,
  membersCount: null,
  accountMemberStatus: null,
  lastMessageDate: null,
  telegram: null,
  oldestReadAt: null,
  newestReadAt: null,
  unreadCount: 0,
  totalCount: 0,
});

const message = (
  id: string,
  patch: Partial<MessengersMessageItem> = {},
): MessengersMessageItem => ({
  id,
  externalId: id,
  sentAt: Date.UTC(2026, 8, 12, 12),
  text: `text ${id}`,
  isOutgoing: false,
  hasMedia: null,
  senderChatMemberId: null,
  attachments: [],
  telegram: null,
  ...patch,
});

const member = (id: string, firstName: string) => ({
  id,
  externalId: id,
  firstName,
  lastName: null,
  username: null,
  phone: null,
});

describe('messenger chat in the workspace', () => {
  let container: HTMLDivElement;
  let root: Root;

  const mount = () => act(async () => root.render(<MessengerWorkspace account={account} />));
  const click = (selector: string, index = 0) =>
    act(async () => {
      container
        .querySelectorAll<HTMLElement>(selector)
        [index].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

  // Chats are listed by section, private chats first, so the group chat is the second row.
  const openGroupChat = () => click('[data-messenger-chat]', 1);

  beforeEach(() => {
    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=a1',
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    apiMock.listMessengersChats.mockReset().mockResolvedValue({
      items: [chat('c1', 'GROUP', 'Team'), chat('c2', 'PRIVATE', 'Ivan')],
    });
    apiMock.listMessengersChatMembers
      .mockReset()
      .mockResolvedValue({ items: [member('m1', 'Olena')] });
    apiMock.listMessengersMessages.mockReset().mockResolvedValue({
      items: [message('msg2', { senderChatMemberId: 'm1' }), message('msg1', { isOutgoing: true })],
      olderCursor: null,
      newerCursor: 'n',
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  it('opens a clicked chat in place of the account cards and loads its members and messages', async () => {
    await mount();
    expect(container.querySelector('[data-messenger-card]')).not.toBeNull();

    await openGroupChat();

    expect(apiMock.listMessengersChatMembers).toHaveBeenCalledWith(
      { accountId: 'a1', chatId: 'c1' },
      expect.anything(),
    );
    expect(apiMock.listMessengersMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'a1',
        chatId: 'c1',
        cursor: null,
        aroundMessageId: null,
      }),
      expect.anything(),
    );
    expect(container.querySelector('[data-messenger-chat-view]')).not.toBeNull();
    expect(container.querySelector('[data-messenger-card]')).toBeNull();
    expect(container.textContent).toContain('text msg1');
    expect(container.textContent).toContain('text msg2');
    expect(
      container.querySelector('[data-messenger-chat][aria-current="true"]')?.textContent,
    ).toContain('Team');
  });

  it('shows messages oldest first, names incoming senders in groups, and marks outgoing ones', async () => {
    await mount();
    await openGroupChat();

    const cards = [...container.querySelectorAll('[data-messenger-message]')];
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining('text msg1'),
      expect.stringContaining('text msg2'),
    ]);
    expect(cards[0].hasAttribute('data-messenger-outgoing')).toBe(true);
    expect(cards[1].querySelector('[data-messenger-sender]')?.textContent).toBe('Olena');
  });

  it('reports the open chat to the page, and none once it is closed', async () => {
    const onOpenChatChange = vi.fn();
    await act(async () =>
      root.render(<MessengerWorkspace account={account} onOpenChatChange={onOpenChatChange} />),
    );
    expect(onOpenChatChange).not.toHaveBeenCalled();

    await openGroupChat();
    expect(onOpenChatChange).toHaveBeenLastCalledWith({ accountId: 'a1', chatId: 'c1' });

    await click('button[aria-label="Назад до акаунта"]');
    expect(onOpenChatChange).toHaveBeenLastCalledWith(null);
  });

  it('hides sender names in a private chat', async () => {
    await mount();
    await click('[data-messenger-chat]', 0);
    expect(container.querySelector('[data-messenger-sender]')).toBeNull();
    expect(container.textContent).toContain('text msg2');
  });

  it('returns to the account cards with the back button and clears the chat from the URL', async () => {
    await mount();
    await openGroupChat();
    window.history.replaceState(
      {},
      '',
      `${window.location.href}&messengerChat=c1&messengerAnchor=x`,
    );

    await click('button[aria-label="Назад до акаунта"]');

    expect(container.querySelector('[data-messenger-chat-view]')).toBeNull();
    expect(container.querySelector('[data-messenger-card]')).not.toBeNull();
    expect(window.location.search).not.toContain('messengerChat');
    expect(window.location.search).not.toContain('messengerAnchor');
  });

  it('opens the chat from the URL at the anchored message', async () => {
    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=a1&messengerChat=c1&messengerAnchor=msg1',
    );
    await mount();

    expect(container.querySelector('[data-messenger-chat-view]')).not.toBeNull();
    expect(apiMock.listMessengersMessages).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'c1', aroundMessageId: 'msg1' }),
      expect.anything(),
    );
  });

  it('opens the account instead when the chat from the URL is not among its chats', async () => {
    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=a1&messengerChat=gone&messengerAnchor=m',
    );
    await mount();

    expect(container.querySelector('[data-messenger-chat-view]')).toBeNull();
    expect(container.querySelector('[data-messenger-card]')).not.toBeNull();
    expect(window.location.search).not.toContain('messengerChat');
    expect(apiMock.listMessengersMessages).not.toHaveBeenCalled();
  });

  it('keeps a shared chat link when the chat list fails and opens the chat after a retry', async () => {
    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=a1&messengerChat=c1&messengerAnchor=msg1',
    );
    apiMock.listMessengersChats
      .mockReset()
      .mockRejectedValueOnce(new Error('list failed'))
      .mockResolvedValueOnce({ items: [chat('c1', 'GROUP', 'Team')] });
    await mount();

    expect(container.querySelector('[data-messenger-chat-view]')).toBeNull();
    expect(window.location.search).toContain('messengerChat=c1');
    expect(window.location.search).toContain('messengerAnchor=msg1');

    await click('aside button.text-xs.underline');
    expect(container.querySelector('[data-messenger-chat-view]')).not.toBeNull();
    expect(apiMock.listMessengersMessages).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'c1', aroundMessageId: 'msg1' }),
      expect.anything(),
    );
  });

  it('shows the load error with a retry', async () => {
    apiMock.listMessengersMessages
      .mockReset()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ items: [message('msg1')], olderCursor: null, newerCursor: 'n' });
    await mount();
    await openGroupChat();
    expect(container.textContent).toContain('boom');

    await click('[role="alert"] button');
    expect(container.textContent).toContain('text msg1');
  });

  it('says so when a chat has no messages', async () => {
    apiMock.listMessengersMessages
      .mockReset()
      .mockResolvedValue({ items: [], olderCursor: null, newerCursor: null });
    await mount();
    await openGroupChat();
    expect(container.textContent).toContain('Повідомлень немає');
  });

  it('shows the attachment stub for media that is not stored', async () => {
    apiMock.listMessengersMessages.mockReset().mockResolvedValue({
      items: [message('msg1', { hasMedia: true })],
      olderCursor: null,
      newerCursor: 'n',
    });
    await mount();
    await openGroupChat();
    expect(container.textContent).toContain('Вкладення недоступне');
  });

  it('says a fresh message attachment is still loading', async () => {
    apiMock.listMessengersMessages.mockReset().mockResolvedValue({
      items: [message('msg1', { hasMedia: true, sentAt: Date.now() - 60_000 })],
      olderCursor: null,
      newerCursor: 'n',
    });
    await mount();
    await openGroupChat();
    expect(container.textContent).toContain('Вкладення завантажується');
    expect(container.textContent).not.toContain('Вкладення недоступне');
  });

  it('renders photo, document and audio attachments with the shared card pieces', async () => {
    const attachment = (id: string, contentType: string, fileName: string) => ({
      media: {
        id,
        contentType,
        fileName,
        sizeBytes: 10,
        href: `/api/messenger/media/${id}`,
        transcription: null,
        ocr: null,
        summary: null,
        coordinateStatus: null,
        kmzConversionStatus: null,
        positions: [],
      },
      externalId: id,
      createdAt: null,
      telegram: null,
    });
    apiMock.listMessengersMessages.mockReset().mockResolvedValue({
      items: [
        message('msg1', {
          hasMedia: true,
          attachments: [
            attachment('img1', 'image/jpeg', 'photo.jpg'),
            attachment('doc1', 'application/pdf', 'report.pdf'),
            attachment('aud1', 'audio/mpeg', 'voice.mp3'),
          ],
        }),
      ],
      olderCursor: null,
      newerCursor: 'n',
    });
    await mount();
    await openGroupChat();

    const attachments = container.querySelector('[data-messenger-attachments]');
    expect(attachments).not.toBeNull();
    // The photo thumbnail is loaded lazily, so only its gallery slot is checked here.
    expect(attachments?.querySelector('.message-card-gallery')?.children.length).toBe(1);
    expect(attachments?.textContent).toContain('report.pdf');
    expect(attachments?.querySelectorAll('.message-card-audio-row')).toHaveLength(1);
    expect(container.textContent).not.toContain('Вкладення недоступне');
  });

  it('turns links in the text into links that open in a new tab and leaves the text intact', async () => {
    apiMock.listMessengersMessages.mockReset().mockResolvedValue({
      items: [
        message('msg1', {
          text:
            'site https://example.com/a?b=1, www.ArashiShop.ir and ' +
            `${window.location.origin}/rer-analysis-neo?m=7.`,
        }),
      ],
      olderCursor: null,
      newerCursor: 'n',
    });
    await mount();
    await openGroupChat();

    const text = container.querySelector('[data-messenger-copy-text]')!;
    const links = [...text.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/a?b=1',
      'https://www.arashishop.ir/',
      `${window.location.origin}/rer-analysis-neo?m=7`,
    ]);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect(text.textContent).toContain(
      `site https://example.com/a?b=1, www.ArashiShop.ir and ${window.location.origin}/rer-analysis-neo?m=7.`,
    );
  });

  it('copies a link to the message', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await mount();
    await openGroupChat();
    await click('[data-messenger-menu]');
    await act(async () => {
      document.querySelector<HTMLElement>('[data-messenger-copy-link]')!.click();
    });

    const link = new URL(writeText.mock.calls[0][0]);
    expect(link.searchParams.get('messengerChat')).toBe('c1');
    expect(link.searchParams.get('messengerAnchor')).toBe('msg1');
    expect(link.searchParams.get('messengerAccount')).toBe('a1');
  });

  it('copies the message text from the menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await mount();
    await openGroupChat();
    await click('[data-messenger-menu]');
    await act(async () => {
      document.querySelector<HTMLElement>('[data-messenger-copy-text-action]')!.click();
    });

    expect(writeText).toHaveBeenCalledWith(expect.any(String));
    expect(writeText.mock.calls[0][0]).not.toContain('messengerChat');
  });
});
