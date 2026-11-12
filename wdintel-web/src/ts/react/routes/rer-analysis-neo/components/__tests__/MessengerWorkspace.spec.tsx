/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listMessengersChatMembers,
  listMessengersChats,
  listMessengersMessages,
} from '../../../../services/api/analysis-messengers';
import { MessengerWorkspace } from '../MessengerWorkspace';

vi.mock('../../../../services/api/analysis-messengers', () => ({
  listMessengersChats: vi.fn(),
  listMessengersChatMembers: vi.fn(),
  listMessengersMessages: vi.fn(),
}));

describe('MessengerWorkspace', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(listMessengersChats).mockResolvedValue({ items: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('has content only once an account is chosen', () => {
    act(() => root.render(<MessengerWorkspace account={null} />));
    expect(container.querySelector('[data-messenger-workspace]')).toBeNull();
    expect(container.textContent).toContain('Акаунт не обрано');

    act(() =>
      root.render(
        <MessengerWorkspace account={{ id: '1', name: 'name test', phone: '+10000000000' }} />,
      ),
    );
    expect(container.querySelector('[data-messenger-workspace-empty]')).toBeNull();
    expect(container.textContent).toContain('name test');
  });

  it('shows both ids and reports a click on the external id', () => {
    const account = {
      id: '1',
      name: 'name test',
      phone: '+10000000000',
      userId: 'user id test',
      externalId: 'external id test',
    };
    act(() => root.render(<MessengerWorkspace account={account} />));
    expect(container.querySelector('[data-messenger-user-id]')?.textContent).toContain(
      'user id test',
    );
  });

  it('does not carry an unsaved internal note draft over to another account', () => {
    const onSaveInternalNotes = vi.fn();
    const render = (id: string) =>
      act(() =>
        root.render(
          <MessengerWorkspace
            account={{ id, name: `name ${id}`, phone: '', internalNotes: 'saved' }}
            onSaveInternalNotes={onSaveInternalNotes}
          />,
        ),
      );

    render('1');
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Редагувати"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(container.querySelector('textarea')).not.toBeNull();

    render('2');
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('puts the account chats into their sections', async () => {
    const chat = (id: string, chatType: string | null, title: string, isBot?: boolean) => ({
      isBot,
      id,
      chatType,
      title,
      messengerType: 'Telegram',
      externalId: id,
      username: null,
      membersCount: null,
      accountMemberStatus: null,
      lastMessageDate: Date.UTC(2026, 8, 12, 12),
      telegram: null,
    });
    vi.mocked(listMessengersChats).mockResolvedValue({
      items: [
        chat('1', 'PRIVATE', 'Ivan'),
        chat('2', 'CHANNEL', 'News'),
        chat('3', 'GROUP', 'Team'),
        chat('4', null, 'Untyped'),
        chat('5', 'PRIVATE', 'Helper', true),
      ],
    });
    await act(async () =>
      root.render(<MessengerWorkspace account={{ id: 'a', name: 'name', phone: '' }} />),
    );

    expect(listMessengersChats).toHaveBeenCalledWith({ accountId: 'a' }, expect.anything());
    const sections = [...container.querySelectorAll('section')].map((s) => s.textContent);
    expect(sections[0]).toContain('Приватні (1)');
    expect(sections[0]).toContain('Ivan');
    expect(sections[0]).toContain('12.09.26');
    expect(sections[1]).toContain('Групи (2)');
    expect(sections[1]).toContain('Team');
    expect(sections[1]).toContain('Untyped');
    expect(sections[2]).toContain('Канали (1)');
    expect(sections[3]).toContain('Боти (1)');
    expect(sections[3]).toContain('Helper');
  });

  it('does not show the previous account chats while the next account loads', async () => {
    const item = {
      id: '1',
      chatType: 'PRIVATE',
      title: 'Ivan',
      messengerType: 'Telegram',
      externalId: '1',
    };
    vi.mocked(listMessengersChats).mockResolvedValueOnce({ items: [item as never] });
    const render = (id: string) =>
      root.render(<MessengerWorkspace account={{ id, name: id, phone: '' }} />);
    await act(async () => render('a'));
    expect(container.querySelectorAll('[data-messenger-chat]')).toHaveLength(1);

    vi.mocked(listMessengersChats).mockReturnValueOnce(new Promise(() => {}));
    await act(async () => render('b'));
    expect(container.querySelectorAll('[data-messenger-chat]')).toHaveLength(0);
  });

  it('retries a failed chat request and finds chats by username', async () => {
    vi.mocked(listMessengersChats)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        items: [
          {
            id: '1',
            chatType: 'PRIVATE',
            title: 'Ivan',
            username: 'ivan_k',
            messengerType: 'Telegram',
            externalId: '1',
            membersCount: null,
            accountMemberStatus: null,
            lastMessageDate: null,
            telegram: null,
          },
        ],
      });
    await act(async () =>
      root.render(<MessengerWorkspace account={{ id: 'a', name: 'name', phone: '' }} />),
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    const retry = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Повторити завантаження',
    );
    await act(async () => retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelectorAll('[data-messenger-chat]')).toHaveLength(1);

    const input = container.querySelector<HTMLInputElement>('[aria-label="Пошук чату"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const search = (value: string) =>
      act(() => {
        setValue.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    search('ivan_k');
    expect(container.querySelectorAll('[data-messenger-chat]')).toHaveLength(1);
    search('nobody');
    expect(container.querySelectorAll('[data-messenger-chat]')).toHaveLength(0);
  });

  it('opens a chat at a message when the media tab asks for it, but not for a request that was already there', async () => {
    const chat = {
      id: '1',
      chatType: 'PRIVATE',
      title: 'Ivan',
      messengerType: 'Telegram',
      externalId: '1',
      membersCount: null,
      accountMemberStatus: null,
      lastMessageDate: null,
      telegram: null,
    };
    vi.mocked(listMessengersChats).mockResolvedValue({ items: [chat] });
    vi.mocked(listMessengersChatMembers).mockResolvedValue({ items: [] });
    vi.mocked(listMessengersMessages).mockResolvedValue({
      items: [],
      olderCursor: null,
      newerCursor: null,
    });
    const account = { id: 'a', name: 'name', phone: '' };
    const onOpenChatChange = vi.fn();
    const render = (jumpTo?: { chatId: string; messageId: string }) =>
      act(async () =>
        root.render(
          <MessengerWorkspace
            account={account}
            jumpTo={jumpTo}
            onOpenChatChange={onOpenChatChange}
          />,
        ),
      );
    const stale = { chatId: '1', messageId: 'm0' };
    await render(stale);
    expect(listMessengersMessages).not.toHaveBeenCalled();

    await render({ chatId: '1', messageId: 'm9' });
    expect(onOpenChatChange).toHaveBeenCalledWith({ accountId: 'a', chatId: '1' });
    expect(listMessengersMessages).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '1', aroundMessageId: 'm9' }),
      expect.anything(),
    );
  });
});
