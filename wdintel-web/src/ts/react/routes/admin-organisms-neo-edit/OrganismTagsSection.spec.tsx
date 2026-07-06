/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listOrganismTagsMock = vi.hoisted(() => vi.fn());
const createOrganismTagMock = vi.hoisted(() => vi.fn());
const updateOrganismTagMock = vi.hoisted(() => vi.fn());
const deleteOrganismTagMock = vi.hoisted(() => vi.fn());

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
  }: {
    label?: ReactNode;
    value?: string | number;
    onChange?: (event: { target: { value: string } }) => void;
  }) => (
    <label>
      {label}
      <input
        value={value ?? ''}
        onChange={(event) => onChange?.({ target: { value: event.currentTarget.value } })}
      />
    </label>
  ),
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

type MrtColumn = {
  header?: ReactNode;
  accessorKey?: string;
  accessorFn?: (row: Record<string, unknown>) => ReactNode;
};

vi.mock('../settings-neo/SettingsNeoTable', () => ({
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

vi.mock('../../components/mui-customized/table/table-state-provider', () => ({
  TableStateProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useTableStateContext: () => ({ globalFilter: '', onChangeGlobalFilter: () => {} }),
}));

vi.mock(
  '../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field',
  () => ({
    GlobalFilterTextField: ({ globalFilter }: { globalFilter: string }) => (
      <input aria-label="Пошук" value={globalFilter} readOnly />
    ),
  }),
);

vi.mock('../../components/MrtRowActionButton', () => ({
  MrtRowActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

vi.mock('../../components/ConfirmDangerDialog', () => ({
  ConfirmDangerDialog: ({
    open,
    onConfirm,
    onClose,
    confirmLabel,
  }: {
    open: boolean;
    onConfirm: () => void;
    onClose: () => void;
    confirmLabel?: ReactNode;
  }) =>
    open ? (
      <div role="alertdialog">
        <button type="button" onClick={onConfirm}>
          {confirmLabel ?? 'Видалити'}
        </button>
        <button type="button" onClick={onClose}>
          Скасувати
        </button>
      </div>
    ) : null,
}));

vi.mock('../../components/PowerButton', () => ({
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

vi.mock('../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../services/api/tags', () => ({
  listOrganismTags: listOrganismTagsMock,
  createOrganismTag: createOrganismTagMock,
  updateOrganismTag: updateOrganismTagMock,
  deleteOrganismTag: deleteOrganismTagMock,
}));

import { OrganismTagsSection } from './OrganismTagsSection';

function renderSection(organismId: number | null) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root, organismId };
}

describe('OrganismTagsSection', () => {
  let view: ReturnType<typeof renderSection>;

  beforeEach(() => {
    listOrganismTagsMock.mockReset();
    createOrganismTagMock.mockReset();
    updateOrganismTagMock.mockReset();
    deleteOrganismTagMock.mockReset();
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
    });
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

  it('shows disabled organism tags on load so admins can recover them', async () => {
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
    expect(view.container.textContent).toContain('вимкнений');
  });

  it('hides a tag deleted from this browser across a reload', async () => {
    view = renderSection(7);
    const tagsFromBackend = [
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
      {
        tagId: 11,
        label: 'видалений',
        extra: false,
        ord: 2,
        // The backend soft-deletes by flipping `enabled` to false, so the "deleted" row
        // still comes back from the list endpoint after a reload.
        enabled: false,
        keywords: [],
        isPalitra: false,
        ownerOrganismId: 7,
      },
    ];
    listOrganismTagsMock.mockResolvedValueOnce(tagsFromBackend);
    deleteOrganismTagMock.mockResolvedValueOnce(undefined);

    await act(async () => {
      view.root.render(<OrganismTagsSection organismId={7} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      const targetRow = Array.from(view.container.querySelectorAll('tr')).find((row) =>
        row.textContent?.includes('видалений'),
      );
      Array.from(targetRow?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent === 'Видалити')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      const dialog = view.container.querySelector('[role="alertdialog"]');
      Array.from(dialog?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent === 'Видалити')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deleteOrganismTagMock).toHaveBeenCalledWith(7, 11);

    // Simulate a reload: unmount and render a fresh instance, backend still returns the
    // soft-deleted row.
    await act(async () => {
      view.root.unmount();
    });
    view = renderSection(7);
    listOrganismTagsMock.mockResolvedValueOnce(tagsFromBackend);

    await act(async () => {
      view.root.render(<OrganismTagsSection organismId={7} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('оброблено');
    expect(view.container.textContent).not.toContain('видалений');
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

  it('disables an organism tag through the update endpoint without deleting it', async () => {
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

    expect(deleteOrganismTagMock).not.toHaveBeenCalled();
    expect(updateOrganismTagMock).toHaveBeenCalledWith(
      7,
      10,
      expect.objectContaining({ enabled: false }),
    );
  });

  it('deletes an organism tag through the delete endpoint after confirmation', async () => {
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
    deleteOrganismTagMock.mockResolvedValueOnce(undefined);

    await act(async () => {
      view.root.render(<OrganismTagsSection organismId={7} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Open the confirmation dialog from the row action.
    await act(async () => {
      Array.from(view.container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Видалити')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // Confirm inside the danger dialog.
    await act(async () => {
      const dialog = view.container.querySelector('[role="alertdialog"]');
      Array.from(dialog?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent === 'Видалити')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deleteOrganismTagMock).toHaveBeenCalledWith(7, 10);
    expect(view.container.textContent).not.toContain('оброблено');
  });

  it('re-enables a disabled organism tag through the update endpoint', async () => {
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
      Array.from(view.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Вимкнути'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(view.container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Увімкнути'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(deleteOrganismTagMock).not.toHaveBeenCalled();
    expect(updateOrganismTagMock).toHaveBeenNthCalledWith(
      2,
      7,
      10,
      expect.objectContaining({ enabled: true }),
    );
  });
});
