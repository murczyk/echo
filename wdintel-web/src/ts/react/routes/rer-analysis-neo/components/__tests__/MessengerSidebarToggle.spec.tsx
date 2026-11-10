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
const clipboardMock = vi.hoisted(() => ({ copyTextToClipboard: vi.fn() }));
vi.mock('../../../../../copy-to-clipboard', () => clipboardMock);

import { MessengerWorkspace } from '../MessengerWorkspace';

const account = { id: 'a1', name: 'Me', phone: '+10', username: 'me', userId: '7' };
const chat = (id: string, chatType: string, title: string, extra: object = {}) => ({
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
  ...extra,
});

describe('the account sidebar of the messenger workspace', () => {
  let container: HTMLDivElement;
  let root: Root;

  const mount = () => act(async () => root.render(<MessengerWorkspace account={account} />));
  const click = (selector: string) =>
    act(async () => {
      container
        .querySelector<HTMLElement>(selector)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  const wrapper = () => container.querySelector<HTMLElement>('[data-messenger-sidebar]')!;
  const full = () => container.querySelector<HTMLElement>('aside[aria-label="Навігація акаунту"]')!;
  const rail = () => container.querySelector<HTMLElement>('[data-messenger-sidebar-rail]')!;
  const collapse = () => click('button[aria-label="Згорнути панель акаунту"]');
  const expand = () => click('button[aria-label="Розгорнути панель акаунту"]');
  const hidden = (element: HTMLElement) =>
    element.hasAttribute('inert') && element.getAttribute('aria-hidden') === 'true';

  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(
      {},
      '',
      '/rer-analysis-neo?leftPanelTab=messenger&messengerAccount=a1',
    );
    apiMock.listMessengersChats.mockReset().mockResolvedValue({
      items: [
        chat('p1', 'PRIVATE', 'Ivan'),
        chat('p2', 'PRIVATE', 'Olena'),
        chat('g1', 'GROUP', 'Team'),
        chat('c1', 'CHANNEL', 'News'),
        chat('b1', 'PRIVATE', 'HelperBot', { isBot: true }),
      ],
    });
    apiMock.listMessengersChatMembers.mockReset().mockResolvedValue({ items: [] });
    apiMock.listMessengersMessages
      .mockReset()
      .mockResolvedValue({ items: [], olderCursor: null, newerCursor: null });
    apiMock.listMessengersContacts
      .mockReset()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/');
  });

  it('is open at first: the full sidebar is in use and the rail is out of reach', async () => {
    await mount();
    expect(wrapper().dataset.open).toBe('true');
    expect(wrapper().className).toContain('w-72');
    expect(hidden(full())).toBe(false);
    expect(hidden(rail())).toBe(true);
    expect(full().textContent).toContain('Me');
    expect(full().textContent).toContain('Team');
  });

  it('slides to a narrow box while the layers cross-fade, and back', async () => {
    await mount();
    // The width and the fade are transitions, and they are off for readers who asked for less motion.
    expect(wrapper().className).toContain('transition-[width]');
    expect(wrapper().className).toContain('motion-reduce:transition-none');
    expect(full().className).toContain('transition-opacity');

    await collapse();
    expect(wrapper().dataset.open).toBe('false');
    expect(wrapper().className).toContain('w-16');
    expect(hidden(full())).toBe(true);
    expect(hidden(rail())).toBe(false);
    // The main area is still there.
    expect(container.querySelector('[data-messenger-workspace] main')).not.toBeNull();

    await expand();
    expect(wrapper().dataset.open).toBe('true');
    expect(hidden(full())).toBe(false);
  });

  it('leads to the account cards from the avatar of the account, which names it, and does not expand', async () => {
    await mount();
    await click('[data-messenger-nav="contacts"]');
    await collapse();
    const avatar = () => container.querySelector('[data-messenger-rail-account]')!;
    expect(avatar().getAttribute('aria-label')).toContain('Me');
    expect(avatar().getAttribute('data-selected')).toBe('false');
    await click('[data-messenger-rail-account]');
    expect(avatar().getAttribute('data-selected')).toBe('true');
    expect(wrapper().dataset.open).toBe('false');
  });

  describe('on a phone', () => {
    beforeEach(() => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }));
    });
    afterEach(() => vi.unstubAllGlobals());

    it('starts as the rail, opens over the whole width and closes on a chat, without being remembered', async () => {
      await mount();
      expect(wrapper().dataset.mobile).toBe('true');
      // The chat takes the same answer from the workspace, for its tighter paddings.
      expect(
        container.querySelector<HTMLElement>('[data-messenger-workspace]')!.dataset.mobile,
      ).toBe('true');
      expect(wrapper().dataset.open).toBe('false');
      await expand();
      expect(wrapper().dataset.open).toBe('true');
      expect(wrapper().className).toContain('w-full');
      expect(wrapper().className).not.toContain('w-72');
      await click('[data-messenger-chat]');
      expect(wrapper().dataset.open).toBe('false');
      expect(window.localStorage.getItem('messenger-account-sidebar-open')).toBeNull();
    });

    it('has a narrower rail whose line meets the right edge of the panel button of the page header', async () => {
      await mount();
      // 0.75 rem of the header's padding and the 40 px button, and 2 px more that the divider needs to meet the button edge.
      expect(wrapper().className).toContain('w-[calc(3.25rem_+_2px)]');
      expect(wrapper().className).not.toContain('w-16');
      expect(wrapper().className).toContain('group/sidebar');
    });

    it('keeps the titles of a chat and of the contacts below the page title', async () => {
      await mount();
      await expand();
      await click('[data-messenger-chat]');
      const title = () => container.querySelector<HTMLElement>('[data-messenger-chat-view] h2')!;
      expect(title().className).toContain('group-data-[mobile=true]/messenger:!text-[18px]');
      expect(title().parentElement!.querySelector('svg')!.getAttribute('class')).toContain(
        '!size-[18px]',
      );
      await expand();
      await click('[data-messenger-nav="contacts"]');
      const contacts = container.querySelector<HTMLElement>('[data-messenger-contacts-view] h2')!;
      expect(contacts.className).toContain('group-data-[mobile=true]/messenger:!text-[18px]');
      // The back arrow is as big as the title text.
      expect(contacts.parentElement!.querySelector('svg')!.getAttribute('class')).toContain(
        '!size-[18px]',
      );
    });

    it('tightens the account cards: the page, the cards and the label column', async () => {
      await mount();
      const main = container.querySelector<HTMLElement>('[data-messenger-workspace] main')!;
      expect(main.className).toContain('!pt-2');
      expect(main.className).toContain('group-data-[mobile=true]/messenger:!px-1.5');
      const row = container.querySelector<HTMLElement>('[data-messenger-card] .grid')!;
      expect(row.className).toContain('grid-cols-[7rem_minmax(0,1fr)]');
    });

    it('closes on the contacts and on the account cards too', async () => {
      await mount();
      await expand();
      await click('[data-messenger-nav="contacts"]');
      expect(wrapper().dataset.open).toBe('false');
      await expand();
      await click('[data-messenger-account-avatar]');
      expect(wrapper().dataset.open).toBe('false');
    });
  });

  it('remembers that it is collapsed', async () => {
    await mount();
    await collapse();
    act(() => root.unmount());
    root = createRoot(container);
    await mount();
    expect(wrapper().dataset.open).toBe('false');

    await expand();
    act(() => root.unmount());
    root = createRoot(container);
    await mount();
    expect(wrapper().dataset.open).toBe('true');
  });

  it('keeps the open chat and the search text of the full sidebar through hiding and showing', async () => {
    await mount();
    await click('[data-messenger-chat]');
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Пошук чату"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'olen');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await collapse();
    expect(container.querySelector('[data-messenger-chat-view]')).not.toBeNull();
    await expand();
    expect(container.querySelector('[data-messenger-chat-view]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Пошук чату"]')?.value).toBe(
      'olen',
    );
  });

  describe('the rail', () => {
    const section = (key: string) =>
      container.querySelector<HTMLElement>(`[data-messenger-rail-section="${key}"]`)!;
    const sectionToggle = (key: string) =>
      container.querySelector<HTMLElement>(`[data-messenger-rail-section-toggle="${key}"]`)!;
    const openSection = (key: string) => click(`[data-messenger-rail-section-toggle="${key}"]`);

    it('shows every kind of chat as an icon with the number of its chats, closed at first', async () => {
      await mount();
      await collapse();
      for (const [key, count] of [
        ['private', 2],
        ['group', 1],
        ['channel', 1],
        ['bot', 1],
      ] as const) {
        const heading = sectionToggle(key);
        expect(heading.querySelector('svg')).not.toBeNull();
        expect(heading.textContent).toBe(String(count));
        expect(heading.getAttribute('aria-expanded')).toBe('false');
        expect(section(key).querySelector('[data-messenger-rail-chat]')).toBeNull();
      }
    });

    it('opens and closes the avatars of a kind of chat from its icon', async () => {
      await mount();
      await collapse();
      await openSection('private');
      expect(sectionToggle('private').getAttribute('aria-expanded')).toBe('true');
      expect(
        [...section('private').querySelectorAll('[data-messenger-rail-chat]')].map((button) =>
          button.getAttribute('aria-label'),
        ),
      ).toEqual(['Ivan', 'Olena']);
      expect(section('private').querySelector('[data-messenger-account-avatar]')).not.toBeNull();
      // The others stay closed.
      expect(section('group').querySelector('[data-messenger-rail-chat]')).toBeNull();

      // Closing is a transition: the avatars stay while the section folds, then they are gone.
      await openSection('private');
      expect(sectionToggle('private').getAttribute('aria-expanded')).toBe('false');
      expect(section('private').querySelector('[data-messenger-rail-chat]')).not.toBeNull();
      await vi.waitFor(() =>
        expect(section('private').querySelector('[data-messenger-rail-chat]')).toBeNull(),
      );
    });

    it('closes the list of kinds with a line, and fills a folded kind that holds the open chat', async () => {
      await mount();
      const sections = [...full().querySelectorAll('section')];
      expect(sections.at(-1)!.parentElement!.className).toContain('border-b');
      // Open the group "Team" from the full sidebar, then fold its kind there.
      const team = [...full().querySelectorAll<HTMLElement>('[data-messenger-chat]')].find(
        (button) => button.textContent?.includes('Team'),
      )!;
      await act(async () => team.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      const groups = sections[1];
      expect(groups.getAttribute('data-selected')).toBe('false');
      await act(async () =>
        groups.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
      );
      expect(groups.getAttribute('data-selected')).toBe('true');
      // The rail: the same kind folded is filled between the lines, and a line closes the last kind.
      await collapse();
      const toggle = sectionToggle('group');
      expect(toggle.getAttribute('data-selected')).toBe('true');
      expect(toggle.className).toContain('!-my-2');
      expect(toggle.className).toContain('!rounded-none');
      expect(rail().querySelector('[data-messenger-separator="sections-end"]')).not.toBeNull();
      await openSection('group');
      expect(sectionToggle('group').getAttribute('data-selected')).toBe('false');
    });

    it('does not open a kind that has no chats', async () => {
      apiMock.listMessengersChats.mockReset().mockResolvedValue({
        items: [chat('p1', 'PRIVATE', 'Ivan')],
      });
      await mount();
      await collapse();
      await openSection('channel');
      expect(sectionToggle('channel').getAttribute('aria-expanded')).toBe('false');
      expect(sectionToggle('channel').getAttribute('aria-disabled')).toBe('true');
      await openSection('private');
      expect(sectionToggle('private').getAttribute('aria-expanded')).toBe('true');
      expect(sectionToggle('private').getAttribute('aria-disabled')).toBeNull();
    });

    it('has the gallery and the contacts as icons, and the contacts open the page', async () => {
      await mount();
      await collapse();
      expect(rail().querySelector('button[aria-label="Галерея"] svg')).not.toBeNull();
      await click('[data-messenger-rail-nav="contacts"]');
      expect(container.querySelector('[data-messenger-contacts-view]')).not.toBeNull();
      expect(
        rail().querySelector('[data-messenger-rail-nav="contacts"]')?.getAttribute('data-selected'),
      ).toBe('true');
    });

    it('opens a chat from its avatar and marks the open one', async () => {
      await mount();
      await collapse();
      await openSection('group');
      await click('[data-messenger-rail-chat="g1"]');
      expect(container.querySelector('[data-messenger-chat-view]')).not.toBeNull();
      expect(
        rail().querySelector('[data-messenger-rail-chat="g1"]')?.getAttribute('data-selected'),
      ).toBe('true');
    });

    it('marks a closed kind of chat that holds the open chat, so the chat is not lost', async () => {
      await mount();
      await click('[data-messenger-chat]');
      await collapse();
      // The first chat of the full list is a private one.
      expect(sectionToggle('private').getAttribute('data-selected')).toBe('true');
      expect(sectionToggle('group').getAttribute('data-selected')).toBe('false');
      await openSection('private');
      expect(sectionToggle('private').getAttribute('data-selected')).toBe('false');
    });

    it('lights an open item in the primary color: a ring round an avatar, a tint on an icon, a bar on the edge', async () => {
      await mount();
      await collapse();
      await openSection('group');
      await click('[data-messenger-rail-chat="g1"]');
      await click('[data-messenger-rail-nav="contacts"]');
      await click('[data-messenger-rail-chat="g1"]');

      const avatar = rail().querySelector<HTMLElement>('[data-messenger-rail-chat="g1"]')!;
      // A chat sits in a slightly rounded frame: grey on hover, green when open. No ring, no outline.
      expect(avatar.className).toContain('!rounded-lg');
      expect(avatar.className).toContain('hover:bg-[color-mix(in_srgb,var(--echo-color-text');
      expect(avatar.className).toContain(
        'data-[selected=true]:bg-[color-mix(in_srgb,var(--echo-color-success',
      );
      expect(avatar.className).not.toContain('outline');
      expect(avatar.className).not.toContain('shadow');
      expect(avatar.className).not.toContain('size-10');
      // The bar on the left edge belongs to the open item and shows only while it is open.
      const holder = avatar.closest<HTMLElement>('[data-messenger-rail-row]')!;
      expect(holder.dataset.selected).toBe('true');
      expect(holder.className).toContain('data-[selected=true]:before:h-5');
      expect(holder.className).toContain('before:h-0');
      // On the edge of the rail, whatever the width of the button, so the frame of an avatar does not push it out of sight.
      expect(holder.className).toContain('before:left-0');
      expect(holder.className).toContain('w-full');

      await click('[data-messenger-rail-nav="contacts"]');
      const contacts = rail().querySelector<HTMLElement>('[data-messenger-rail-nav="contacts"]')!;
      // The icon buttons are rounded squares that go grey on hover.
      expect(contacts.className).toContain('!rounded-lg');
      expect(contacts.className).not.toContain('rounded-full');
      expect(contacts.className).toContain('hover:bg-[color-mix(in_srgb,var(--echo-color-text');
      expect(contacts.className).toContain(
        'data-[selected=true]:bg-[color-mix(in_srgb,var(--echo-color-primary',
      );
      expect(contacts.className).toContain('data-[selected=true]:text-[var(--echo-color-primary');
      expect(contacts.closest<HTMLElement>('[data-messenger-rail-row]')!.dataset.selected).toBe(
        'true',
      );
      expect(avatar.closest<HTMLElement>('[data-messenger-rail-row]')!.dataset.selected).toBe(
        'false',
      );
    });

    it('has the unread filter and "read all" as icons that do nothing yet', async () => {
      await mount();
      await collapse();
      const unread = rail().querySelector<HTMLButtonElement>('[data-messenger-rail-unread]')!;
      const readAll = rail().querySelector<HTMLButtonElement>('[data-messenger-rail-read-all]')!;
      expect(unread.disabled).toBe(true);
      expect(readAll.disabled).toBe(true);
      expect(unread.getAttribute('aria-label')).toBe('Лише непрочитані');
      expect(readAll.getAttribute('aria-label')).toBe('Прочитати всі');
    });

    it('does not list chats while they load or when the load failed', async () => {
      apiMock.listMessengersChats.mockReset().mockRejectedValue(new Error('offline'));
      await mount();
      await collapse();
      expect(rail().querySelector('[data-messenger-rail-section]')).toBeNull();
    });

    it('has no toggle of its own: the top is kept free for the floating one, then the avatar of the account', async () => {
      await mount();
      await collapse();
      expect(rail().querySelector('button[aria-label="Розгорнути панель акаунту"]')).toBeNull();
      expect(rail().className).toContain('top-12');
      expect(rail().children[0].querySelector('[data-messenger-account-avatar]')).not.toBeNull();
    });

    it('keeps the icon, the number and the chevron of a kind of chat on one line', async () => {
      await mount();
      await collapse();
      const header = container.querySelector<HTMLElement>(
        '[data-messenger-rail-section-toggle="private"]',
      )!;
      expect(header.className).toContain('items-center');
      expect(header.className).not.toContain('flex-col');
      expect(header.className).toContain('whitespace-nowrap');
      expect([...header.children].map((child) => child.tagName.toLowerCase())).toEqual([
        'svg',
        'span',
        'svg',
      ]);
    });
  });

  describe('the full sidebar', () => {
    it('cuts the kinds of chat off from each other with a line and gives each an icon', async () => {
      await mount();
      const sections = [...full().querySelectorAll('section')];
      expect(sections).toHaveLength(4);
      for (const item of sections) {
        expect(item.className).toContain('border-t');
        expect(item.querySelector('button svg')).not.toBeNull();
      }
    });

    it('keeps everything one rem from the border, and the rows that light up inset with room inside', async () => {
      await mount();
      // The account info, the search and the unread row start 1 rem in ...
      const info = full().querySelector('[data-messenger-user-id]')!.closest('.flex.items-center')!;
      expect(info.className).toContain('px-4');
      expect(
        full().querySelector('input[aria-label="Пошук чату"]')!.closest('.px-4'),
      ).not.toBeNull();
      expect(full().querySelector('[data-messenger-unread-row]')!.className).toContain('px-4');
      // ... and so do the contents of the rows that light up, which are themselves inset, so a lit row does not touch the border.
      const nav = full().querySelector('nav')!;
      expect(nav.className).toContain('px-2');
      for (const button of nav.querySelectorAll('button'))
        expect(button.className).toContain('!px-2');
      expect(nav.querySelector('[data-messenger-nav="contacts"]')!.className).toContain(
        '!rounded-lg',
      );
      const list = full().querySelector('section ul')!;
      expect(list.className).toContain('px-2');
      expect(list.querySelector('[data-messenger-chat]')!.className).toContain('!px-2');
    });

    it('leaves room under the last row of a kind of chat and under an empty one, before the next line', async () => {
      apiMock.listMessengersChats.mockReset().mockResolvedValue({
        items: [chat('p1', 'PRIVATE', 'Ivan')],
      });
      await mount();
      const sections = [...full().querySelectorAll('section')];
      // A list ends with room before the line of the next kind ...
      expect(sections[0].querySelector('ul')!.className).toContain('pb-2');
      // ... and so does an empty one.
      expect(sections[1].querySelector('p')!.className).toContain('pb-3');
      // The first line is set off from the unread row by the gap of the sidebar, not pulled up against it.
      expect(sections[0].parentElement!.className).not.toContain('-mt-2');
    });

    it('keeps a slight gap between the lit rows: the pages and the chats', async () => {
      await mount();
      expect(full().querySelector('nav')!.className).toContain('gap-1');
      expect(full().querySelector('section ul')!.className).toContain('gap-1');
    });

    it('has a line between the account info and the pages, and between the pages and the search', async () => {
      await mount();
      const lines = [...full().querySelectorAll('[data-messenger-separator]')].map((line) =>
        line.getAttribute('data-messenger-separator'),
      );
      expect(lines).toEqual(['account-pages', 'pages-search']);
      const order = [...full().children].map(
        (child) => child.getAttribute('data-messenger-separator') ?? child.tagName.toLowerCase(),
      );
      // info, line, pages, line, search.
      const at = (name: string) => order.indexOf(name);
      expect(at('account-pages')).toBeLessThan(at('nav'));
      expect(at('nav')).toBeLessThan(at('pages-search'));
    });

    it('marks the open page like the open chat, and only that one', async () => {
      await mount();
      const contacts = () => full().querySelector<HTMLElement>('[data-messenger-nav="contacts"]')!;
      const gallery = () => full().querySelector<HTMLElement>('[data-messenger-nav="gallery"]')!;
      expect(contacts().dataset.selected).toBe('false');
      await click('[data-messenger-nav="contacts"]');
      expect(contacts().dataset.selected).toBe('true');
      expect(contacts().getAttribute('aria-current')).toBe('true');
      // The same background as an open chat row.
      expect(contacts().className).toContain('data-[selected=true]:bg-[color-mix');
      expect(gallery().dataset.selected).toBe('false');
      // A chat takes the mark.
      await click('[data-messenger-chat]');
      expect(contacts().dataset.selected).toBe('false');
    });

    it('has the unread filter and "read all" under the search, taking their place and doing nothing yet', async () => {
      await mount();
      const row = full().querySelector('[data-messenger-unread-row]')!;
      expect(row.textContent).toContain('Лише непрочитані');
      const toggle = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      expect(toggle.disabled).toBe(true);
      expect(toggle.checked).toBe(false);
      expect(
        row.querySelector<HTMLButtonElement>('button[aria-label="Прочитати всі"]')?.disabled,
      ).toBe(true);
      const search = full().querySelector('input[aria-label="Пошук чату"]')!;
      expect(search.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('floats the toggle over the top right of the account info instead of squashing the names', async () => {
      await mount();
      const toggle = wrapper().querySelector<HTMLElement>('[data-messenger-sidebar-toggle]')!;
      // One button, over both layers and first in the document, not inside the account info or by the search.
      expect(wrapper().querySelectorAll('[data-messenger-sidebar-toggle]')).toHaveLength(1);
      expect(wrapper().firstElementChild).toBe(toggle);
      expect(toggle.className).toContain('absolute');
      expect(toggle.className).toContain('z-10');
      expect(full().contains(toggle)).toBe(false);
      // The first two lines of the account info keep clear of it, the rest of the lines have the whole width.
      const lines = [...full().querySelectorAll('[data-messenger-user-id]')].map(
        (line) => line.className,
      );
      expect(lines.join(' ')).not.toContain('max-w-');
      const name = [...full().querySelectorAll('button')].find(
        (button) => button.textContent === 'Me',
      )!;
      expect(name.className).toContain('max-w-');
    });

    it('slides the toggle along to the top of the rail and back', async () => {
      await mount();
      const toggle = () => wrapper().querySelector<HTMLElement>('[data-messenger-sidebar-toggle]')!;
      expect(toggle().className).toContain('right-2');
      expect(toggle().className).toContain('transition-[right]');
      expect(toggle().className).toContain('motion-reduce:transition-none');
      await collapse();
      expect(toggle().className).toContain('right-[calc((4rem_-_32px)_/_2)]');
      expect(toggle().querySelector('button')?.getAttribute('aria-label')).toBe(
        'Розгорнути панель акаунту',
      );
      await expand();
      expect(toggle().className).toContain('right-2');
    });

    it('has a line between the account info and the pages, and between the pages and the search', async () => {
      await mount();
      const lines = [...full().querySelectorAll('[data-messenger-separator]')].map((line) =>
        line.getAttribute('data-messenger-separator'),
      );
      expect(lines).toEqual(['account-pages', 'pages-search']);
      const order = [...full().children].map(
        (child) => child.getAttribute('data-messenger-separator') ?? child.tagName.toLowerCase(),
      );
      // info, line, pages, line, search.
      const at = (name: string) => order.indexOf(name);
      expect(at('account-pages')).toBeLessThan(at('nav'));
      expect(at('nav')).toBeLessThan(at('pages-search'));
    });

    it('marks the open page like the open chat, and only that one', async () => {
      await mount();
      const contacts = () => full().querySelector<HTMLElement>('[data-messenger-nav="contacts"]')!;
      const gallery = () => full().querySelector<HTMLElement>('[data-messenger-nav="gallery"]')!;
      expect(contacts().dataset.selected).toBe('false');
      await click('[data-messenger-nav="contacts"]');
      expect(contacts().dataset.selected).toBe('true');
      expect(contacts().getAttribute('aria-current')).toBe('true');
      // The same background as an open chat row.
      expect(contacts().className).toContain('data-[selected=true]:bg-[color-mix');
      expect(gallery().dataset.selected).toBe('false');
      // A chat takes the mark.
      await click('[data-messenger-chat]');
      expect(contacts().dataset.selected).toBe('false');
    });

    it('has the unread filter and "read all" under the search, taking their place and doing nothing yet', async () => {
      await mount();
      const row = full().querySelector('[data-messenger-unread-row]')!;
      expect(row.textContent).toContain('Лише непрочитані');
      const toggle = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      expect(toggle.disabled).toBe(true);
      expect(toggle.checked).toBe(false);
      expect(
        row.querySelector<HTMLButtonElement>('button[aria-label="Прочитати всі"]')?.disabled,
      ).toBe(true);
      const search = full().querySelector('input[aria-label="Пошук чату"]')!;
      expect(search.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('copies the id from the whole line, label included', async () => {
      clipboardMock.copyTextToClipboard.mockResolvedValue(undefined);
      await mount();
      const line = full().querySelector('[data-messenger-user-id]')!;
      expect(line.tagName).toBe('BUTTON');
      expect(line.textContent).toBe('User ID: 7');
      await click('[data-messenger-user-id]');
      expect(clipboardMock.copyTextToClipboard).toHaveBeenCalledWith('7');
    });

    it('leads back to the account cards from a blank area of the account info, not from a copy value', async () => {
      await mount();
      await click('[data-messenger-nav="contacts"]');
      const contacts = () => full().querySelector('[data-messenger-nav="contacts"]')!;
      expect(contacts().getAttribute('data-selected')).toBe('true');
      await click('[data-messenger-user-id]');
      expect(contacts().getAttribute('data-selected')).toBe('true');
      const info = () =>
        full().querySelector('[data-messenger-user-id]')!.closest('.flex.items-center')!;
      expect(info().getAttribute('data-selected')).toBe('false');
      await click('[data-messenger-account-avatar]');
      expect(contacts().getAttribute('data-selected')).toBe('false');
      expect(info().getAttribute('data-selected')).toBe('true');
    });

    it('keeps the toggle out of the account info, so the names have the whole width', async () => {
      await mount();
      const info = full().querySelector('[data-messenger-user-id]')!.closest('.flex.items-center')!;
      expect(info.querySelector('button[aria-label="Згорнути панель акаунту"]')).toBeNull();
      // It sits in the row above, not by the search.
      const search = full().querySelector('input[aria-label="Пошук чату"]')!.closest('.px-4')!;
      expect(search.querySelector('button[aria-label="Згорнути панель акаунту"]')).toBeNull();
    });
  });
});
