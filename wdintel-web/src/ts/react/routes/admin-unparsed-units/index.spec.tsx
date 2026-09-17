/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UnresolvedUnitMessage } from '../../../../Bindings';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock('../../services/api/unresolved-unit-labels', () => ({
  listUnresolvedUnitMessages: mocks.list,
}));

import { AdminUnparsedUnitsPage } from './index';

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

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

async function renderPage(): Promise<Root> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AdminUnparsedUnitsPage title="1 пдб 777 дшп" />);
  });
  return root;
}

beforeEach(() => {
  mocks.list
    .mockReset()
    .mockImplementation(({ page }: { page: number | null }) =>
      Promise.resolve(
        page === 0
          ? { messages: [1, 2, 3, 4, 5].map(message), hasMore: true }
          : { messages: [message(6)], hasMore: false },
      ),
    );
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('AdminUnparsedUnitsPage', () => {
  it('loads messages five at a time and removes load more after the last page', async () => {
    const root = await renderPage();

    expect(document.body.textContent).toContain('1 пдб 777 дшп');
    expect(document.body.textContent).toContain('Група 1');
    expect(document.body.textContent).toContain('Відправник 1');
    expect(document.body.textContent).toContain('Текст 5');
    expect(document.body.textContent).not.toContain('Текст 6');
    expect(mocks.list).toHaveBeenCalledWith(
      { title: '1 пдб 777 дшп', page: 0 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await act(async () => button('Завантажити ще').click());

    expect(mocks.list).toHaveBeenLastCalledWith({ title: '1 пдб 777 дшп', page: 1 });
    expect(document.body.textContent).toContain('Текст 6');
    expect(
      Array.from(document.body.querySelectorAll('button')).some(
        (candidate) => candidate.textContent?.trim() === 'Завантажити ще',
      ),
    ).toBe(false);

    act(() => root.unmount());
  });
});
