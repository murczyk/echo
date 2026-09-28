/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MRT_TableInstance } from 'material-react-table';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/icons-material/Close', () => ({
  default: () => <span>close-icon</span>,
}));

vi.mock('@mui/icons-material/FilterAlt', () => ({
  default: () => <span>filter-icon</span>,
}));

vi.mock('@mui/material', () => ({
  Badge: ({ children, invisible }: { children: ReactNode; invisible?: boolean }) => (
    <div data-testid="badge" data-invisible={String(Boolean(invisible))}>
      {children}
    </div>
  ),
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Divider: () => <hr />,
  IconButton: ({
    children,
    disabled,
    onClick,
    'aria-label': ariaLabel,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: (event: MouseEvent) => void;
    'aria-label'?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} disabled={disabled} onClick={onClick as any}>
      {children}
    </button>
  ),
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('../../../../../../../../PowerButton.tsx', () => ({
  PowerButton: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: (event: MouseEvent) => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick as any}>
      {children}
    </button>
  ),
}));

vi.mock('../../../../../../../../PowerIconButton.tsx', () => ({
  PowerIconButton: ({
    children,
    disabled,
    onClick,
    id,
    size: _size,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: (event: MouseEvent) => void;
    id?: string;
    size?: string;
  }) => (
    <button type="button" id={id} disabled={disabled} onClick={onClick as any}>
      {children}
    </button>
  ),
}));

vi.mock('../../../../../../../../PowerMenu.tsx', () => ({
  PowerMenu: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div data-testid="power-menu">{children}</div> : null,
}));

import { ActiveFiltersButton } from '../active-filters-button.tsx';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function buildTable(overrides: Partial<MRT_TableInstance<any>> = {}): MRT_TableInstance<any> {
  const table = {
    getState: () => ({
      columnFilters: [{ id: 'callsign', value: 'WOLF' }],
      globalFilter: '',
    }),
    getColumn: (columnId: string) =>
      columnId === 'callsign'
        ? ({
            columnDef: {
              header: 'Позивний',
            },
          } as any)
        : undefined,
    setColumnFilters: vi.fn(),
    setGlobalFilter: vi.fn(),
    ...overrides,
  };

  return table as MRT_TableInstance<any>;
}

async function renderComponent(node: ReactNode): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(node);
  });

  return { container, root };
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
describe('ActiveFiltersButton', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('shows the active badge from the live MRT table state even when the prop snapshot is empty', async () => {
    const table = buildTable();
    const view = await renderComponent(
      <ActiveFiltersButton table={table} columnFilters={[]} globalFilter="" />,
    );
    rendered.push(view);

    expect(
      view.container.querySelector('[data-testid="badge"]')?.getAttribute('data-invisible'),
    ).toBe('false');
    expect(view.container.textContent).toContain('filter-icon');
  });

  it('can clear the live table filter from the popup', async () => {
    const table = buildTable();
    const view = await renderComponent(
      <ActiveFiltersButton table={table} columnFilters={[]} globalFilter="" />,
    );
    rendered.push(view);

    await click(view.container.querySelector('#active-filters-button') as HTMLElement);
    await click(
      view.container.querySelector('button[aria-label="Очистити фільтр Позивний"]') as HTMLElement,
    );

    const updater = table.setColumnFilters.mock.calls[0]?.[0];
    expect(typeof updater).toBe('function');
    expect(updater?.([{ id: 'callsign', value: 'WOLF' }])).toEqual([]);
  });
});
