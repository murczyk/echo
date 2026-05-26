/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tableStateMock = vi.hoisted(() => ({
  onChangeColumnVisibility: vi.fn(),
  onResetColumnsVisibility: vi.fn(),
  onColumnOrderChange: vi.fn(),
  onColumnSizingChange: vi.fn(),
  setEnableColumnOrdering: vi.fn(),
  setEnableColumnResizing: vi.fn(),
}));

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Divider: () => <hr />,
  FormControlLabel: ({ control, label }: { control: ReactNode; label?: ReactNode }) => (
    <label>
      {control}
      {label}
    </label>
  ),
  Switch: (props: { checked?: boolean; onChange?: (event: { target: { checked: boolean } }) => void }) => (
    <input
      type="checkbox"
      checked={props.checked}
      onChange={(event) => props.onChange?.({ target: { checked: event.currentTarget.checked } })}
    />
  ),
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../../../../../../../PowerButton', () => ({
  PowerButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('../../../../../../../PowerIconButton', () => ({
  PowerIconButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('../../../../../../../PowerMenu', () => ({
  PowerMenu: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
}));

vi.mock('../../../../../table-state-provider', () => ({
  INTERNAL_COLUMN_IDS: ['mrt-row-actions', 'mrt-row-drag', 'mrt-row-numbers', 'mrt-row-select', 'mrt-row-expand', 'mrt-row-spacer'],
  useTableStateContext: () => ({
    columnOrderTouched: false,
    columnSizeTouched: false,
    columnVisibilityTouched: false,
    columnOrder: ['mrt-row-numbers', 'freq', 'locationSearchText'],
    columnVisibility: {
      freq: true,
      locationSearchText: true,
    },
    density: 'compact',
    enableColumnOrdering: false,
    enableColumnResizing: true,
    onChangeColumnVisibility: tableStateMock.onChangeColumnVisibility,
    onResetColumnsVisibility: tableStateMock.onResetColumnsVisibility,
    onColumnOrderChange: tableStateMock.onColumnOrderChange,
    onColumnSizingChange: tableStateMock.onColumnSizingChange,
    setEnableColumnOrdering: tableStateMock.setEnableColumnOrdering,
    setEnableColumnResizing: tableStateMock.setEnableColumnResizing,
    tableInstance: {
      getAllColumns: () => [
        { id: 'mrt-row-numbers', columnDef: { id: 'mrt-row-numbers', header: '' } },
        { id: 'freq', columnDef: { id: 'freq', header: 'Частота' } },
        { id: 'locationSearchText', columnDef: { id: 'locationSearchText', header: 'Локації' } },
        { id: 'mrt-row-spacer', columnDef: { id: 'mrt-row-spacer', header: '' } },
      ],
    },
  }),
}));

import { ColumnsVisibilityButton } from './columns-visibility-button';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

async function renderComponent(): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ColumnsVisibilityButton />);
  });
  return { container, root };
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('ColumnsVisibilityButton', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    vi.clearAllMocks();
  });

  it('omits the MRT spacer column from the show-hide menu', async () => {
    const view = await renderComponent();
    rendered.push(view);

    const trigger = view.container.querySelector('button');
    expect(trigger).toBeTruthy();

    await click(trigger as HTMLButtonElement);

    const labels = Array.from(view.container.querySelectorAll('label')).map((label) => label.textContent?.trim() ?? '');

    expect(labels).toEqual(expect.arrayContaining(['Зміна порядку стовпців', 'Зміна розміру стовпців', 'Частота', 'Локації']));
    expect(labels).not.toContain('');
    expect(labels).not.toContain('mrt-row-spacer');
  });
});
