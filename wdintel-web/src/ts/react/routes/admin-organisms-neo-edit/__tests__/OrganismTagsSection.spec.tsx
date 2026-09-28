/**
 * @vitest-environment happy-dom
 */
import { Children, act, cloneElement, isValidElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listOrganismTagsMock = vi.hoisted(() => vi.fn());
const createOrganismTagMock = vi.hoisted(() => vi.fn());
const updateOrganismTagMock = vi.hoisted(() => vi.fn());

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CircularProgress: () => <span>loading</span>,
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FormControlLabel: ({ control, label }: { control: ReactNode; label: ReactNode }) => (
    <div>
      {control}
      {label}
    </div>
  ),
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Switch: ({ checked, onChange }: { checked?: boolean; onChange?: () => void }) => (
    <button type="button" onClick={onChange}>
      {checked ? 'checked' : 'unchecked'}
    </button>
  ),
  TextField: ({
    label,
    value,
    onChange,
    helperText,
  }: {
    label?: ReactNode;
    value?: string | number;
    onChange?: (event: { target: { value: string } }) => void;
    helperText?: ReactNode;
  }) => (
    <label>
      {label}
      <input
        value={value ?? ''}
        onChange={(event) => onChange?.({ target: { value: event.currentTarget.value } })}
      />
      {helperText}
    </label>
  ),
  ToggleButtonGroup: ({
    children,
    onChange,
  }: {
    children: ReactNode;
    onChange?: (event: unknown, value: string | null) => void;
  }) => (
    <div>
      {Children.map(children, (child) =>
        isValidElement(child)
          ? cloneElement(child as ReactElement<{ __onChange?: typeof onChange }>, {
              __onChange: onChange,
            })
          : child,
      )}
    </div>
  ),
  ToggleButton: ({
    children,
    value,
    __onChange,
  }: {
    children: ReactNode;
    value: string;
    __onChange?: (event: unknown, value: string | null) => void;
  }) => (
    <button type="button" onClick={() => __onChange?.(null, value)}>
      {children}
    </button>
  ),
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

type MrtColumn = {
  header?: ReactNode;
  accessorKey?: string;
  accessorFn?: (row: Record<string, unknown>) => ReactNode;
};

vi.mock('../../settings-neo/SettingsNeoTable', () => ({
  SettingsNeoTable: ({
    columns,
    data,
    renderRowActions,
  }: {
    columns: MrtColumn[];
    data: Array<Record<string, unknown>>;
    renderRowActions?: (params: { row: { original: Record<string, unknown> } }) => ReactNode;
  }) => (
    <table>
      <tbody>
        {data.map((row, index) => (
          <tr key={index}>
            {columns.map((column, columnIndex) => (
              <td key={columnIndex}>
                {column.accessorFn
                  ? column.accessorFn(row)
                  : column.accessorKey
                    ? String(row[column.accessorKey] ?? '')
                    : null}
              </td>
            ))}
            <td>{renderRowActions ? renderRowActions({ row: { original: row } }) : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));

vi.mock('../../../components/mui-customized/table/table-state-provider', () => ({
  TableStateProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useTableStateContext: () => ({ globalFilter: '', onChangeGlobalFilter: () => {} }),
}));

vi.mock(
  '../../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field',
  () => ({
    GlobalFilterTextField: ({ globalFilter }: { globalFilter: string }) => (
      <input aria-label="Пошук" value={globalFilter} readOnly />
    ),
  }),
);

vi.mock('../../../components/MrtRowActionButton', () => ({
  MrtRowActionButton: ({
    label,
    onClick,
    disabled,
  }: {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {label}
    </button>
  ),
}));

vi.mock('../../../components/PowerButton', () => ({
  PowerButton: ({
    children,
    onClick,
    type,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    type?: 'button' | 'submit';
    disabled?: boolean;
  }) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../services/api/tags', () => ({
  listOrganismTags: listOrganismTagsMock,
  createOrganismTag: createOrganismTagMock,
  updateOrganismTag: updateOrganismTagMock,
}));

import { OrganismTagsSection } from '.././OrganismTagsSection';

function renderSection(organismId: number | null) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root, organismId };
}

function switchToArchiveView(view: ReturnType<typeof renderSection>) {
  Array.from(view.container.querySelectorAll('button'))
    .find((button) => button.textContent === 'Архів')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}
describe('OrganismTagsSection', () => {
  let view: ReturnType<typeof renderSection>;

  beforeEach(() => {
    listOrganismTagsMock.mockReset();
    createOrganismTagMock.mockReset();
    updateOrganismTagMock.mockReset();
  });

  afterEach(async () => {
    if (view) {
      await act(async () => {
        view.root.unmount();
        await Promise.resolve();
      });
      view.container.remove();
    }
  });

  it('asks to save a new organism before editing tags', async () => {
    view = renderSection(null);

    await act(async () => {
      view.root.render(<OrganismTagsSection organismId={null} />);
    });

    expect(view.container.textContent).toContain('Спочатку збережіть організм, щоб додати теги');
    expect(listOrganismTagsMock).not.toHaveBeenCalled();
  });

  it('loads organism tags for an existing organism', async () => {
    view = renderSection(7);
    listOrganismTagsMock.mockResolvedValueOnce([
      {
        tagId: 10,
        label: 'оброблено',
        extra: false,
        ord: 1,
        enabled: true,
        keywords: [],
        isPalitra: false,
        ownerOrganismId: 7,
      },
    ]);

    await act(async () => {
      view.root.render(<OrganismTagsSection organismId={7} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listOrganismTagsMock).toHaveBeenCalledWith(7);
    expect(view.container.textContent).toContain('оброблено');
  });

  it('shows only active tags by default and hides disabled ones', async () => {
    view = renderSection(7);
    listOrganismTagsMock.mockResolvedValueOnce([
      {
        tagId: 10,
        label: 'активний',
        extra: false,
        ord: 1,
        enabled: true,
        keywords: [],
        isPalitra: false,
        ownerOrganismId: 7,
      },
      {
        tagId: 11,
        label: 'вимкнений',
        extra: false,
        ord: 2,
        enabled: false,
        keywords: [],
        isPalitra: false,
        ownerOrganismId: 7,
      },
    ]);

    await act(async () => {
      view.root.render(<OrganismTagsSection organismId={7} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('активний');
    expect(view.container.textContent).not.toContain('вимкнений');
  });

  it('shows only disabled tags in the archive view', async () => {
    view = renderSection(7);
    listOrganismTagsMock.mockResolvedValueOnce([
      {
        tagId: 10,
        label: 'активний',
        extra: false,
        ord: 1,
        enabled: true,
        keywords: [],
        isPalitra: false,
        ownerOrganismId: 7,
      },
      {
        tagId: 11,
        label: 'вимкнений',
        extra: false,
        ord: 2,
        enabled: false,
        keywords: [],
        isPalitra: false,
        ownerOrganismId: 7,
      },
    ]);

    await act(async () => {
      view.root.render(<OrganismTagsSection organismId={7} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      switchToArchiveView(view);
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('вимкнений');
    expect(view.container.textContent).not.toContain('активний');
  });

  it('creates an organism tag through the organism endpoint', async () => {
    view = renderSection(7);
    listOrganismTagsMock.mockResolvedValueOnce([]);
    createOrganismTagMock.mockResolvedValueOnce({
      tagId: 11,
      label: 'новий',
      extra: false,
      ord: null,
      enabled: true,
      keywords: [],
      isPalitra: false,
      ownerOrganismId: 7,
    });

    await act(async () => {
      view.root.render(<OrganismTagsSection organismId={7} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const buttons = Array.from(view.container.querySelectorAll('button'));
    await act(async () => {
      buttons
        .find((button) => button.textContent?.includes('Додати тег'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input = view.container.querySelector('input');
    await act(async () => {
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set;
        setter?.call(input, 'новий');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await act(async () => {
      Array.from(view.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Зберегти'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createOrganismTagMock).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        label: 'новий',
        ownerOrganismId: 7,
      }),
    );
  });

  it('rejects a non-numeric order value instead of silently saving it as null', async () => {
    view = renderSection(7);
    listOrganismTagsMock.mockResolvedValueOnce([]);

    await act(async () => {
      view.root.render(<OrganismTagsSection organismId={7} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(view.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Додати тег'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const inputs = Array.from(view.container.querySelectorAll('input'));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

    await act(async () => {
      setter?.call(inputs[0], 'новий');
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      setter?.call(inputs[1], 'e');
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      Array.from(view.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Зберегти'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createOrganismTagMock).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Некоректне число');
  });

  it('disables an organism tag through the update endpoint and moves it out of the active view', async () => {
    view = renderSection(7);
    listOrganismTagsMock.mockResolvedValueOnce([
      {
        tagId: 10,
        label: 'оброблено',
        extra: false,
        ord: 1,
        enabled: true,
        keywords: [],
        isPalitra: false,
        ownerOrganismId: 7,
      },
    ]);
    updateOrganismTagMock.mockResolvedValueOnce({
      tagId: 10,
      label: 'оброблено',
      extra: false,
      ord: 1,
      enabled: false,
      keywords: [],
      isPalitra: false,
      ownerOrganismId: 7,
    });

    await act(async () => {
      view.root.render(<OrganismTagsSection organismId={7} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(view.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Вимкнути'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(updateOrganismTagMock).toHaveBeenCalledWith(
      7,
      10,
      expect.objectContaining({ enabled: false }),
    );
    expect(view.container.textContent).not.toContain('оброблено');
  });

  it('re-enables a disabled organism tag from the archive view through the update endpoint', async () => {
    view = renderSection(7);
    listOrganismTagsMock.mockResolvedValueOnce([
      {
        tagId: 10,
        label: 'оброблено',
        extra: false,
        ord: 1,
        enabled: false,
        keywords: [],
        isPalitra: false,
        ownerOrganismId: 7,
      },
    ]);
    updateOrganismTagMock.mockResolvedValueOnce({
      tagId: 10,
      label: 'оброблено',
      extra: false,
      ord: 1,
      enabled: true,
      keywords: [],
      isPalitra: false,
      ownerOrganismId: 7,
    });

    await act(async () => {
      view.root.render(<OrganismTagsSection organismId={7} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      switchToArchiveView(view);
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(view.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Увімкнути'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(updateOrganismTagMock).toHaveBeenCalledWith(
      7,
      10,
      expect.objectContaining({ enabled: true }),
    );
  });
});
