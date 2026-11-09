/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  listMessengersAccounts: vi.fn(),
  updateMessengersAccount: vi.fn(),
}));
vi.mock('../../../services/api/analysis-messengers', () => apiMock);

import { toMessengerAccountItem, useMessengerAccounts } from '../use-messenger-accounts';

type State = ReturnType<typeof useMessengerAccounts>;

describe('useMessengerAccounts', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: State | null;

  function Probe({ enabled, refreshToken = 0 }: { enabled: boolean; refreshToken?: number }) {
    latest = useMessengerAccounts(enabled, refreshToken);
    return null;
  }

  beforeEach(() => {
    apiMock.listMessengersAccounts.mockReset();
    apiMock.updateMessengersAccount.mockReset();
    latest = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not request anything until enabled', async () => {
    apiMock.listMessengersAccounts.mockResolvedValue({ items: [] });
    await act(async () => root.render(<Probe enabled={false} />));
    expect(apiMock.listMessengersAccounts).not.toHaveBeenCalled();

    await act(async () => root.render(<Probe enabled />));
    expect(apiMock.listMessengersAccounts).toHaveBeenCalledTimes(1);
  });

  it('reports a failed request instead of leaving the list loading', async () => {
    apiMock.listMessengersAccounts.mockRejectedValue(new Error('forbidden'));
    await act(async () => root.render(<Probe enabled />));
    expect(latest).toMatchObject({ loading: false, error: 'forbidden', accounts: [] });
  });

  it('reloads in place on a new refresh token and reports it as fetching', async () => {
    let resolve!: (value: unknown) => void;
    apiMock.listMessengersAccounts
      .mockResolvedValueOnce({ items: [{ id: '1', displayName: 'A', externalId: 'x' }] })
      .mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await act(async () => root.render(<Probe enabled />));
    expect(latest).toMatchObject({ loading: false, fetching: false });

    await act(async () => root.render(<Probe enabled refreshToken={1} />));
    expect(latest).toMatchObject({ loading: false, fetching: true });
    expect(latest?.accounts.map((account) => account.name)).toEqual(['A']);

    await act(async () => resolve({ items: [{ id: '2', displayName: 'B', externalId: 'y' }] }));
    expect(latest).toMatchObject({ fetching: false });
    expect(latest?.accounts.map((account) => account.name)).toEqual(['B']);
  });

  it('keeps the loaded accounts when a refresh fails', async () => {
    apiMock.listMessengersAccounts
      .mockResolvedValueOnce({ items: [{ id: '1', displayName: 'A', externalId: 'x' }] })
      .mockRejectedValueOnce(new Error('offline'));
    await act(async () => root.render(<Probe enabled />));
    await act(async () => root.render(<Probe enabled refreshToken={1} />));
    expect(latest).toMatchObject({ loading: false, fetching: false, error: 'offline' });
    expect(latest?.accounts).toHaveLength(1);
  });

  it('takes the messenger user id from the telegram block only when it exists', () => {
    const base = { id: '1', displayName: 'A', externalId: 'external id test' } as Parameters<
      typeof toMessengerAccountItem
    >[0];
    expect(toMessengerAccountItem({ ...base, telegram: { userId: 'user id test' } })).toMatchObject(
      {
        userId: 'user id test',
        externalId: 'external id test',
      },
    );
    expect(toMessengerAccountItem({ ...base, telegram: null }).userId).toBeNull();
  });

  it('reads the internal notes and saves it only after the request succeeded', async () => {
    apiMock.listMessengersAccounts.mockResolvedValue({
      items: [
        { id: '1', displayName: 'A', externalId: 'e', notes: 'regular', internalNotes: 'private' },
      ],
    });
    await act(async () => root.render(<Probe enabled />));
    expect(latest?.accounts[0]).toMatchObject({ notes: 'regular', internalNotes: 'private' });

    apiMock.updateMessengersAccount.mockRejectedValueOnce(new Error('nope'));
    await act(async () => {
      await latest?.saveInternalNotes('1', 'secret').catch(() => {});
    });
    expect(latest?.accounts[0].internalNotes).toBe('private');

    apiMock.updateMessengersAccount.mockResolvedValueOnce(undefined);
    await act(async () => {
      await latest?.saveInternalNotes('1', 'secret');
    });
    expect(apiMock.updateMessengersAccount).toHaveBeenLastCalledWith({
      accountId: '1',
      internalNotes: 'secret',
    });
    expect(latest?.accounts[0]).toMatchObject({ internalNotes: 'secret', notes: 'regular' });
  });

  it('clears the notes when the saved text is blank', async () => {
    apiMock.listMessengersAccounts.mockResolvedValue({
      items: [{ id: '1', displayName: 'A', externalId: 'e', notes: null, internalNotes: 'x' }],
    });
    apiMock.updateMessengersAccount.mockResolvedValue(undefined);
    await act(async () => root.render(<Probe enabled />));

    await act(async () => {
      await latest?.saveInternalNotes('1', '  \n ');
    });

    expect(apiMock.updateMessengersAccount).toHaveBeenLastCalledWith({
      accountId: '1',
      internalNotes: null,
    });
    expect(latest?.accounts[0].internalNotes).toBeNull();
  });
});
