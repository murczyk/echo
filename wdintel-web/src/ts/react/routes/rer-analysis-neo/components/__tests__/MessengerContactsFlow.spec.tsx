/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  listMessengersChats: vi.fn(),
  listMessengersChatMembers: vi.fn(),
  listMessengersMessages: vi.fn(),
  listMessengersContacts: vi.fn(),
}));
vi.mock('../../../../services/api/analysis-messengers', () => apiMock);

import { MessengerWorkspace } from '../MessengerWorkspace';

const account = { id: 'a1', name: 'Me', phone: '' };
const contactsPage = {
  items: [
    {
      id: 'c1',
      messengerType: 'Telegram',
      externalId: 'c1',
      username: 'masu',
      firstName: 'Сестра',
      lastName: 'Раи',
      phone: '7952',
      isMutual: null,
      isCloseFriend: null,
      createdAt: 0,
      updatedAt: 0,
      telegram: { userId: '333' },
    },
  ],
  total: 1,
  page: 1,
  pageSize: 100,
};

describe('messenger contacts in the workspace', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onBusyChange = vi.fn();

  const mount = () =>
    act(async () =>
      root.render(
        <MessengerWorkspace account={account} onBusyChange={onBusyChange} refreshToken={0} />,
      ),
    );
  const click = (selector: string) =>
    act(async () => {
      container
        .querySelector<HTMLElement>(selector)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  const contactsNav = () => container.querySelector<HTMLElement>('[data-messenger-nav="contacts"]');

  beforeEach(() => {
    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=a1',
    );
    // The table virtualizes its rows, see MessengerContactsView.spec.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const height = this.classList.contains('MuiTableContainer-root') ? 300 : 37;
      return {
        width: 1000,
        height,
        top: 0,
        left: 0,
        bottom: height,
        right: 1000,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100000);
    apiMock.listMessengersChats.mockReset().mockResolvedValue({
      items: [
        {
          id: 'g1',
          chatType: 'GROUP',
          title: 'Team',
          messengerType: 'Telegram',
          externalId: 'g1',
          username: null,
          membersCount: null,
          accountMemberStatus: null,
          lastMessageDate: null,
          telegram: null,
          oldestReadAt: null,
          newestReadAt: null,
          unreadCount: 0,
          totalCount: 0,
        },
      ],
    });
    apiMock.listMessengersChatMembers.mockReset().mockResolvedValue({ items: [] });
    apiMock.listMessengersMessages
      .mockReset()
      .mockResolvedValue({ items: [], olderCursor: null, newerCursor: null });
    apiMock.listMessengersContacts.mockReset().mockResolvedValue(contactsPage);
    onBusyChange.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    act(() => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/');
  });

  it('opens the contacts from the sidebar, keeps them in the URL and goes back', async () => {
    await mount();
    expect(container.querySelector('[data-messenger-contacts-view]')).toBeNull();
    expect(apiMock.listMessengersContacts).not.toHaveBeenCalled();

    await click('[data-messenger-nav="contacts"]');
    expect(container.querySelector('[data-messenger-contacts-view]')).not.toBeNull();
    expect(container.textContent).toContain('Сестра Раи');
    expect(contactsNav()?.getAttribute('data-selected')).toBe('true');
    expect(window.location.search).toContain('messengerView=contacts');

    await click('button[aria-label="Назад до акаунта"]');
    expect(container.querySelector('[data-messenger-contacts-view]')).toBeNull();
    expect(contactsNav()?.getAttribute('data-selected')).toBe('false');
    expect(window.location.search).not.toContain('messengerView');
  });

  it('starts the contacts table clean and leaves nothing of it in the URL', async () => {
    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=a1&globalFilter=from-the-summary-table',
    );
    await mount();
    await click('[data-messenger-nav="contacts"]');
    expect(window.location.search).not.toContain('globalFilter');

    // The search of the table goes to the URL ...
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Пошук контактів"]',
      )!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'masu');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(window.location.search).toContain('globalFilter=masu');

    // ... and is gone when the contacts are left.
    await click('button[aria-label="Назад до акаунта"]');
    expect(window.location.search).not.toContain('globalFilter');
  });

  it('keeps the table state of a shared link to the contacts', async () => {
    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=a1&messengerView=contacts&globalFilter=masu',
    );
    await mount();
    expect(window.location.search).toContain('globalFilter=masu');
  });

  it('opens at the contacts from a shared link', async () => {
    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=a1&messengerView=contacts',
    );
    await mount();
    expect(container.querySelector('[data-messenger-contacts-view]')).not.toBeNull();
    expect(contactsNav()?.getAttribute('data-selected')).toBe('true');
  });

  it('gives way to a chat and takes the place of an open chat', async () => {
    await mount();
    await click('[data-messenger-nav="contacts"]');
    await click('[data-messenger-chat]');
    expect(container.querySelector('[data-messenger-contacts-view]')).toBeNull();
    expect(container.querySelector('[data-messenger-chat-view]')).not.toBeNull();
    expect(window.location.search).not.toContain('messengerView');

    await click('[data-messenger-nav="contacts"]');
    expect(container.querySelector('[data-messenger-chat-view]')).toBeNull();
    expect(container.querySelector('[data-messenger-contacts-view]')).not.toBeNull();
    expect(window.location.search).not.toContain('messengerChat');
  });

  it('counts the contacts request in the busy state of the workspace', async () => {
    let resolve!: (value: unknown) => void;
    apiMock.listMessengersContacts.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await mount();
    await click('[data-messenger-nav="contacts"]');
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    await act(async () => resolve(contactsPage));
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });
});
