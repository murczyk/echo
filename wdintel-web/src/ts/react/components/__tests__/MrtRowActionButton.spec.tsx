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

vi.mock('../PowerIconButton', () => ({
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

vi.mock('../PowerMenu', () => ({
  PowerMenu: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div data-testid="overflow-menu">{children}</div> : null,
}));

import { MrtRowActionButton, MrtRowActions } from '../MrtRowActionButton';

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
