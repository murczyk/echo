/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ listMessengersChats: vi.fn() }));
vi.mock('../../../services/api/analysis-messengers', () => apiMock);

import { useMessengerChats } from '../use-messenger-chats';

type State = ReturnType<typeof useMessengerChats>;

const chat = (id: string) => ({ id, title: id, chatType: 'GROUP' });
const titles = () => latest?.chats.map((item) => item.title);
let latest: State | null;

describe('useMessengerChats', () => {
  let container: HTMLDivElement;
  let root: Root;

  function Probe({
    accountId = 'a1',
    refreshToken = 0,
  }: {
    accountId?: string;
    refreshToken?: number;
  }) {
    latest = useMessengerChats(accountId, refreshToken);
    return null;
  }
  const render = (props: Parameters<typeof Probe>[0] = {}) =>
    act(async () => root.render(<Probe {...props} />));

  beforeEach(() => {
    apiMock.listMessengersChats.mockReset();
    latest = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('loads the chats of the account', async () => {
    apiMock.listMessengersChats.mockResolvedValueOnce({ items: [chat('c1')] });
    await render();
    expect(apiMock.listMessengersChats).toHaveBeenCalledWith(
      { accountId: 'a1' },
      expect.anything(),
    );
    expect(latest).toMatchObject({ loading: false, fetching: false, error: null });
    expect(titles()).toEqual(['c1']);
  });

  it('reloads in place on a new refresh token: the old chats stay and no loading is shown', async () => {
    let resolve!: (value: unknown) => void;
    apiMock.listMessengersChats
      .mockResolvedValueOnce({ items: [chat('c1')] })
      .mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await render();
    await render({ refreshToken: 1 });
    expect(latest).toMatchObject({ loading: false, fetching: true });
    expect(titles()).toEqual(['c1']);

    await act(async () => resolve({ items: [chat('c1'), chat('c2')] }));
    expect(latest).toMatchObject({ loading: false, fetching: false });
    expect(titles()).toEqual(['c1', 'c2']);
  });

  it('keeps the chats when a refresh fails, so an open chat does not vanish', async () => {
    apiMock.listMessengersChats
      .mockResolvedValueOnce({ items: [chat('c1')] })
      .mockRejectedValueOnce(new Error('offline'));
    await render();
    await render({ refreshToken: 1 });
    expect(latest).toMatchObject({ loading: false, fetching: false, error: 'offline' });
    expect(titles()).toEqual(['c1']);
  });

  it('has no chats to keep when the first load fails', async () => {
    apiMock.listMessengersChats.mockRejectedValueOnce(new Error('forbidden'));
    await render();
    expect(latest).toMatchObject({ loading: false, error: 'forbidden', chats: [] });
  });

  it('never shows the chats of the previous account after a failed load', async () => {
    apiMock.listMessengersChats
      .mockResolvedValueOnce({ items: [chat('c1')] })
      .mockRejectedValueOnce(new Error('forbidden'));
    await render();
    await render({ accountId: 'a2' });
    expect(latest).toMatchObject({ error: 'forbidden', chats: [] });
  });

  it('shows loading again after a retry', async () => {
    let resolve!: (value: unknown) => void;
    apiMock.listMessengersChats
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await render();
    await act(async () => latest?.retry());
    expect(latest).toMatchObject({ loading: true, fetching: true, error: null });
    await act(async () => resolve({ items: [chat('c1')] }));
    expect(titles()).toEqual(['c1']);
  });
});
