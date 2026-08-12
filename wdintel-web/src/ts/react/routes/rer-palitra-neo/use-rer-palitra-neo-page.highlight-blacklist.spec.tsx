/** @vitest-environment happy-dom */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Palitra, PalitraHighlightBlacklistEntry } from '../../../../Bindings';

const mocks = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn() }));
vi.mock('../../services/api/palitra', () => ({
  getPalitraHighlightBlacklist: mocks.list,
  deletePalitraHighlightBlacklistEntry: mocks.remove,
}));

import { useRerPalitraNeoPageHighlightBlacklist } from './use-rer-palitra-neo-page.highlight-blacklist';

const entry: PalitraHighlightBlacklistEntry = {
  id: 11,
  palitraId: 1,
  label: 'Точка А',
  createdByLoginId: 'login-a',
  createdByLogin: 'operator',
};
function palitra(id: number): Palitra {
  return { id, name: `Палітра ${id}`, highlightBlacklistCount: 1 } as Palitra;
}

let root: Root | null = null;
let latest: ReturnType<typeof useRerPalitraNeoPageHighlightBlacklist> | null = null;
let setCount: ((id: number, count: number) => void) | null = null;
function Harness() {
  const [, setVersion] = useState(0);
  setCount = () => setVersion((value) => value + 1);
  latest = useRerPalitraNeoPageHighlightBlacklist(setCount, vi.fn());
  return null;
}
function renderHook() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(createElement(Harness)));
}
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
  setCount = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('highlight blacklist removal hook', () => {
  it('loads only the blacklist and removes an entry', async () => {
    mocks.list.mockResolvedValue([entry]);
    mocks.remove.mockResolvedValue(undefined);
    renderHook();
    await act(async () => latest?.openHighlightBlacklist(palitra(1)));
    expect(mocks.list).toHaveBeenCalledWith(1);
    expect(latest?.highlightBlacklistEntries).toEqual([entry]);
    await act(async () => {
      void latest?.deleteHighlightBlacklistEntry(entry);
      await Promise.resolve();
    });
    expect(mocks.remove).toHaveBeenCalledWith(1, 11);
    expect(latest?.highlightBlacklistEntries).toEqual([]);
  });

  it('ignores a stale delete completion after another palette opens', async () => {
    let resolve!: () => void;
    mocks.list.mockResolvedValue([]);
    mocks.remove.mockReturnValue(new Promise<void>((done) => (resolve = done)));
    renderHook();
    await act(async () => latest?.openHighlightBlacklist(palitra(1)));
    await act(async () => {
      void latest?.deleteHighlightBlacklistEntry(entry);
      await Promise.resolve();
    });
    act(() => latest?.closeHighlightBlacklist());
    await act(async () => latest?.openHighlightBlacklist(palitra(2)));
    await act(async () => resolve());
    expect(latest?.highlightBlacklistPalitra?.id).toBe(2);
    expect(latest?.highlightBlacklistEntries).toEqual([]);
    expect(latest?.highlightBlacklistPendingIds).toEqual(new Set());
  });
});
