/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessengersChatMemberItem } from '../../../../../../Bindings';

const apiMock = vi.hoisted(() => ({
  listMessengersChatMembers: vi.fn(),
  listMessengersAttachments: vi.fn(),
  countMessengersAttachments: vi.fn(),
}));
vi.mock('../../../../services/api/analysis-messengers', () => apiMock);

import { MessengerRightPanel } from '../MessengerRightPanel';

const member = (
  id: string,
  firstName: string | null,
  deleted = false,
): MessengersChatMemberItem => ({
  id,
  messengerType: 'Telegram',
  externalId: id,
  username: `${id}_user`,
  firstName,
  lastName: null,
  phone: null,
  isBot: null,
  role: null,
  joinedDate: null,
  deleted,
  telegram: { userId: `tg${id}` },
});

describe('MessengerRightPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  const text = () => container.textContent ?? '';
  // The panel opens on the media tab unless the URL names another; most tests here are about the members.
  const mount = (tab: string | null = 'members') => {
    window.history.replaceState(
      {},
      '',
      `/rer-analysis-neo?messengerAccount=a1${tab == null ? '' : `&messengerPanel=${tab}`}`,
    );
    return act(async () =>
      root.render(
        <MessengerRightPanel chat={{ accountId: 'a1', chatId: 'c1' }} onClose={vi.fn()} />,
      ),
    );
  };

  beforeEach(() => {
    window.history.replaceState({}, '', '/rer-analysis-neo');
    window.localStorage.clear();
    // The table virtualizes its rows, which needs a layout that happy-dom does not have.
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
    apiMock.listMessengersChatMembers.mockReset();
    apiMock.listMessengersAttachments.mockReset();
    apiMock.countMessengersAttachments.mockReset().mockResolvedValue({ items: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
    act(() => root.unmount());
    container.remove();
  });

  it('opens on the members of the chat and marks a deleted one', async () => {
    apiMock.listMessengersChatMembers.mockResolvedValueOnce({
      items: [member('1', 'Вадим'), member('2', 'Самира', true)],
    });
    await mount();
    expect(apiMock.listMessengersChatMembers).toHaveBeenCalledWith(
      { accountId: 'a1', chatId: 'c1' },
      expect.anything(),
    );
    expect(text()).toContain('Вадим');
    expect(text()).toContain('Самира (видалено)');
    expect(text()).toContain('tg1');
    // Wide enough: the column menus are there.
    expect(container.querySelector('[aria-label="Дії стовпця"]')).not.toBeNull();
  });

  it('marks a deleted member that has no name', async () => {
    apiMock.listMessengersChatMembers.mockResolvedValueOnce({
      items: [member('1', null, true)],
    });
    await mount();
    expect(text()).toContain('Без імені (видалено)');
  });

  it('goes dense on a narrow panel: no column menus', async () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const height = this.classList.contains('MuiTableContainer-root') ? 300 : 37;
      const width = this.tagName === 'SECTION' ? 360 : 1000;
      return {
        width,
        height,
        top: 0,
        left: 0,
        bottom: height,
        right: width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    });
    apiMock.listMessengersChatMembers.mockResolvedValueOnce({ items: [member('1', 'Вадим')] });
    await mount();
    expect(text()).toContain('Вадим');
    expect(container.querySelector('[aria-label="Дії стовпця"]')).toBeNull();
  });

  const emptyGallery = () =>
    apiMock.listMessengersAttachments.mockResolvedValue({
      items: [],
      olderCursor: null,
      newerCursor: null,
    });
  const clickTab = (label: string) =>
    act(async () =>
      [...container.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find((tab) => tab.textContent === label)
        ?.click(),
    );

  it('opens on the media tab, shows the gallery of the chat and puts the tab in the URL', async () => {
    emptyGallery();
    await mount(null);
    expect(window.location.search).toContain('messengerPanel=media');
    expect(apiMock.listMessengersChatMembers).not.toHaveBeenCalled();
    expect(apiMock.listMessengersAttachments).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'a1', chatId: 'c1' }),
      expect.anything(),
    );
    expect(container.querySelector('[data-messenger-gallery]')).not.toBeNull();
  });

  it('keeps the gallery mounted behind the members, and asks for the members only once they are shown', async () => {
    emptyGallery();
    apiMock.listMessengersChatMembers.mockResolvedValue({ items: [] });
    await mount(null);
    const gallery = container.querySelector('[data-messenger-gallery]');
    expect(apiMock.listMessengersChatMembers).not.toHaveBeenCalled();
    const callsBefore = apiMock.listMessengersAttachments.mock.calls.length;

    await clickTab('Учасники');
    expect(apiMock.listMessengersChatMembers).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-messenger-gallery]')).toBe(gallery);
    expect(gallery?.parentElement?.className).toContain('invisible');

    await clickTab('Медіа');
    expect(container.querySelector('[data-messenger-gallery]')).toBe(gallery);
    expect(gallery?.parentElement?.className).not.toContain('invisible');
    expect(apiMock.listMessengersAttachments.mock.calls).toHaveLength(callsBefore);
  });

  it('does not load the gallery of a link that opens on the members until it is shown', async () => {
    emptyGallery();
    apiMock.listMessengersChatMembers.mockResolvedValue({ items: [] });
    await mount('members');
    expect(container.querySelector('[data-messenger-gallery]')).toBeNull();
    expect(apiMock.listMessengersAttachments).not.toHaveBeenCalled();
    await clickTab('Медіа');
    expect(container.querySelector('[data-messenger-gallery]')).not.toBeNull();
  });

  it('follows the tab in the URL, opens the tab a link names, and strips it when the panel closes', async () => {
    emptyGallery();
    apiMock.listMessengersChatMembers.mockResolvedValue({ items: [] });
    await mount('members');
    expect(window.location.search).toContain('messengerPanel=members');
    await clickTab('Медіа');
    expect(window.location.search).toContain('messengerPanel=media');
    await clickTab('Учасники');
    expect(window.location.search).toContain('messengerPanel=members');
    expect(window.location.search).toContain('messengerAccount=a1');

    act(() => root.unmount());
    expect(window.location.search).not.toContain('messengerPanel');
    expect(window.location.search).toContain('messengerAccount=a1');
    root = createRoot(container);
  });

  it('says so when the members do not load', async () => {
    apiMock.listMessengersChatMembers.mockRejectedValueOnce(new Error('boom'));
    await mount();
    expect(text()).toContain('Повторити завантаження');
  });
});
