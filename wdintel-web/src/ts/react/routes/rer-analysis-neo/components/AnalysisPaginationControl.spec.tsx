/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
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
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@mui/icons-material/ChevronLeftOutlined', () => ({ default: () => <span>left</span> }));
vi.mock('@mui/icons-material/ChevronRightOutlined', () => ({ default: () => <span>right</span> }));

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
    noMoreToLoad: false,
    busy: false,
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
    expect(view.container.textContent).toContain('1-20 з 137');
  });

  it('renders the range text for a later page', async () => {
    const view = await renderComponent(baseProps());
    rendered.push(view);
    view.root.render(
      <AnalysisPaginationControl {...baseProps()} pageIndex={2} messagesCount={17} />,
    );
    await act(async () => {});
    expect(view.container.textContent).toContain('41-57 з 137');
  });

  it('falls back to em dash while totals are loading', async () => {
    const view = await renderComponent(
      baseProps() && { ...baseProps(), totalCount: null, totalLoading: true },
    );
    rendered.push(view);
    expect(view.container.textContent).toContain('— з —');
  });

  it('always renders a loaded total count', async () => {
    const view = await renderComponent({ ...baseProps(), totalCount: 0, noMoreToLoad: false });
    rendered.push(view);
    expect(view.container.textContent).toContain('1-20 з 0');
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
