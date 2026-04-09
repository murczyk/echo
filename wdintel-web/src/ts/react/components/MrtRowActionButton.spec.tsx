/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('./mui-customized/icon-button', () => ({
  IconButton: ({
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

vi.mock('./mui-customized/menu', () => ({
  Menu: ({
    children,
    open,
  }: {
    children: ReactNode;
    open: boolean;
  }) => (open ? <div data-testid="overflow-menu">{children}</div> : null),
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
  it('uses compact fixed widths for grid and single-action layouts', () => {
    expect(mrtRowActionsColumnSize(1)).toBe(48);
    expect(mrtRowActionsColumnSize(5, 'grid')).toBe(84);
  });

  it('keeps 3-plus action rows at a stable width for the primary action and overflow menu', () => {
    expect(mrtRowActionsColumnSize(2)).toBe(78);
    expect(mrtRowActionsColumnSize(3)).toBe(78);
    expect(mrtRowActionsColumnSize(4)).toBe(78);
  });
});

describe('MrtRowActions', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('keeps one and two actions visible without rendering overflow menu', async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const view = await renderComponent(
      <MrtRowActions>
        <MrtRowActionButton label="Редагувати" onClick={onEdit} icon={<span>edit-icon</span>} />
        <MrtRowActionButton label="Видалити" onClick={onDelete} icon={<span>delete-icon</span>} tone="danger" />
      </MrtRowActions>,
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('edit-icon');
    expect(view.container.textContent).toContain('delete-icon');
    expect(view.container.textContent).not.toContain('more-icon');
    expect(view.container.querySelector('[data-testid="overflow-menu"]')).toBeNull();
  });

  it('keeps only the first action visible and moves the rest into overflow menu for 3-plus actions', async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onArchive = vi.fn();
    const view = await renderComponent(
      <MrtRowActions>
        <MrtRowActionButton label="Редагувати" onClick={onEdit} icon={<span>edit-icon</span>} />
        <MrtRowActionButton label="Видалити" onClick={onDelete} icon={<span>delete-icon</span>} tone="danger" />
        <MrtRowActionButton label="Архівувати" onClick={onArchive} icon={<span>archive-icon</span>} />
      </MrtRowActions>,
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('edit-icon');
    expect(view.container.textContent).toContain('more-icon');
    expect(view.container.textContent).not.toContain('delete-icon');
    expect(view.container.textContent).not.toContain('archive-icon');

    const buttonsBeforeOpen = getButtons(view.container);
    expect(buttonsBeforeOpen).toHaveLength(2);

    await click(buttonsBeforeOpen[1]!);

    expect(view.container.textContent).toContain('Видалити');
    expect(view.container.textContent).toContain('Архівувати');
    expect(view.container.textContent).toContain('delete-icon');
    expect(view.container.textContent).toContain('archive-icon');

    const menuButtons = getButtons(view.container);
    await click(menuButtons[2]!);

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('applies the same overflow rule to explicit grid layouts with 3-plus actions', async () => {
    const view = await renderComponent(
      <MrtRowActions layout="grid">
        <MrtRowActionButton label="Перезапустити" onClick={() => {}} icon={<span>restart-icon</span>} />
        <MrtRowActionButton label="Редагувати" onClick={() => {}} icon={<span>edit-icon</span>} />
        <MrtRowActionButton label="Підключити" onClick={() => {}} icon={<span>connect-icon</span>} />
        <MrtRowActionButton label="Видалити" onClick={() => {}} icon={<span>delete-icon</span>} tone="danger" />
      </MrtRowActions>,
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('restart-icon');
    expect(view.container.textContent).toContain('more-icon');
    expect(view.container.textContent).not.toContain('edit-icon');
    expect(view.container.textContent).not.toContain('connect-icon');
    expect(view.container.textContent).not.toContain('delete-icon');
  });

  it('keeps disabled overflow actions disabled in the menu', async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onArchive = vi.fn();
    const view = await renderComponent(
      <MrtRowActions>
        <MrtRowActionButton label="Редагувати" onClick={onEdit} icon={<span>edit-icon</span>} />
        <MrtRowActionButton label="Видалити" onClick={onDelete} icon={<span>delete-icon</span>} tone="danger" disabled />
        <MrtRowActionButton label="Архівувати" onClick={onArchive} icon={<span>archive-icon</span>} />
      </MrtRowActions>,
    );
    rendered.push(view);

    await click(getButtons(view.container)[1]!);

    const menuButtons = getButtons(view.container);
    expect(menuButtons[2]?.disabled).toBe(true);
    expect(menuButtons[3]?.disabled).toBe(false);
  });
});
