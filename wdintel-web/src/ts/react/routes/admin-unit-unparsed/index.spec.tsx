/** @vitest-environment happy-dom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrbitUnitLinkCandidate, UnresolvedUnitLabel } from '../../../../Bindings';

const mocks = vi.hoisted(() => ({
  classify: vi.fn(),
  list: vi.fn(),
  resolve: vi.fn(),
  search: vi.fn(),
}));

vi.mock('../../services/api/unresolved-unit-labels', () => ({
  classifyUnresolvedUnitLabel: mocks.classify,
  listUnresolvedUnitLabels: mocks.list,
  resolveUnresolvedUnitLabel: mocks.resolve,
  searchUnresolvedUnitOrbitUnits: mocks.search,
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
    data,
    renderRowActions,
  }: {
    data: UnresolvedUnitLabel[];
    renderRowActions: (args: { row: { original: UnresolvedUnitLabel } }) => ReactNode;
  }) => (
    <div>
      {data.map((row) => (
        <section key={row.unitTxt}>
          <span>{row.unitTxt}</span>
          <span>{row.quantity}</span>
          {renderRowActions({ row: { original: row } })}
        </section>
      ))}
    </div>
  ),
}));

const orbitUnit: OrbitUnitLinkCandidate = {
  unitId: 'orbit-id',
  fullName: '123 омсбр',
  generativeUnitNameFull: '123 омсбр',
  operationalUnitNameFull: null,
};

vi.mock('../rer-unit-details/OrbitUnitLinkDialog', () => ({
  OrbitUnitPickerDialog: ({
    onSelected,
  }: {
    onSelected: (unit: OrbitUnitLinkCandidate) => void;
  }) => <button onClick={() => onSelected(orbitUnit)}>Обрати тестовий ORBIT</button>,
}));

import { AdminUnitUnparsedPage } from './index';

const firstPage = {
  rows: [{ unitTxt: '123 омсбр', quantity: 7 }],
  totalCount: 21,
  page: 0,
  pageSize: 20,
};

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
    root.render(<AdminUnitUnparsedPage authUserRoles={['Admin', 'Rer', 'UnitsEditor']} />);
  });
  return root;
}

beforeEach(() => {
  mocks.classify.mockReset().mockResolvedValue({ affectedCount: 1 });
  mocks.list.mockReset().mockResolvedValue(firstPage);
  mocks.resolve.mockReset().mockResolvedValue({ affectedCount: 1 });
  mocks.search.mockReset().mockResolvedValue([orbitUnit]);
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('AdminUnitUnparsedPage', () => {
  it('loads grouped rows and requests server-side pages of 20', async () => {
    const root = await renderPage();

    expect(document.body.textContent).toContain('Нерозпізнані підрозділи');
    expect(document.body.textContent).toContain('123 омсбр');
    expect(document.body.textContent).toContain('7');
    expect(mocks.list).toHaveBeenCalledWith(
      { page: 0 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const secondPage = document.body.querySelector(
      'button[aria-label="Go to page 2"]',
    ) as HTMLButtonElement | null;
    expect(secondPage).not.toBeNull();
    await act(async () => secondPage?.click());
    expect(mocks.list).toHaveBeenLastCalledWith(
      { page: 1 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    act(() => root.unmount());
  });

  it('classifies an entire displayed group as bad data and refreshes', async () => {
    const root = await renderPage();

    await act(async () => button('Погані дані').click());

    expect(mocks.classify).toHaveBeenCalledWith({ unitTxt: '123 омсбр' });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('позначено як погані дані');

    act(() => root.unmount());
  });

  it('submits the original group with an edited label and selected Orbit unit', async () => {
    const root = await renderPage();

    act(() => button("Прив'язати до підрозділу").click());
    const input = document.body.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('123 омсбр');
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'Відредагований тег');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button('Обрати підрозділ ORBIT').click());
    act(() => button('Обрати тестовий ORBIT').click());
    await act(async () => button("Прив'язати").click());

    expect(mocks.resolve).toHaveBeenCalledWith({
      unitTxt: '123 омсбр',
      label: 'Відредагований тег',
      orbitUnitId: 'orbit-id',
    });

    act(() => root.unmount());
  });

  it('shows request errors instead of silently ignoring them', async () => {
    mocks.classify.mockRejectedValueOnce(new Error('Сервер відхилив запит'));
    const root = await renderPage();

    await act(async () => button('Погані дані').click());

    expect(document.body.textContent).toContain('Сервер відхилив запит');
    act(() => root.unmount());
  });
});
