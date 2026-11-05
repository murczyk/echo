/**
 * @vitest-environment happy-dom
 */
import { act, Suspense, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Autocomplete: (props: { inputValue?: string; renderInput: (params: object) => ReactNode }) =>
    props.renderInput({ InputProps: {}, inputProps: { value: props.inputValue } }),
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
  InputBase: (props: {
    placeholder?: string;
    value?: string;
    onChange?: (event: { target: { value: string } }) => void;
    inputProps?: { 'aria-label'?: string };
  }) => (
    <input
      aria-label={props.inputProps?.['aria-label']}
      placeholder={props.placeholder}
      value={props.value ?? ''}
      onChange={(event) => props.onChange?.({ target: { value: event.currentTarget.value } })}
    />
  ),
  Paper: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Popover: (props: { open?: boolean; children: ReactNode }) =>
    props.open ? <div>{props.children}</div> : null,
  Tooltip: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextField: (props: {
    placeholder?: string;
    label?: string;
    type?: string;
    value?: string;
    onClick?: () => void;
    onChange?: (event: { target: { value: string } }) => void;
    inputProps?: { 'aria-label'?: string; value?: string };
    InputProps?: { startAdornment?: ReactNode; endAdornment?: ReactNode };
    slotProps?: {
      input?: {
        startAdornment?: ReactNode;
        endAdornment?: ReactNode;
      };
    };
  }) => (
    <label onClick={props.onClick}>
      <span>{props.label ?? props.placeholder}</span>
      {props.InputProps?.startAdornment ?? props.slotProps?.input?.startAdornment}
      <input
        aria-label={props.inputProps?.['aria-label']}
        type={props.type ?? 'text'}
        value={props.value ?? props.inputProps?.value ?? ''}
        onChange={(event) => props.onChange?.({ target: { value: event.currentTarget.value } })}
      />
      {props.InputProps?.endAdornment ?? props.slotProps?.input?.endAdornment}
    </label>
  ),
}));

import { AnalysisHeaderControls } from '.././AnalysisHeaderControls';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function buildProps(
  overrides: Partial<ComponentProps<typeof AnalysisHeaderControls>> = {},
): ComponentProps<typeof AnalysisHeaderControls> {
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

async function renderComponent(
  props: ComponentProps<typeof AnalysisHeaderControls>,
): Promise<Rendered> {
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

  it('clears search when the close icon is clicked', async () => {
    const updateQueryState = vi.fn();
    const view = await renderComponent(buildProps({ updateQueryState }));
    rendered.push(view);

    const clearButton = view.container.querySelector('button[aria-label="Очистити пошук"]');
    expect(clearButton).toBeTruthy();

    await click(clearButton as HTMLButtonElement);

    expect(updateQueryState).toHaveBeenCalledWith({ search: '' });
  });

  it('expands compact search from an icon and clears it when closed', async () => {
    const updateQueryState = vi.fn();
    const view = await renderComponent(
      buildProps({
        isCompactLayout: true,
        updateQueryState,
        queryState: {
          search: '',
          fromDateTimeStr: '2026-03-27T21:52',
          toDateTimeStr: '2026-03-28T09:52',
        },
      }),
    );
    rendered.push(view);

    expect(view.container.querySelector('input[aria-label="Пошук"]')).toBeNull();
    expect(
      view.container.querySelector('button[aria-label="Інтервал: 27.03 21:52 — 28.03 09:52"]'),
    ).not.toBeNull();
    await click(
      view.container.querySelector('button[aria-label="Відкрити пошук"]') as HTMLButtonElement,
    );
    expect(view.container.querySelector('input[aria-label="Пошук"]')).not.toBeNull();

    await click(
      view.container.querySelector(
        'button[aria-label="Очистити й закрити пошук"]',
      ) as HTMLButtonElement,
    );

    expect(updateQueryState).toHaveBeenCalledWith({ search: '' });
    expect(view.container.querySelector('input[aria-label="Пошук"]')).toBeNull();
  });

  it('#4019 closes compact search while cleared results are still pending', async () => {
    let resumeResults: () => void;
    let resultsPending = true;
    const pendingResults = new Promise<void>((resolve) => {
      resumeResults = () => {
        resultsPending = false;
        resolve();
      };
    });
    function Results({ search }: { search: string }) {
      if (!search && resultsPending) throw pendingResults;
      return <output>{search || 'All messages'}</output>;
    }
    function Page() {
      const [queryState, setQueryState] = useState(buildProps().queryState);
      return (
        <Suspense fallback={<p>Loading results</p>}>
          <AnalysisHeaderControls
            isCompactLayout
            queryState={queryState}
            updateQueryState={(patch) => setQueryState((current) => ({ ...current, ...patch }))}
          />
          <Results search={queryState.search ?? ''} />
        </Suspense>
      );
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered.push({ container, root });
    await act(async () => root.render(<Page />));
    await click(
      container.querySelector('button[aria-label="Очистити й закрити пошук"]') as HTMLButtonElement,
    );

    expect(container.querySelector('input[aria-label="Пошук"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Відкрити пошук"]')).not.toBeNull();
    expect(container.querySelector('output')?.textContent).toBe('uid-1');
    expect(container.textContent).not.toContain('Loading results');
    await click(
      container.querySelector('button[aria-label="Відкрити пошук"]') as HTMLButtonElement,
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Пошук"]')?.value).toBe('');

    await act(async () => resumeResults());

    expect(container.querySelector('output')?.textContent).toBe('All messages');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Пошук"]')?.value).toBe('');
  });

  it('opens the datetime popover with split from/to inputs', async () => {
    const view = await renderComponent(buildProps());
    rendered.push(view);

    const field = Array.from(view.container.querySelectorAll('input')).find((item) =>
      item.value.includes('27.03 21:52 — 28.03 09:52'),
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
      item.value.includes('27.03 21:52 — 28.03 09:52'),
    );
    expect(field).toBeTruthy();

    await click(field as HTMLInputElement);
    const preset = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.textContent === '3 дн',
    );
    expect(preset).toBeTruthy();

    await click(preset as HTMLButtonElement);

    expect(updateQueryState).toHaveBeenCalledWith({
      fromDateTimeStr: '2026-05-10T17:42',
      toDateTimeStr: '2026-05-13T17:42',
    });
  });
});
