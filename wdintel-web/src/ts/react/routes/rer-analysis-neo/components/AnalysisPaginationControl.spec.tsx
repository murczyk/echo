/**
 * @vitest-environment happy-dom
 */
import { act, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  ButtonBase: (props: {
    children: ReactNode;
    onClick?: (event: React.MouseEvent<HTMLElement>) => void;
    onMouseEnter?: (event: React.MouseEvent<HTMLElement>) => void;
    onMouseLeave?: () => void;
    disabled?: boolean;
    'aria-label'?: string;
    'aria-controls'?: string;
    'aria-expanded'?: boolean;
    'aria-haspopup'?: string;
  }) => (
    <button
      type="button"
      onClick={props.onClick}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      disabled={props.disabled}
      aria-label={props['aria-label']}
      aria-controls={props['aria-controls']}
      aria-expanded={props['aria-expanded']}
      aria-haspopup={props['aria-haspopup']}
    >
      {props.children}
    </button>
  ),
  ClickAwayListener: (props: { children: ReactNode; onClickAway: (event: MouseEvent) => void }) => {
    useEffect(() => {
      const onClick = (event: MouseEvent) => props.onClickAway(event);
      document.addEventListener('click', onClick);
      return () => document.removeEventListener('click', onClick);
    }, [props.onClickAway]);
    return props.children;
  },
  IconButton: (props: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    'aria-label'?: string;
  }) => (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props['aria-label']}
    >
      {props.children}
    </button>
  ),
  MenuItem: (props: { children: ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" role="menuitem" disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
  MenuList: ({ children, id }: { children: ReactNode; id?: string }) => (
    <div role="menu" id={id}>
      {children}
    </div>
  ),
  Paper: (props: { children: ReactNode; onMouseEnter?: () => void; onMouseLeave?: () => void }) => (
    <div onMouseEnter={props.onMouseEnter} onMouseLeave={props.onMouseLeave}>
      {props.children}
    </div>
  ),
  Popper: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@mui/icons-material/ChevronLeftOutlined', () => ({ default: () => <span>left</span> }));
vi.mock('@mui/icons-material/ChevronRightOutlined', () => ({ default: () => <span>right</span> }));
vi.mock('@mui/icons-material/FirstPageOutlined', () => ({ default: () => <span>first</span> }));
vi.mock('@mui/icons-material/LastPageOutlined', () => ({ default: () => <span>last</span> }));

import { AnalysisPaginationControl } from './AnalysisPaginationControl';

type Rendered = { container: HTMLDivElement; root: Root };

async function renderComponent(
  props: React.ComponentProps<typeof AnalysisPaginationControl>,
): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AnalysisPaginationControl {...props} />);
  });
  return { container, root };
}

function baseProps(): React.ComponentProps<typeof AnalysisPaginationControl> {
  return {
    centerTab: 'messages',
    pageIndex: 0,
    pageSize: 20,
    messagesCount: 20,
    totalCount: 137,
    totalLoading: false,
    loading: false,
    noMoreToLoad: false,
    busy: false,
    onFirstPage: vi.fn(),
    onLastPage: vi.fn(),
    onPrevPage: vi.fn(),
    onNextPage: vi.fn(),
  };
}

describe('AnalysisPaginationControl', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => item.root.unmount());
      item.container.remove();
    }
  });

  it('renders the range text for the first page', async () => {
    const view = await renderComponent(baseProps());
    rendered.push(view);
    expect(view.container.textContent).toContain('Сторінка 1 · 137 повідомлень');
  });

  it('renders the range text for a later page', async () => {
    const view = await renderComponent(baseProps());
    rendered.push(view);
    view.root.render(
      <AnalysisPaginationControl {...baseProps()} pageIndex={2} messagesCount={17} />,
    );
    await act(async () => {});
    expect(view.container.textContent).toContain('Сторінка 3 · 137 повідомлень');
  });

  it('falls back to em dash while totals are loading', async () => {
    const view = await renderComponent(
      baseProps() && { ...baseProps(), totalCount: null, totalLoading: true },
    );
    rendered.push(view);
    expect(view.container.textContent).toContain('20 повідомлень');
  });

  it('falls back to em dash while replacement messages are loading', async () => {
    const view = await renderComponent({ ...baseProps(), messagesCount: 1, loading: true });
    rendered.push(view);
    expect(view.container.textContent).toContain('1 повідомлень');
    expect(view.container.textContent).not.toContain('Сторінка 1 · 137 повідомлень');
  });

  it('always renders a loaded total count', async () => {
    const view = await renderComponent({ ...baseProps(), totalCount: 0, noMoreToLoad: false });
    rendered.push(view);
    expect(view.container.textContent).toContain('Сторінка 1 · 0 повідомлень');
  });

  it('opens the first/last page menu when the counter is clicked or hovered', async () => {
    const view = await renderComponent(baseProps());
    rendered.push(view);
    const counter = view.container.querySelector(
      '[aria-label="Перейти до першої або останньої сторінки"]',
    ) as HTMLButtonElement;

    await act(async () => {
      counter.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.container.querySelector('[role="menu"]')?.textContent).toContain('Перша сторінка');

    await act(async () => {
      counter.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      counter.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.container.querySelector('[role="menu"]')?.textContent).toContain(
      'Остання сторінка',
    );
  });

  it('wires first and last page menu actions', async () => {
    const onFirstPage = vi.fn();
    const onLastPage = vi.fn();
    const view = await renderComponent({
      ...baseProps(),
      pageIndex: 1,
      onFirstPage,
      onLastPage,
    });
    rendered.push(view);
    const counter = view.container.querySelector(
      '[aria-label="Перейти до першої або останньої сторінки"]',
    ) as HTMLButtonElement;

    await act(async () => {
      counter.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const firstPage = Array.from(view.container.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Перша сторінка'),
    ) as HTMLButtonElement;
    await act(async () => {
      firstPage.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      counter.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const lastPage = Array.from(view.container.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.includes('Остання сторінка'),
    ) as HTMLButtonElement;
    await act(async () => {
      lastPage.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onFirstPage).toHaveBeenCalledTimes(1);
    expect(onLastPage).toHaveBeenCalledTimes(1);
  });

  it('disables the left chevron on the first page', async () => {
    const view = await renderComponent(baseProps());
    rendered.push(view);
    const left = view.container.querySelector('[aria-label="Попередня сторінка"]');
    expect(left).not.toBeNull();
    expect((left as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables the left chevron on a later page', async () => {
    const view = await renderComponent({ ...baseProps(), pageIndex: 1 });
    rendered.push(view);
    const left = view.container.querySelector('[aria-label="Попередня сторінка"]');
    expect((left as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables the right chevron when noMoreToLoad is true', async () => {
    const view = await renderComponent({ ...baseProps(), noMoreToLoad: true });
    rendered.push(view);
    const right = view.container.querySelector('[aria-label="Наступна сторінка"]');
    expect((right as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables the right chevron while busy', async () => {
    const view = await renderComponent({ ...baseProps(), busy: true });
    rendered.push(view);
    const right = view.container.querySelector('[aria-label="Наступна сторінка"]');
    expect((right as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables both chevrons when the active tab is not messages', async () => {
    const view = await renderComponent({ ...baseProps(), centerTab: 'map', pageIndex: 1 });
    rendered.push(view);
    const left = view.container.querySelector('[aria-label="Попередня сторінка"]');
    const right = view.container.querySelector('[aria-label="Наступна сторінка"]');
    expect((left as HTMLButtonElement).disabled).toBe(true);
    expect((right as HTMLButtonElement).disabled).toBe(true);
  });

  it('wires clicks to onPrevPage/onNextPage', async () => {
    const onPrevPage = vi.fn();
    const onNextPage = vi.fn();
    const view = await renderComponent({
      ...baseProps(),
      pageIndex: 1,
      onPrevPage,
      onNextPage,
    });
    rendered.push(view);

    const left = view.container.querySelector(
      '[aria-label="Попередня сторінка"]',
    ) as HTMLButtonElement;
    const right = view.container.querySelector(
      '[aria-label="Наступна сторінка"]',
    ) as HTMLButtonElement;
    await act(async () => {
      left.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      right.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onPrevPage).toHaveBeenCalledTimes(1);
    expect(onNextPage).toHaveBeenCalledTimes(1);
  });
});
