/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessengersContactItem } from '../../../../../Bindings';

const apiMock = vi.hoisted(() => ({ listMessengersContacts: vi.fn() }));
vi.mock('../../../services/api/analysis-messengers', () => apiMock);

import { MESSENGER_CONTACTS_PAGE_SIZE, useMessengerContacts } from '../use-messenger-contacts';

type State = ReturnType<typeof useMessengerContacts>;

const contact = (id: string): MessengersContactItem => ({
  id,
  messengerType: 'Telegram',
  externalId: id,
  username: null,
  firstName: id,
  lastName: null,
  phone: null,
  isMutual: null,
  isCloseFriend: null,
  createdAt: 0,
  updatedAt: 0,
  telegram: null,
});
const page = (ids: string[], total: number, pageNumber = 1) => ({
  items: ids.map(contact),
  total,
  page: pageNumber,
  pageSize: MESSENGER_CONTACTS_PAGE_SIZE,
});
// A page that is full, so the next one is expected.
const fullIds = (prefix: string) =>
  Array.from({ length: MESSENGER_CONTACTS_PAGE_SIZE }, (_, i) => `${prefix}${i}`);

describe('useMessengerContacts', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: State;

  function Probe({ refreshToken = 0 }: { refreshToken?: number }) {
    latest = useMessengerContacts('a1', refreshToken);
    return null;
  }
  const render = (refreshToken = 0) =>
    act(async () => root.render(<Probe refreshToken={refreshToken} />));
  const ids = () => latest.contacts.map((item) => item.id);

  beforeEach(() => {
    apiMock.listMessengersContacts.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('loads the first page with the largest page size', async () => {
    apiMock.listMessengersContacts.mockResolvedValueOnce(page(['a', 'b'], 2));
    await render();
    expect(apiMock.listMessengersContacts).toHaveBeenCalledWith(
      { accountId: 'a1', page: 1, limit: MESSENGER_CONTACTS_PAGE_SIZE },
      expect.anything(),
    );
    expect(ids()).toEqual(['a', 'b']);
    expect(latest).toMatchObject({ loading: false, fetching: false, hasMore: false, total: 2 });
  });

  it('shows loading until the first page arrives', async () => {
    let resolve!: (value: unknown) => void;
    apiMock.listMessengersContacts.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await render();
    expect(latest).toMatchObject({ loading: true, fetching: true, contacts: [] });
    await act(async () => resolve(page(['a'], 1)));
    expect(latest).toMatchObject({ loading: false, fetching: false });
  });

  it('appends the next page and drops a contact that a sync made repeat', async () => {
    apiMock.listMessengersContacts
      .mockResolvedValueOnce(page(fullIds('p1-'), 150))
      .mockResolvedValueOnce(page(['p1-99', 'x'], 150, 2));
    await render();
    expect(latest.hasMore).toBe(true);
    await act(async () => latest.loadMore());
    expect(apiMock.listMessengersContacts).toHaveBeenLastCalledWith(
      { accountId: 'a1', page: 2, limit: MESSENGER_CONTACTS_PAGE_SIZE },
      expect.anything(),
    );
    expect(latest.contacts).toHaveLength(MESSENGER_CONTACTS_PAGE_SIZE + 1);
    expect(ids().at(-1)).toBe('x');
    expect(latest.hasMore).toBe(false);
  });

  it('asks for nothing when everything is loaded, and once while a page is on its way', async () => {
    let resolve!: (value: unknown) => void;
    apiMock.listMessengersContacts
      .mockResolvedValueOnce(page(fullIds('p1-'), 200))
      .mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await render();
    await act(async () => {
      latest.loadMore();
      latest.loadMore();
    });
    expect(apiMock.listMessengersContacts).toHaveBeenCalledTimes(2);
    expect(latest).toMatchObject({ fetching: true });
    await act(async () => resolve(page(fullIds('p2-'), 200, 2)));
    await act(async () => latest.loadMore());
    expect(apiMock.listMessengersContacts).toHaveBeenCalledTimes(2);
  });

  it('takes an empty page as the end, whatever the total says', async () => {
    apiMock.listMessengersContacts
      .mockResolvedValueOnce(page(fullIds('p1-'), 500))
      .mockResolvedValueOnce(page([], 500, 2));
    await render();
    await act(async () => latest.loadMore());
    expect(latest.hasMore).toBe(false);
    expect(latest.total).toBe(MESSENGER_CONTACTS_PAGE_SIZE);
  });

  it('reports a failed first load and loads it again on retry', async () => {
    apiMock.listMessengersContacts
      .mockRejectedValueOnce(new Error('forbidden'))
      .mockResolvedValueOnce(page(['a'], 1));
    await render();
    expect(latest).toMatchObject({ loading: false, error: 'forbidden', contacts: [] });
    await act(async () => latest.retry());
    expect(latest).toMatchObject({ error: null });
    expect(ids()).toEqual(['a']);
  });

  it('keeps the contacts when a next page fails and waits for retry before asking again', async () => {
    apiMock.listMessengersContacts
      .mockResolvedValueOnce(page(fullIds('p1-'), 200))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page(fullIds('p2-'), 200, 2));
    await render();
    await act(async () => latest.loadMore());
    expect(latest.error).toBe('offline');
    expect(latest.contacts).toHaveLength(MESSENGER_CONTACTS_PAGE_SIZE);

    await act(async () => latest.loadMore());
    expect(apiMock.listMessengersContacts).toHaveBeenCalledTimes(2);

    await act(async () => latest.retry());
    expect(latest.error).toBeNull();
    expect(latest.contacts).toHaveLength(2 * MESSENGER_CONTACTS_PAGE_SIZE);
  });

  describe('load all', () => {
    it('walks every page and resolves to all contacts', async () => {
      apiMock.listMessengersContacts
        .mockResolvedValueOnce(page(fullIds('p1-'), 250))
        .mockResolvedValueOnce(page(fullIds('p2-'), 250, 2))
        .mockResolvedValueOnce(page(['last'], 250, 3));
      await render();
      let all: MessengersContactItem[] | null = null;
      await act(async () => {
        all = await latest.loadAll();
      });
      expect(apiMock.listMessengersContacts).toHaveBeenCalledTimes(3);
      expect(all).toHaveLength(2 * MESSENGER_CONTACTS_PAGE_SIZE + 1);
      expect(latest.hasMore).toBe(false);
    });

    it('resolves to the loaded list without a request when it is complete', async () => {
      apiMock.listMessengersContacts.mockResolvedValueOnce(page(['a'], 1));
      await render();
      let all: MessengersContactItem[] | null = null;
      await act(async () => {
        all = await latest.loadAll();
      });
      expect(all).toHaveLength(1);
      expect(apiMock.listMessengersContacts).toHaveBeenCalledTimes(1);
    });

    it('resolves to null when a page fails', async () => {
      apiMock.listMessengersContacts
        .mockResolvedValueOnce(page(fullIds('p1-'), 200))
        .mockRejectedValueOnce(new Error('offline'));
      await render();
      let all: MessengersContactItem[] | null | undefined;
      await act(async () => {
        all = await latest.loadAll();
      });
      expect(all).toBeNull();
      expect(latest.error).toBe('offline');
    });
  });

  describe('refresh', () => {
    it('reloads from the first page in place: the old contacts stay until the new ones arrive', async () => {
      let resolve!: (value: unknown) => void;
      apiMock.listMessengersContacts
        .mockResolvedValueOnce(page(['a'], 1))
        .mockReturnValueOnce(new Promise((r) => (resolve = r)));
      await render();
      await render(1);
      expect(apiMock.listMessengersContacts).toHaveBeenLastCalledWith(
        { accountId: 'a1', page: 1, limit: MESSENGER_CONTACTS_PAGE_SIZE },
        expect.anything(),
      );
      expect(latest).toMatchObject({ loading: false, fetching: true });
      expect(ids()).toEqual(['a']);

      await act(async () => resolve(page(['b'], 1)));
      expect(ids()).toEqual(['b']);
      expect(latest.fetching).toBe(false);
    });

    it('brings back as many pages as were on screen and replaces the list once they all arrived', async () => {
      let resolveSecond!: (value: unknown) => void;
      apiMock.listMessengersContacts
        .mockResolvedValueOnce(page(fullIds('old1-'), 250))
        .mockResolvedValueOnce(page(fullIds('old2-'), 250, 2))
        .mockResolvedValueOnce(page(fullIds('new1-'), 250))
        .mockReturnValueOnce(new Promise((r) => (resolveSecond = r)));
      await render();
      await act(async () => latest.loadMore());
      expect(latest.contacts).toHaveLength(2 * MESSENGER_CONTACTS_PAGE_SIZE);

      await render(1);
      expect(apiMock.listMessengersContacts).toHaveBeenNthCalledWith(
        3,
        { accountId: 'a1', page: 1, limit: MESSENGER_CONTACTS_PAGE_SIZE },
        expect.anything(),
      );
      expect(apiMock.listMessengersContacts).toHaveBeenNthCalledWith(
        4,
        { accountId: 'a1', page: 2, limit: MESSENGER_CONTACTS_PAGE_SIZE },
        expect.anything(),
      );
      // Nothing changes until the last page is there.
      expect(latest.fetching).toBe(true);
      expect(ids()[0]).toBe('old1-0');

      await act(async () => resolveSecond(page(fullIds('new2-'), 250, 2)));
      expect(ids()[0]).toBe('new1-0');
      expect(latest.contacts).toHaveLength(2 * MESSENGER_CONTACTS_PAGE_SIZE);
      expect(latest.hasMore).toBe(true);
    });

    it('stops at the end of a list that got shorter', async () => {
      apiMock.listMessengersContacts
        .mockResolvedValueOnce(page(fullIds('old1-'), 150))
        .mockResolvedValueOnce(page(fullIds('old2-').slice(0, 50), 150, 2))
        .mockResolvedValueOnce(page(['only'], 1));
      await render();
      await act(async () => latest.loadMore());
      await render(1);
      expect(apiMock.listMessengersContacts).toHaveBeenCalledTimes(3);
      expect(ids()).toEqual(['only']);
      expect(latest.hasMore).toBe(false);
    });

    it('keeps the old list and reports an error when a page of the refresh fails', async () => {
      apiMock.listMessengersContacts
        .mockResolvedValueOnce(page(fullIds('old1-'), 250))
        .mockResolvedValueOnce(page(fullIds('old2-'), 250, 2))
        .mockResolvedValueOnce(page(fullIds('new1-'), 250))
        .mockRejectedValueOnce(new Error('offline'));
      await render();
      await act(async () => latest.loadMore());
      await render(1);
      expect(latest.error).toBe('offline');
      expect(ids()[0]).toBe('old1-0');
      expect(latest.contacts).toHaveLength(2 * MESSENGER_CONTACTS_PAGE_SIZE);
    });

    it('drops the answer of a request that the refresh replaced', async () => {
      let resolveOld!: (value: unknown) => void;
      apiMock.listMessengersContacts
        .mockReturnValueOnce(new Promise((r) => (resolveOld = r)))
        .mockResolvedValueOnce(page(['new'], 1));
      await render();
      await render(1);
      await act(async () => resolveOld(page(['old'], 1)));
      expect(ids()).toEqual(['new']);
    });
  });

  describe('fetch every contact (for an export)', () => {
    const fetchEvery = async () => {
      let all: MessengersContactItem[] | null | undefined;
      await act(async () => {
        all = await latest.fetchEveryContact();
      });
      return all;
    };

    it('makes a fresh pass over all pages and leaves the list on screen alone', async () => {
      apiMock.listMessengersContacts
        .mockResolvedValueOnce(page(['a'], 1))
        .mockResolvedValueOnce(page(fullIds('p1-'), 150))
        .mockResolvedValueOnce(page(fullIds('p2-').slice(0, 50), 150, 2));
      await render();
      const all = await fetchEvery();
      expect(all).toHaveLength(150);
      expect(apiMock.listMessengersContacts).toHaveBeenNthCalledWith(
        2,
        { accountId: 'a1', page: 1, limit: MESSENGER_CONTACTS_PAGE_SIZE },
        expect.anything(),
      );
      expect(ids()).toEqual(['a']);
    });

    it('makes the pass again when the total changed meanwhile', async () => {
      apiMock.listMessengersContacts
        .mockResolvedValueOnce(page(['a'], 1))
        // First pass: a contact was deleted between the pages.
        .mockResolvedValueOnce(page(fullIds('p1-'), 150))
        .mockResolvedValueOnce(page(fullIds('p2-').slice(0, 49), 149, 2))
        // Second pass is steady.
        .mockResolvedValueOnce(page(fullIds('q1-'), 149))
        .mockResolvedValueOnce(page(fullIds('q2-').slice(0, 49), 149, 2));
      await render();
      const all = await fetchEvery();
      expect(all).toHaveLength(149);
      expect(all?.[0].id).toBe('q1-0');
    });

    it('makes the pass again when a contact came twice', async () => {
      apiMock.listMessengersContacts
        .mockResolvedValueOnce(page(['a'], 1))
        .mockResolvedValueOnce(page(fullIds('p1-'), 101))
        .mockResolvedValueOnce(page(['p1-99'], 101, 2))
        .mockResolvedValueOnce(page(fullIds('q1-'), 101))
        .mockResolvedValueOnce(page(['last'], 101, 2));
      await render();
      const all = await fetchEvery();
      expect(all).toHaveLength(101);
      expect(all?.at(-1)?.id).toBe('last');
    });

    it('gives up on contacts that never hold still', async () => {
      apiMock.listMessengersContacts.mockResolvedValueOnce(page(['a'], 1));
      for (let attempt = 0; attempt < 3; attempt += 1) {
        apiMock.listMessengersContacts
          .mockResolvedValueOnce(page(fullIds(`p${attempt}-`), 150))
          .mockResolvedValueOnce(page(fullIds(`r${attempt}-`).slice(0, 49), 149, 2));
      }
      await render();
      expect(await fetchEvery()).toBeNull();
    });

    it('is not cancelled by a refresh of the list', async () => {
      let resolveFirst!: (value: unknown) => void;
      apiMock.listMessengersContacts
        .mockResolvedValueOnce(page(['a'], 1))
        // The export pass starts and waits on its first page ...
        .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
        // ... while the refresh reloads the list.
        .mockResolvedValueOnce(page(['a'], 1));
      await render();
      let all: MessengersContactItem[] | null | undefined;
      let pass!: Promise<unknown>;
      await act(async () => {
        pass = latest.fetchEveryContact().then((result) => (all = result));
      });
      await render(1);
      await act(async () => resolveFirst(page(['a', 'b'].slice(0, 1), 1)));
      await act(async () => pass);
      expect(all).toHaveLength(1);
    });

    it('resolves to null when a request fails', async () => {
      apiMock.listMessengersContacts
        .mockResolvedValueOnce(page(['a'], 1))
        .mockRejectedValueOnce(new Error('offline'));
      await render();
      expect(await fetchEvery()).toBeNull();
    });
  });
});
