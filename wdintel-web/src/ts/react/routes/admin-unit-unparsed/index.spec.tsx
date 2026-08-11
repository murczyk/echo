/** @vitest-environment happy-dom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Unit, UnresolvedUnitLabel } from '../../../../Bindings';

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  list: vi.fn(),
  resolve: vi.fn(),
  searchUnits: vi.fn(),
  updateNote: vi.fn(),
}));

vi.mock('../../services/api/units', () => ({
  DEFAULT_LIST_UNITS_REQ: {},
  searchUnitsStrictThenRelaxed: mocks.searchUnits,
}));

vi.mock('../../services/api/unresolved-unit-labels', () => ({
  archiveUnresolvedUnitLabel: mocks.archive,
  listUnresolvedUnitLabels: mocks.list,
  resolveUnresolvedUnitLabel: mocks.resolve,
  updateUnresolvedUnitLabelNote: mocks.updateNote,
}));

vi.mock('../../components/mui-customized/table/table-state-provider', () => ({
  TableStateProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../../components/TablePageToolbar', () => ({
  TablePageToolbar: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

vi.mock('../../components/MrtRowActionButton', () => ({
  MrtRowActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MrtRowActionButton: ({
    disabled,
    label,
    onClick,
  }: {
    disabled?: boolean;
    label: string;
    onClick: () => void;
  }) => (
    <button disabled={disabled} onClick={onClick}>
      {label}
    </button>
  ),
}));

vi.mock('../settings-neo/SettingsNeoTable', () => ({
  SettingsNeoTable: ({
    columns,
    data,
    renderRowActions,
  }: {
    columns: Array<{
      accessorKey?: keyof UnresolvedUnitLabel;
      id?: string;
      Cell?: (args: {
        cell: { getValue: () => unknown };
        row: { original: UnresolvedUnitLabel };
      }) => ReactNode;
    }>;
    data: UnresolvedUnitLabel[];
    renderRowActions: (args: { row: { original: UnresolvedUnitLabel } }) => ReactNode;
  }) => (
    <div>
      {data.map((row) => (
        <section key={`${row.unitTxt}-${row.isArchived ? 'archived' : 'new'}`}>
          {columns.map((column, index) => {
            const columnKey = column.accessorKey;
            const value = columnKey ? row[columnKey] : undefined;
            return (
              <div key={column.id ?? String(columnKey ?? index)}>
                {column.Cell ? (
                  column.Cell({ cell: { getValue: () => value }, row: { original: row } })
                ) : (
                  <span>{String(value ?? '')}</span>
                )}
              </div>
            );
          })}
          {renderRowActions({ row: { original: row } })}
        </section>
      ))}
    </div>
  ),
}));

import { AdminUnitUnparsedPage } from './index';

const sigintUnit: Unit = {
  id: 35729,
  company: '',
  battalion: '',
  regiment: '68 мсд',
  division: '',
  army: '6 а',
  militaryDistrict: 'ЛВО',
  armyRegion: 'ЗВА',
  comment: '',
  orbitNote: null,
  name: '68 мсд 6 ЗВА ЛВО',
  active: false,
  isDeduplicateCandidate: null,
  createdAt: 0,
  createdByLoginId: '',
  hasOrbit: false,
  orbitUnitIds: [],
  orbitUnitGenerativeNames: [],
};

const firstPage = {
  rows: [{ unitTxt: '123 омсбр', quantity: 7, note: '', isArchived: false }],
  totalCount: 21,
  page: 0,
  pageSize: 10,
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

function inputByLabel(labelText: string): HTMLInputElement {
  const label = Array.from(document.body.querySelectorAll('label')).find((candidate) =>
    candidate.textContent?.includes(labelText),
  );
  const id = label?.getAttribute('for');
  const input = id ? document.getElementById(id) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input ${labelText}`);
  return input;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function renderPage(): Promise<Root> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AdminUnitUnparsedPage authUserRoles={['Admin', 'Rer', 'UnitsEditor']} />);
  });
  return root;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.archive.mockReset().mockResolvedValue({ affectedCount: 1 });
  mocks.list.mockReset().mockResolvedValue(firstPage);
  mocks.resolve.mockReset().mockResolvedValue({ affectedCount: 1 });
  mocks.searchUnits.mockReset().mockResolvedValue([sigintUnit]);
  mocks.updateNote.mockReset().mockResolvedValue({ affectedCount: 1 });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('AdminUnitUnparsedPage', () => {
  it('loads grouped rows and uses the server-reported page size', async () => {
    const root = await renderPage();

    expect(document.body.textContent).toContain('Нерозпізнані підрозділи');
    expect(document.body.textContent).toContain('123 омсбр');
    expect(document.body.textContent).toContain('7');
    expect(mocks.list).toHaveBeenCalledWith(
      { page: 0, archiveFilter: 'NewUnresolvedUnitLabels' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(document.body.querySelector('button[aria-label="Go to page 3"]')).not.toBeNull();

    const secondPage = document.body.querySelector(
      'button[aria-label="Go to page 2"]',
    ) as HTMLButtonElement | null;
    expect(secondPage).not.toBeNull();
    await act(async () => secondPage?.click());
    expect(mocks.list).toHaveBeenLastCalledWith(
      { page: 1, archiveFilter: 'NewUnresolvedUnitLabels' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    act(() => root.unmount());
  });

  it('archives an entire displayed group and refreshes', async () => {
    const root = await renderPage();

    await act(async () => button('Архів').click());

    expect(mocks.archive).toHaveBeenCalledWith({ unitTxt: '123 омсбр', archived: true });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('перенесено в архів');

    act(() => root.unmount());
  });

  it('saves the group note on blur', async () => {
    const root = await renderPage();
    const input = document.body.querySelector(
      'input[aria-label="Нотатка для 123 омсбр"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();

    await act(async () => {
      setInputValue(input as HTMLInputElement, 'перевірити вручну');
      input?.dispatchEvent(new Event('focusout', { bubbles: true }));
    });

    expect(mocks.updateNote).toHaveBeenCalledWith({
      unitTxt: '123 омсбр',
      note: 'перевірити вручну',
      isArchived: false,
    });
    expect(document.body.textContent).toContain('Нотатку для «123 омсбр» збережено');

    act(() => root.unmount());
  });

  it('submits the original group with an edited label and selected inactive SIGINT unit', async () => {
    const root = await renderPage();

    act(() => button("Прив'язати до підрозділу").click());
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(mocks.searchUnits).toHaveBeenCalledWith(
      expect.objectContaining({ includeInactive: true, filterText: '123 омсбр' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await act(async () => {
      setInputValue(inputByLabel('Синонім підрозділу'), 'Відредагований синонім');
    });
    act(() => buttonContaining('68 мсд 6 ЗВА ЛВО').click());
    await act(async () => button("Прив'язати").click());

    expect(mocks.resolve).toHaveBeenCalledWith({
      unitTxt: '123 омсбр',
      label: 'Відредагований синонім',
      sigintUnitId: 35729,
    });

    act(() => root.unmount());
  });

  it('shows request errors instead of silently ignoring them', async () => {
    mocks.archive.mockRejectedValueOnce(new Error('Сервер відхилив запит'));
    const root = await renderPage();

    await act(async () => button('Архів').click());

    expect(document.body.textContent).toContain('Сервер відхилив запит');
    act(() => root.unmount());
  });
});
