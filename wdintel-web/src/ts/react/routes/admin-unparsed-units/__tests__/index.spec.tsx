/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UnresolvedUnitMessage } from '../../../../../Bindings';

const mocks = vi.hoisted(() => ({ list: vi.fn(), resolve: vi.fn(), searchUnits: vi.fn() }));

vi.mock('../../../services/api/unresolved-unit-labels', () => ({
  listUnresolvedUnitMessages: mocks.list,
  resolveUnresolvedUnitLabel: mocks.resolve,
}));
vi.mock('../../../services/api/units', () => ({
  DEFAULT_LIST_UNITS_REQ: {},
  searchUnitsByMatchTier: mocks.searchUnits,
}));

import { AdminUnparsedUnitsPage } from '../index';

function message(id: number): UnresolvedUnitMessage {
  return {
    id,
    groupName: `Група ${id}`,
    label: '1 пдб 777 дшп',
    sender: `Відправник ${id}`,
    body: `Текст ${id}`,
    createdAt: Date.UTC(2026, 8, 17, 12, id),
  };
}

function page(title: string) {
  return <AdminUnparsedUnitsPage title={title} authUserRoles={['Admin', 'Rer', 'UnitsEditor']} />;
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.resolve.mockReset();
  mocks.searchUnits.mockReset();
});
afterEach(() => document.body.replaceChildren());

describe('AdminUnparsedUnitsPage', () => {
  it('discards an in-flight page when the title changes', async () => {
    let resolveOldPage:
      ((response: { messages: UnresolvedUnitMessage[]; nextCursor: null }) => void) | undefined;
    mocks.list.mockImplementation(({ title, cursor }: { title: string; cursor: string | null }) => {
      if (title === 'Стара мітка' && cursor !== null)
        return new Promise((resolve) => {
          resolveOldPage = resolve;
        });
      if (title === 'Нова мітка')
        return Promise.resolve({ messages: [message(8)], nextCursor: null });
      return Promise.resolve({ messages: [message(1)], nextCursor: 'old-cursor' });
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(page('Стара мітка')));
    const loadMore = Array.from(document.body.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Завантажити ще',
    );
    if (!(loadMore instanceof HTMLButtonElement)) throw new Error('missing load-more action');
    act(() => loadMore.click());
    await act(async () => root.render(page('Нова мітка')));
    await act(async () => resolveOldPage?.({ messages: [message(0)], nextCursor: null }));
    expect(document.body.textContent).toContain('Текст 8');
    expect(document.body.textContent).not.toContain('Текст 0');
    act(() => root.unmount());
  });
});
