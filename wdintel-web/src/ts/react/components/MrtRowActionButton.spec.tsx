/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/icons-material/MoreVert', () => ({
  default: () => <span>more-icon</span>,
}));

vi.mock('@mui/material', () => ({
  ListItemIcon: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ListItemText: ({ primary }: { primary: ReactNode }) => <span>{primary}</span>,
  MenuItem: ({
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
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  alpha: () => 'alpha-color',
}));

vi.mock('./PowerIconButton', () => ({
  PowerIconButton: ({
    children,
    onClick,
    disabled,
    sx: _sx,
    ...props
  }: {
    children: ReactNode;
    onClick?: (event: MouseEvent) => void;
    disabled?: boolean;
    sx?: unknown;
    [key: string]: unknown;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick as any} {...props}>
      {children}
    </button>
  ),
}));

vi.mock('./PowerMenu', () => ({
  PowerMenu: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div data-testid="overflow-menu">{children}</div> : null,
}));

import { MrtRowActionButton, MrtRowActions, mrtRowActionsColumnSize } from './MrtRowActionButton';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

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

function getButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

describe('mrtRowActionsColumnSize', () => {
  it('uses the compact one-button width for all action counts', () => {
    expect(mrtRowActionsColumnSize(1)).toBe(48);
    expect(mrtRowActionsColumnSize(2)).toBe(48);
    expect(mrtRowActionsColumnSize(3)).toBe(48);
    expect(mrtRowActionsColumnSize(4)).toBe(48);
    expect(mrtRowActionsColumnSize(5, 'grid')).toBe(48);
  });
});

describe('MrtRowActions', () => {
  const rendered: Rendered[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    vi.useRealTimers();
  });

  it('defers a direct modal action and blurs the active element first', async () => {
    const onEdit = vi.fn();
    const blurSpy = vi.spyOn(HTMLElement.prototype, 'blur');
    const view = await renderComponent(
      <MrtRowActions>
        <MrtRowActionButton
          label="Редагувати"
          onClick={onEdit}
          icon={<span>edit-icon</span>}
          opensModal
        />
      </MrtRowActions>,
    );
    rendered.push(view);

    const button = getButtons(view.container)[0]!;
    button.focus();
    await click(button);

    expect(onEdit).not.toHaveBeenCalled();
    expect(blurSpy).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onEdit).toHaveBeenCalledTimes(1);
    blurSpy.mockRestore();
  });

  it('keeps a direct non-modal action immediate', async () => {
    const onSelect = vi.fn();
    const view = await renderComponent(
      <MrtRowActions>
        <MrtRowActionButton label="У фільтр" onClick={onSelect} icon={<span>filter-icon</span>} />
      </MrtRowActions>,
    );
    rendered.push(view);

    await click(getButtons(view.container)[0]!);

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('renders two actions as a single menu button and keeps both actions in the menu', async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const view = await renderComponent(
      <MrtRowActions>
        <MrtRowActionButton label="Редагувати" onClick={onEdit} icon={<span>edit-icon</span>} />
        <MrtRowActionButton
          label="Видалити"
          onClick={onDelete}
          icon={<span>delete-icon</span>}
          tone="danger"
          opensModal
        />
      </MrtRowActions>,
    );
    rendered.push(view);

    const buttonsBeforeOpen = getButtons(view.container);
    expect(buttonsBeforeOpen).toHaveLength(1);
    expect(view.container.textContent).toContain('more-icon');
    expect(view.container.textContent).not.toContain('edit-icon');
    expect(view.container.textContent).not.toContain('delete-icon');

    await click(buttonsBeforeOpen[0]!);

    expect(view.container.textContent).toContain('Видалити');
    expect(view.container.textContent).toContain('Редагувати');
    expect(view.container.textContent).toContain('delete-icon');
    expect(view.container.textContent).toContain('edit-icon');

    const menuButtons = Array.from(
      view.container.querySelectorAll('[data-testid="overflow-menu"] button'),
    );
    expect(menuButtons).toHaveLength(2);
    expect(menuButtons[0]?.textContent).toContain('Редагувати');
    expect(menuButtons[0]?.textContent).toContain('edit-icon');
    expect(menuButtons[1]?.textContent).toContain('Видалити');
    expect(menuButtons[1]?.textContent).toContain('delete-icon');

    const blurSpy = vi.spyOn(HTMLElement.prototype, 'blur');
    blurSpy.mockClear();

    await click(menuButtons[1]!);

    expect(onDelete).not.toHaveBeenCalled();
    expect(blurSpy).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
    blurSpy.mockRestore();
  });

  it('calls non-modal overflow actions immediately without deferring them', async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const view = await renderComponent(
      <MrtRowActions>
        <MrtRowActionButton label="Редагувати" onClick={onEdit} icon={<span>edit-icon</span>} />
        <MrtRowActionButton
          label="Видалити"
          onClick={onDelete}
          icon={<span>delete-icon</span>}
          tone="danger"
          opensModal
        />
      </MrtRowActions>,
    );
    rendered.push(view);

    await click(getButtons(view.container)[0]!);

    const blurSpy = vi.spyOn(HTMLElement.prototype, 'blur');
    blurSpy.mockClear();

    const menuButtons = Array.from(
      view.container.querySelectorAll('[data-testid="overflow-menu"] button'),
    );
    await click(menuButtons[0]!);

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(blurSpy).not.toHaveBeenCalled();
    blurSpy.mockRestore();
  });

  it('keeps disabled overflow actions disabled in the menu', async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onArchive = vi.fn();
    const view = await renderComponent(
      <MrtRowActions>
        <MrtRowActionButton label="Редагувати" onClick={onEdit} icon={<span>edit-icon</span>} />
        <MrtRowActionButton
          label="Видалити"
          onClick={onDelete}
          icon={<span>delete-icon</span>}
          tone="danger"
          disabled
        />
        <MrtRowActionButton
          label="Архівувати"
          onClick={onArchive}
          icon={<span>archive-icon</span>}
        />
      </MrtRowActions>,
    );
    rendered.push(view);

    await click(getButtons(view.container)[0]!);

    const menuButtons = Array.from(
      view.container.querySelectorAll('[data-testid="overflow-menu"] button'),
    );
    expect(menuButtons[0]?.disabled).toBe(false);
    expect(menuButtons[1]?.disabled).toBe(true);
    expect(menuButtons[2]?.disabled).toBe(false);
  });
});
