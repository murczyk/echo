/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Unit, UnresolvedUnitMessage } from '../../../../Bindings';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  resolve: vi.fn(),
  searchUnits: vi.fn(),
}));

vi.mock('../../services/api/unresolved-unit-labels', () => ({
  listUnresolvedUnitMessages: mocks.list,
  resolveUnresolvedUnitLabel: mocks.resolve,
}));

vi.mock('../../services/api/units', () => ({
  DEFAULT_LIST_UNITS_REQ: {},
  searchUnitsByMatchTier: mocks.searchUnits,
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

const sigintUnit: Unit = {
  id: 35729,
  other: '',
  teamOrCrew: '',
  section: '',
  squad: '',
  platoon: '',
  company: '',
  battalion: '',
  regiment: '777 дшп',
  brigade: '',
  division: '',
  corps: '',
  army: '',
  militaryDistrict: '',
  armyRegion: '',
  comment: '',
  orbitNote: null,
  presentInOrbit: null,
  name: '1 пдб 777 дшп',
  active: true,
  isDeduplicateCandidate: null,
  createdAt: 0,
  createdByLoginId: '',
  hasOrbit: false,
  orbitUnitIds: [],
  orbitUnitGenerativeNames: [],
};

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

function buttonContaining(text: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!found) throw new Error(`Missing button containing ${text}`);
  return found;
}

async function renderPage(): Promise<Root> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AdminUnparsedUnitsPage
        title="1 пдб 777 дшп"
        authUserRoles={['Admin', 'Rer', 'UnitsEditor']}
      />,
    );
  });
  return root;
}

beforeEach(() => {
  mocks.list.mockReset().mockImplementation(({ cursor }: { cursor: string | null }) =>
    Promise.resolve(
      cursor === null
        ? {
            messages: [1, 5, 3, 4, 2].map(message),
            nextCursor: 'cursor-after-five',
          }
        : { messages: [message(0)], nextCursor: null },
    ),
  );
  mocks.resolve.mockReset().mockResolvedValue({ affectedCount: 1 });
  mocks.searchUnits.mockReset().mockResolvedValue({ strict: [sigintUnit], relaxed: [] });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('AdminUnparsedUnitsPage', () => {
  it('loads messages five at a time and removes load more after the last page', async () => {
    const root = await renderPage();

    expect(document.body.textContent).toContain('1 пдб 777 дшп');
    expect(document.body.textContent).toContain('Група 1');
    expect(document.body.textContent).toContain('Відправник 1');
    expect(document.body.textContent).toContain('Текст 5');
    expect(document.body.textContent).not.toContain('Текст 0');
    expect((document.body.textContent ?? '').indexOf('Текст 5')).toBeLessThan(
      (document.body.textContent ?? '').indexOf('Текст 1'),
    );
    expect(mocks.list).toHaveBeenCalledWith(
      { title: '1 пдб 777 дшп', cursor: null },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await act(async () => button('Завантажити ще').click());

    expect(mocks.list).toHaveBeenLastCalledWith({
      title: '1 пдб 777 дшп',
      cursor: 'cursor-after-five',
    });
    expect(document.body.textContent).toContain('Текст 0');
    expect(
      Array.from(document.body.querySelectorAll('button')).some(
        (candidate) => candidate.textContent?.trim() === 'Завантажити ще',
      ),
    ).toBe(false);

    act(() => root.unmount());
  });

  it('links the label with the same unit dialog used by the unparsed table', async () => {
    vi.useFakeTimers();
    const root = await renderPage();

    act(() => button("Прив'язати до підрозділу").click());
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(mocks.searchUnits).toHaveBeenCalledWith(
      expect.objectContaining({ includeInactive: true, filterText: '1 пдб 777 дшп' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    act(() => buttonContaining('1 пдб 777 дшп').click());
    await act(async () => button("Прив'язати").click());

    expect(mocks.resolve).toHaveBeenCalledWith({
      unitTxt: '1 пдб 777 дшп',
      label: '1 пдб 777 дшп',
      sigintUnitId: 35729,
    });
    expect(document.body.textContent).toContain('Синонім для «1 пдб 777 дшп» збережено.');

    act(() => root.unmount());
  });

  it('links unit creation to the units page create action', async () => {
    const root = await renderPage();

    const link = Array.from(document.body.querySelectorAll('a')).find(
      (candidate) => candidate.textContent?.trim() === 'Створити підрозділ',
    );
    expect(link?.getAttribute('href')).toBe('/rer-units-neo?create=true');

    act(() => root.unmount());
  });
});
