/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: (props: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={props.onClick}>
      {props.children}
    </button>
  ),
  IconButton: (props: { children: ReactNode; onClick?: () => void; 'aria-label'?: string }) => (
    <button type="button" aria-label={props['aria-label']} onClick={props.onClick}>
      {props.children}
    </button>
  ),
  InputAdornment: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Paper: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Popover: (props: { open?: boolean; children: ReactNode }) => (props.open ? <div>{props.children}</div> : null),
  Tooltip: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: (props: {
    placeholder?: string;
    label?: string;
    type?: string;
    value?: string;
    onClick?: () => void;
    onChange?: (event: { target: { value: string } }) => void;
    slotProps?: {
      input?: {
        startAdornment?: ReactNode;
        endAdornment?: ReactNode;
      };
    };
  }) => (
    <label onClick={props.onClick}>
      <span>{props.label ?? props.placeholder}</span>
      {props.slotProps?.input?.startAdornment}
      <input
        type={props.type ?? 'text'}
        value={props.value ?? ''}
        onChange={(event) => props.onChange?.({ target: { value: event.currentTarget.value } })}
      />
      {props.slotProps?.input?.endAdornment}
    </label>
  ),
}));

import { AnalysisHeaderControls } from './AnalysisHeaderControls';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function buildProps(overrides: Partial<ComponentProps<typeof AnalysisHeaderControls>> = {}): ComponentProps<typeof AnalysisHeaderControls> {
  return {
    queryState: {
      search: 'uid-1',
      fromDateTimeStr: '2026-03-27T21:52',
      toDateTimeStr: '2026-03-28T09:52',
    },
    updateQueryState: vi.fn(),
    ...overrides,
  };
}

async function renderComponent(props: ComponentProps<typeof AnalysisHeaderControls>): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AnalysisHeaderControls {...props} />);
  });
  return { container, root };
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

describe('AnalysisHeaderControls', () => {
  const rendered: Rendered[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T14:42:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('renders search and combined datetime interval controls', async () => {
    const view = await renderComponent(buildProps());
    rendered.push(view);

    expect(view.container.querySelector('input[value="uid-1"]')).toBeTruthy();
    expect(view.container.querySelector('input[value="27.03.2026 21:52 — 28.03.2026 09:52"]')).toBeTruthy();
    expect(view.container.querySelector('button[aria-label="Очистити пошук"]')).toBeTruthy();
  });

  it('clears search when the close icon is clicked', async () => {
    const updateQueryState = vi.fn();
    const view = await renderComponent(buildProps({ updateQueryState }));
    rendered.push(view);

    const clearButton = view.container.querySelector('button[aria-label="Очистити пошук"]');
    expect(clearButton).toBeTruthy();

    await click(clearButton as HTMLButtonElement);

    expect(updateQueryState).toHaveBeenCalledWith({ search: '' });
  });

  it('opens the datetime popover with split from/to inputs', async () => {
    const view = await renderComponent(buildProps());
    rendered.push(view);

    const field = Array.from(view.container.querySelectorAll('input')).find((item) =>
      item.value.includes('27.03.2026 21:52 — 28.03.2026 09:52'),
    );
    expect(field).toBeTruthy();

    await click(field as HTMLInputElement);

    expect(view.container.textContent).toContain('Від');
    expect(view.container.textContent).toContain('До');
    expect(view.container.querySelectorAll('input').length).toBeGreaterThanOrEqual(3);
  });

  it('applies datetime quick interval presets on click', async () => {
    const updateQueryState = vi.fn();
    const view = await renderComponent(buildProps({ updateQueryState }));
    rendered.push(view);

    const field = Array.from(view.container.querySelectorAll('input')).find((item) =>
      item.value.includes('27.03.2026 21:52 — 28.03.2026 09:52'),
    );
    expect(field).toBeTruthy();

    await click(field as HTMLInputElement);
    const preset = Array.from(view.container.querySelectorAll('button')).find((button) => button.textContent === '3 дн');
    expect(preset).toBeTruthy();

    await click(preset as HTMLButtonElement);

    expect(updateQueryState).toHaveBeenCalledWith({
      fromDateTimeStr: '2026-05-10T17:42',
      toDateTimeStr: '2026-05-13T17:42',
    });
  });
});
