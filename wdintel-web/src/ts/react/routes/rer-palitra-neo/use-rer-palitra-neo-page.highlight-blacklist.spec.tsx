/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Palitra, PalitraHighlightBlacklistEntry, PalitraReadV2 } from '../../../../Bindings';

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  remove: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
}));

vi.mock('../../services/api/palitra', () => ({
  addPalitraHighlightBlacklistEntry: mocks.add,
  deletePalitraHighlightBlacklistEntry: mocks.remove,
  getPalitraHighlightBlacklist: mocks.list,
  highlightBlacklistLabelKey: (label: string) => label.trim().toLowerCase(),
  readPalitraV2: mocks.read,
}));

import { useRerPalitraNeoPageHighlightBlacklist } from './use-rer-palitra-neo-page.highlight-blacklist';

const entryA: PalitraHighlightBlacklistEntry = {
  id: 11,
  palitraId: 1,
  label: 'Точка А',
  createdByLoginId: 'login-a',
  createdByLogin: 'operator',
};

function palitra(id: number): Palitra {
  return { id, name: `Палітра ${id}` } as Palitra;
}

function readData(): PalitraReadV2 {
  return { palitra: {} as Palitra, geometries: [] };
}

let root: Root | null = null;
let latest: ReturnType<typeof useRerPalitraNeoPageHighlightBlacklist> | null = null;

function Harness() {
  latest = useRerPalitraNeoPageHighlightBlacklist();
  return null;
}

function renderHook() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(createElement(Harness)));
  if (!latest) throw new Error('Hook did not render');
  return latest;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('highlight blacklist stale mutations', () => {
  it('ignores stale add and delete completions after switching palettes', async () => {
    mocks.list.mockImplementation(async (id: number) => (id === 1 ? [entryA] : []));
    mocks.read.mockResolvedValue(readData());
    let resolveAdd!: (value: PalitraHighlightBlacklistEntry) => void;
    let resolveRemove!: () => void;
    mocks.add.mockImplementation(
      () => new Promise<PalitraHighlightBlacklistEntry>((resolve) => (resolveAdd = resolve)),
    );
    mocks.remove.mockImplementation(
      () => new Promise<void>((resolve) => (resolveRemove = resolve)),
    );

    renderHook();
    await act(async () => {
      latest?.openHighlightBlacklist(palitra(1));
      await Promise.resolve();
    });

    await act(async () => {
      void latest?.toggleHighlightBlacklist(' Нова Точка ', null);
      await Promise.resolve();
    });
    act(() => latest?.closeHighlightBlacklist());
    await act(async () => {
      latest?.openHighlightBlacklist(palitra(2));
      await Promise.resolve();
    });
    await act(async () => {
      resolveAdd({ ...entryA, id: 12, palitraId: 1, label: 'Нова Точка' });
      await Promise.resolve();
    });

    expect(latest?.highlightBlacklistEntries).toEqual([]);
    expect(latest?.highlightBlacklistPendingLabels).toEqual(new Set());
    expect(latest?.highlightBlacklistMutationError).toBeNull();
    expect(latest?.highlightBlacklistMutationBlocked).toBe(false);

    act(() => latest?.closeHighlightBlacklist());
    await act(async () => {
      latest?.openHighlightBlacklist(palitra(1));
      await Promise.resolve();
    });
    await act(async () => {
      void latest?.toggleHighlightBlacklist('Точка А', entryA);
      await Promise.resolve();
    });
    act(() => latest?.closeHighlightBlacklist());
    await act(async () => {
      latest?.openHighlightBlacklist(palitra(2));
      await Promise.resolve();
      resolveRemove();
      await Promise.resolve();
    });

    expect(latest?.highlightBlacklistEntries).toEqual([]);
    expect(latest?.highlightBlacklistPendingIds).toEqual(new Set());
    expect(latest?.highlightBlacklistMutationError).toBeNull();
    expect(latest?.highlightBlacklistMutationBlocked).toBe(false);
  });
});
