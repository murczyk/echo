/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessengersContactItem } from '../../../../../../Bindings';

const apiMock = vi.hoisted(() => ({ listMessengersContacts: vi.fn() }));
vi.mock('../../../../services/api/analysis-messengers', () => apiMock);

const downloadMock = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock('../../../../utils/download-blob', () => downloadMock);

import { MessengerContactsView } from '../MessengerContactsView';

const contact = (
  id: string,
  firstName: string | null,
  userId: string,
  avatarUrl: string | null = null,
): MessengersContactItem => ({
  id,
  messengerType: 'Telegram',
  externalId: id,
  username: `${id}_user`,
  firstName,
  lastName: null,
  phone: `7${id}`,
  isMutual: null,
  isCloseFriend: null,
  createdAt: 0,
  updatedAt: 0,
  avatarUrl,
  telegram: { userId },
});

const page = (items: MessengersContactItem[], total = items.length) => ({
  items,
  total,
  page: 1,
  pageSize: 100,
});

describe('MessengerContactsView', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onBack = vi.fn();
  const onBusyChange = vi.fn();

  const mount = () =>
    act(async () =>
      root.render(
        <MessengerContactsView
          account={{ id: 'a1', name: 'Me', phone: '+10', userId: 'me' }}
          onBack={onBack}
          onBusyChange={onBusyChange}
        />,
      ),
    );
  const text = () => container.textContent ?? '';
  const type = (value: string) =>
    act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[placeholder="Пошук"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

  beforeEach(() => {
    // The table keeps its sorting, filters and hidden columns in the URL and in the local storage.
    window.history.replaceState({}, '', '/rer-analysis-neo');
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
    // The table virtualizes its rows, which needs a layout that happy-dom does not have: a tall scroller, rows
    // of a fixed height, and plenty left to scroll, so no next page is asked for without a scroll.
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
    apiMock.listMessengersContacts.mockReset();
    downloadMock.downloadBlob.mockReset();
    onBack.mockReset();
    onBusyChange.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    delete (window as { localStorage?: Storage }).localStorage;
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
    act(() => root.unmount());
    container.remove();
  });

  it('shows the toolbar, the account itself and its contacts', async () => {
    apiMock.listMessengersContacts.mockResolvedValueOnce(
      page([contact('c1', 'Сестра', '333'), contact('c2', null, '444')]),
    );
    await mount();
    expect(text()).toContain('Контакти акаунту');
    expect(container.querySelector('[data-messenger-contacts-export]')).not.toBeNull();
    for (const header of ["Ім'я", 'User ID', 'Username', 'Телефон'])
      expect(text()).toContain(header);
    expect(text()).toContain('Me');
    expect(text()).toContain('Сестра');
    expect(text()).toContain('@c1_user');
    // A contact without a name is marked, not left blank.
    expect(text()).toContain('Без імені');
  });

  it('shows the avatar of a contact before its name, the initials when it has none', async () => {
    apiMock.listMessengersContacts.mockResolvedValueOnce(
      page([
        contact('c1', 'Сестра', '333', '/api/messengers/avatars/av1'),
        contact('c2', 'Брат', '444'),
      ]),
    );
    await mount();
    const avatars = [...container.querySelectorAll('[data-messenger-account-avatar]')];
    const avatarOf = (name: string) =>
      avatars.find((avatar) => avatar.parentElement?.textContent?.includes(name));
    expect(avatarOf('Сестра')?.querySelector('img')?.getAttribute('src')).toBe(
      '/api/messengers/avatars/av1',
    );
    expect(avatarOf('Брат')?.querySelector('img')).toBeNull();
    expect(avatarOf('Брат')?.textContent).toBe('Б');
  });

  it('closes the last row with a bottom border that beats the shared rule that removes it', async () => {
    apiMock.listMessengersContacts.mockResolvedValueOnce(page([contact('c1', 'Сестра', '333')]));
    await mount();
    // happy-dom does not weigh selectors, so the stylesheet itself is checked: the shared container styles take the
    // border off the last row with `:last-child` and `:last-of-type`, and only a more specific selector wins.
    const css = [...document.querySelectorAll('style')]
      .map((style) => style.textContent)
      .join('\n')
      .replace(/\s+/g, '');
    expect(css).toContain(
      'MuiTableRow-root:last-child:last-of-type>.MuiTableCell-root{border-bottom:1pxsolidvar(--bs-border-color);}',
    );
  });

  it('goes back to the account', async () => {
    apiMock.listMessengersContacts.mockResolvedValueOnce(page([]));
    await mount();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Назад до акаунта"]')?.click(),
    );
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('reports the busy state for the header refresh', async () => {
    let resolve!: (value: unknown) => void;
    apiMock.listMessengersContacts.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await mount();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    await act(async () => resolve(page([contact('c1', 'A', '1')])));
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('shows a failed load with a retry', async () => {
    apiMock.listMessengersContacts
      .mockRejectedValueOnce(new Error('forbidden'))
      .mockResolvedValueOnce(page([contact('c1', 'Сестра', '333')]));
    await mount();
    expect(text()).toContain('forbidden');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Повторити завантаження')
        ?.click(),
    );
    expect(text()).not.toContain('forbidden');
    expect(text()).toContain('Сестра');
  });

  it('goes on loading the rest after a retry when a filter needs every contact', async () => {
    window.history.replaceState(
      {},
      '',
      `/rer-analysis-neo?columnFilters=${encodeURIComponent(JSON.stringify([{ id: 'username', value: 'a' }]))}`,
    );
    const hundred = (prefix: string) =>
      Array.from({ length: 100 }, (_, i) => contact(`${prefix}${i}`, `F${i}`, `${prefix}${i}`));
    apiMock.listMessengersContacts
      .mockResolvedValueOnce(page(hundred('a'), 250))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page(hundred('b'), 250))
      .mockResolvedValueOnce(page(hundred('c').slice(0, 50), 250));
    await mount();
    await vi.waitFor(() => expect(text()).toContain('offline'));
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Повторити завантаження')
        ?.click(),
    );
    await vi.waitFor(() => expect(apiMock.listMessengersContacts).toHaveBeenCalledTimes(4));
    expect(text()).not.toContain('offline');
  });

  it('filters by name, username and phone', async () => {
    apiMock.listMessengersContacts.mockResolvedValueOnce(
      page([contact('c1', 'Сестра', '333'), contact('c2', 'Паша', '444')]),
    );
    await mount();
    await type('паша');
    expect(text()).toContain('Паша');
    expect(text()).not.toContain('Сестра');
    await type('7c1');
    expect(text()).toContain('Сестра');
    expect(text()).not.toContain('Паша');
  });

  it('loads every page before it searches', async () => {
    const first = Array.from({ length: 100 }, (_, i) => contact(`a${i}`, `First${i}`, `${i}`));
    apiMock.listMessengersContacts
      .mockResolvedValueOnce(page(first, 101))
      .mockResolvedValueOnce(page([contact('z', 'Яким', '999')], 101));
    await mount();
    await type('яким');
    expect(apiMock.listMessengersContacts).toHaveBeenCalledTimes(2);
    expect(text()).toContain('Яким');
  });

  describe('select all', () => {
    const selectAll = () =>
      act(async () =>
        container.querySelector<HTMLInputElement>('thead input[type="checkbox"]')?.click(),
      );
    const selectedCount = async () => {
      await act(async () =>
        container.querySelector<HTMLElement>('[data-messenger-contacts-export]')?.click(),
      );
      const label = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
        /CSV: вибрані/.test(item.textContent ?? ''),
      )?.textContent;
      await act(async () => document.body.click());
      return label;
    };

    it('selects the loaded rows only, without asking for the other pages, and clears them again', async () => {
      const first = Array.from({ length: 100 }, (_, i) => contact(`a${i}`, `First${i}`, `${i}`));
      apiMock.listMessengersContacts.mockResolvedValueOnce(page(first, 250));
      await mount();
      await selectAll();
      // The account itself and the 100 loaded contacts.
      expect(await selectedCount()).toContain('(101)');
      expect(apiMock.listMessengersContacts).toHaveBeenCalledTimes(1);
      await selectAll();
      expect(await selectedCount()).toContain('(0)');
    });
  });

  describe('sorting, filters and hidden columns', () => {
    const header = (label: string) =>
      [...container.querySelectorAll('thead th')].find((cell) => cell.textContent?.includes(label));
    const bodyRows = () =>
      [...container.querySelectorAll('tbody tr')].map((row) => row.textContent);

    it('sorts by a column, with every contact loaded first', async () => {
      const first = Array.from({ length: 100 }, (_, i) => contact(`a${i}`, `First${i}`, `${i}`));
      apiMock.listMessengersContacts
        .mockResolvedValueOnce(page(first, 101))
        .mockResolvedValueOnce(page([contact('z', 'Aaa', '999')], 101));
      await mount();
      expect(apiMock.listMessengersContacts).toHaveBeenCalledTimes(1);

      await act(async () =>
        header("Ім'я")?.querySelector<HTMLElement>('[aria-label^="Сортувати"]')?.click(),
      );
      await vi.waitFor(() => expect(apiMock.listMessengersContacts).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(bodyRows()[0]).toContain('Aaa'));
      expect(window.location.search).toContain('sorting=');
    });

    it('filters a column from the filter in the URL', async () => {
      window.history.replaceState(
        {},
        '',
        `/rer-analysis-neo?columnFilters=${encodeURIComponent(JSON.stringify([{ id: 'username', value: 'c2' }]))}`,
      );
      apiMock.listMessengersContacts.mockResolvedValueOnce(
        page([contact('c1', 'Сестра', '333'), contact('c2', 'Паша', '444')]),
      );
      await mount();
      expect(text()).toContain('Паша');
      expect(text()).not.toContain('Сестра');
    });

    it('hides a column from its menu', async () => {
      apiMock.listMessengersContacts.mockResolvedValueOnce(page([contact('c1', 'Сестра', '333')]));
      await mount();
      expect(header('Username')).toBeDefined();
      await act(async () =>
        header('Username')?.querySelector<HTMLElement>('[aria-label="Дії стовпця"]')?.click(),
      );
      await act(async () =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
          .find((item) => /Приховати/.test(item.textContent ?? ''))
          ?.click(),
      );
      expect(header('Username')).toBeUndefined();
      expect(header("Ім'я")).toBeDefined();
    });

    it('offers no sorting, filter or hiding for the selection column', async () => {
      apiMock.listMessengersContacts.mockResolvedValueOnce(page([contact('c1', 'Сестра', '333')]));
      await mount();
      const selectCell = container.querySelector('thead th')!;
      expect(selectCell.querySelector('[aria-label^="Сортувати"]')).toBeNull();
      expect(selectCell.querySelector('[aria-label^="Фільтрувати"]')).toBeNull();
      expect(selectCell.querySelector('[aria-label="Дії стовпця"]')).toBeNull();
    });

    it('ignores the sorting and filters of another table in the URL', async () => {
      window.history.replaceState(
        {},
        '',
        `/rer-analysis-neo?sorting=${encodeURIComponent(JSON.stringify([{ id: 'freq', desc: true }]))}&columnFilters=${encodeURIComponent(JSON.stringify([{ id: 'freq', value: 'x' }]))}`,
      );
      apiMock.listMessengersContacts.mockResolvedValueOnce(page([contact('c1', 'Сестра', '333')]));
      await mount();
      expect(text()).toContain('Сестра');
    });
  });

  describe('export', () => {
    // Opens the export menu and picks an item, e.g. `CSV: усі (102)`.
    const exportWith = async (item: RegExp) => {
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[data-messenger-contacts-export]')?.click(),
      );
      await act(async () =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
          .find((element) => item.test(element.textContent ?? ''))
          ?.click(),
      );
    };

    it('downloads every contact as CSV, the account included, from a fresh pass over all pages', async () => {
      const first = Array.from({ length: 100 }, (_, i) => contact(`a${i}`, `First${i}`, `${i}`));
      const second = [contact('z', 'Яким', '999')];
      apiMock.listMessengersContacts
        // The list on screen.
        .mockResolvedValueOnce(page(first, 101))
        // The export: page 1 again, then page 2.
        .mockResolvedValueOnce(page(first, 101))
        .mockResolvedValueOnce(page(second, 101));
      await mount();
      await exportWith(/CSV: усі \(102\)/);

      await vi.waitFor(() => expect(downloadMock.downloadBlob).toHaveBeenCalledTimes(1));
      expect(apiMock.listMessengersContacts).toHaveBeenCalledTimes(3);
      expect(apiMock.listMessengersContacts).toHaveBeenNthCalledWith(
        2,
        { accountId: 'a1', page: 1, limit: 100 },
        expect.anything(),
      );
      const [blob, fileName] = downloadMock.downloadBlob.mock.calls[0];
      expect(fileName).toBe('contacts_account_a1.csv');
      const csv = await (blob as Blob).text();
      expect(csv.split('\n')).toHaveLength(1 + 102);
      expect(csv).toContain('Яким');
    });

    it('downloads only the selected rows as XLSX', async () => {
      apiMock.listMessengersContacts.mockResolvedValueOnce(
        page([contact('c1', 'Сестра', '333'), contact('c2', 'Паша', '444')]),
      );
      await mount();
      await act(async () =>
        container.querySelector<HTMLElement>('[data-messenger-contacts-export]')?.click(),
      );
      // Nothing is selected yet.
      const selected = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => /вибрані/.test(item.textContent ?? ''),
      );
      expect(selected?.getAttribute('aria-disabled')).toBe('true');
      await act(async () => document.body.click());

      const checkboxes = container.querySelectorAll<HTMLInputElement>(
        'tbody input[type="checkbox"]',
      );
      await act(async () => checkboxes[1].click());
      await exportWith(/XLSX: вибрані \(1\)/);

      expect(downloadMock.downloadBlob).toHaveBeenCalledTimes(1);
      expect(downloadMock.downloadBlob.mock.calls[0][1]).toBe('contacts_account_a1.xlsx');
    });

    it('confirms a finished export', async () => {
      // The list on screen, then the export's own pass.
      apiMock.listMessengersContacts.mockResolvedValue(page([contact('c1', 'Сестра', '333')]));
      await mount();
      await exportWith(/CSV: усі/);
      await vi.waitFor(() => expect(text()).toContain('Файл сформовано.'));
    });

    it('says so when a page of the export fails, and downloads nothing', async () => {
      const first = Array.from({ length: 100 }, (_, i) => contact(`a${i}`, `F${i}`, `${i}`));
      apiMock.listMessengersContacts
        .mockResolvedValueOnce(page(first, 101))
        .mockResolvedValueOnce(page(first, 101))
        .mockRejectedValueOnce(new Error('offline'));
      await mount();
      await exportWith(/CSV: усі/);
      await vi.waitFor(() =>
        expect(text()).toContain('Не вдалося отримати повний список для експорту.'),
      );
      expect(downloadMock.downloadBlob).not.toHaveBeenCalled();
    });
  });
});
