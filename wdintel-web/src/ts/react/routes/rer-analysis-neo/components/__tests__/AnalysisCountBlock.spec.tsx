/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ButtonBase: ({
    children,
    onClick,
    'aria-label': ariaLabel,
    'aria-pressed': ariaPressed,
  }: {
    children: ReactNode;
    onClick?: () => void;
    'aria-label'?: string;
    'aria-pressed'?: boolean;
  }) => (
    <button type="button" onClick={onClick} aria-label={ariaLabel} aria-pressed={ariaPressed}>
      {children}
    </button>
  ),
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  CircularProgress: () => <div>loading-spinner</div>,
  Collapse: ({ children, in: open }: { children: ReactNode; in: boolean }) =>
    open ? <div>{children}</div> : null,
  IconButton: ({
    children,
    onClick,
    'aria-label': ariaLabel,
    'aria-expanded': ariaExpanded,
  }: {
    children: ReactNode;
    onClick?: () => void;
    'aria-label'?: string;
    'aria-expanded'?: boolean;
  }) => (
    <button type="button" onClick={onClick} aria-label={ariaLabel} aria-expanded={ariaExpanded}>
      {children}
    </button>
  ),
  List: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ListItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Paper: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  Skeleton: () => <div>loading-skeleton</div>,
  InputBase: ({
    value,
    onChange,
    placeholder,
    inputProps,
  }: {
    value: string;
    onChange: (event: { target: { value: string } }) => void;
    placeholder?: string;
    inputProps?: { 'aria-label'?: string };
  }) => (
    <input
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      aria-label={inputProps?.['aria-label']}
    />
  ),
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@mui/icons-material/Close', () => ({ default: () => <span>close</span> }));
vi.mock('@mui/icons-material/ExpandLess', () => ({ default: () => <span>up</span> }));
vi.mock('@mui/icons-material/ExpandMore', () => ({ default: () => <span>down</span> }));
vi.mock('@mui/icons-material/Search', () => ({ default: () => <span>search</span> }));

import { vi } from 'vitest';

import type { AnalysisCountItem } from '../../types';
import { AnalysisCountBlock } from '.././AnalysisCountBlock';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

async function renderComponent(items: AnalysisCountItem[], loading = false): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<AnalysisCountBlock title="Локації" items={items} loading={loading} />);
  });

  return { container, root };
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function typeInInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

// @test-scope safeguard: preserves analysis filter metric selection, loading, search, and disclosure interactions so users cannot mistake stale or hidden counts for current selections.
describe('AnalysisCountBlock', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('shows a button to reveal hidden metrics and expands the full list', async () => {
    const items = Array.from({ length: 14 }, (_value, index) => ({
      key: `Локація ${index + 1}`,
      count: 20 - index,
    }));
    const view = await renderComponent(items);
    rendered.push(view);

    expect(view.container.textContent).toContain('Локація 12');
    expect(view.container.textContent).not.toContain('Локація 13');
    expect(view.container.textContent).toContain('Показати ще (2)');

    await click(getButton(view.container, 'Показати ще'));

    expect(view.container.textContent).toContain('Локація 13');
    expect(view.container.textContent).toContain('Локація 14');
    expect(view.container.textContent).toContain('Згорнути');
  });

  it('does not render expand control when all metrics are already visible', async () => {
    const items = Array.from({ length: 3 }, (_value, index) => ({
      key: `Частота ${index + 1}`,
      count: 3 - index,
    }));
    const view = await renderComponent(items);
    rendered.push(view);

    expect(view.container.textContent).not.toContain('Показати ще');
    expect(view.container.textContent).not.toContain('Згорнути');
  });

  it('opens inline search and filters items case-insensitively', async () => {
    const view = await renderComponent([
      { key: 'ВАСИЛІВКА', count: 8 },
      { key: 'Кам’янське', count: 5 },
    ]);
    rendered.push(view);

    const searchButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Пошук у Локації"]',
    );
    expect(view.container.querySelector('input')).toBeNull();

    await click(searchButton as HTMLButtonElement);

    const input = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Пошук у Локації"]',
    );
    expect(input).not.toBeNull();
    await typeInInput(input as HTMLInputElement, 'васил');

    expect(view.container.textContent).toContain('ВАСИЛІВКА');
    expect(view.container.textContent).not.toContain('Кам’янське');

    const closeButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Закрити пошук у Локації"]',
    );
    await click(closeButton as HTMLButtonElement);

    expect(view.container.querySelector('input')).toBeNull();
    expect(view.container.textContent).toContain('Кам’янське');
  });

  it('collapses and restores the section from the header control', async () => {
    const view = await renderComponent([{ key: 'Unit A', count: 11 }]);
    rendered.push(view);

    const collapseButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Згорнути Локації"]',
    );
    expect(collapseButton?.getAttribute('aria-expanded')).toBe('true');
    expect(view.container.textContent).toContain('Unit A');

    await click(collapseButton as HTMLButtonElement);

    const expandButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Розгорнути Локації"]',
    );
    expect(expandButton?.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.textContent).not.toContain('Unit A');

    await click(expandButton as HTMLButtonElement);
    expect(view.container.textContent).toContain('Unit A');
  });

  it('does not render an empty primary row for blank metric labels', async () => {
    const view = await renderComponent([{ key: '   ', count: 162 }]);
    rendered.push(view);

    expect(view.container.textContent).toContain('Повідомлень: 162');
    expect(view.container.textContent).toContain('Локації');
    expect(view.container.textContent).not.toContain('   ');
    expect(view.container.textContent).not.toContain('Немає даних');
  });

  it('shows the summary count next to the heading and keeps detail items in the grid', async () => {
    const view = await renderComponent([
      { key: '   ', count: 162 },
      { key: '152.8000', count: 62 },
      { key: '147.3750', count: 51 },
    ]);
    rendered.push(view);

    expect(view.container.textContent).toContain('Локації');
    expect(view.container.textContent).toContain('Повідомлень: 162');
    expect(view.container.textContent).toContain('152.8000');
    expect(view.container.textContent).toContain('147.3750');
  });

  it('shows loading placeholders instead of the empty state while data is loading', async () => {
    const view = await renderComponent([], true);
    rendered.push(view);

    expect(view.container.textContent).toContain('loading-skeleton');
    expect(view.container.textContent).not.toContain('Немає даних');
  });

  it('renders an item action and wires it to the clicked metric', async () => {
    const onItemAction = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered.push({ container, root });

    await act(async () => {
      root.render(
        <AnalysisCountBlock
          title="Частоти"
          items={[{ key: '143.5750', count: 67 }]}
          onItemAction={onItemAction}
          itemActionLabel="У фільтр"
        />,
      );
    });

    await click(getButton(container, 'У фільтр'));

    expect(onItemAction).toHaveBeenCalledWith('143.5750');
  });

  it('toggles selectable rows and marks selected items with a remove control', async () => {
    const onItemAdd = vi.fn();
    const onItemToggle = vi.fn();
    const onClearSelection = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered.push({ container, root });

    await act(async () => {
      root.render(
        <AnalysisCountBlock
          title="Підрозділи"
          items={[
            { key: 'Unit A', count: 11 },
            { key: 'Unit B', count: 5 },
          ]}
          onItemAdd={onItemAdd}
          onItemToggle={onItemToggle}
          onClearSelection={onClearSelection}
          selectedItemKeys={['Unit A']}
        />,
      );
    });

    const selected = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Прибрати Unit A з фільтра"]',
    );
    const unselected = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Вибрати лише Unit B"]',
    );
    const add = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Додати Unit B до поточного фільтра"]',
    );
    expect(selected?.getAttribute('aria-pressed')).toBe('true');
    expect(selected?.textContent).toContain('×');
    expect(
      container.querySelector('button[aria-label="Скинути фільтр Підрозділи"]'),
    ).not.toBeNull();
    expect(unselected?.getAttribute('aria-pressed')).toBe('false');
    expect(unselected?.textContent).not.toContain('×');
    expect(add?.textContent).toContain('+');

    await click(selected as HTMLButtonElement);
    await click(unselected as HTMLButtonElement);
    await click(add as HTMLButtonElement);

    expect(onItemToggle).toHaveBeenNthCalledWith(1, 'Unit A');
    expect(onItemToggle).toHaveBeenNthCalledWith(2, 'Unit B');
    expect(onItemAdd).toHaveBeenCalledWith('Unit B');
  });

  it('keeps the selection pill visible when the selected item is folded away', async () => {
    const onClearSelection = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const view = { container, root: createRoot(container) };
    rendered.push(view);

    await act(async () => {
      view.root.render(
        <AnalysisCountBlock
          title="Підрозділи"
          items={Array.from({ length: 13 }, (_value, index) => ({
            key: `Unit ${index + 1}`,
            count: 20 - index,
          }))}
          onClearSelection={onClearSelection}
          onItemToggle={vi.fn()}
          selectedItemKeys={['Unit 13']}
        />,
      );
    });

    const clearButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Скинути фільтр Підрозділи"]',
    );
    expect(clearButton).not.toBeNull();
    expect(view.container.textContent).not.toContain('Unit 13');

    const collapseButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Згорнути Підрозділи"]',
    );
    await click(collapseButton as HTMLButtonElement);
    expect(
      view.container.querySelector('button[aria-label="Скинути фільтр Підрозділи"]'),
    ).not.toBeNull();

    await click(clearButton as HTMLButtonElement);
    expect(onClearSelection).toHaveBeenCalledOnce();
  });

  it('uses a separate filter value while keeping the display label', async () => {
    const onItemAdd = vi.fn();
    const onItemToggle = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered.push({ container, root });

    await act(async () => {
      root.render(
        <AnalysisCountBlock
          title="Мережі"
          items={[
            { key: '💻 4 зБпС 50 обрБпС', value: '5', count: 11 },
            { key: 'інша мережа', value: '7', count: 3 },
          ]}
          onItemAdd={onItemAdd}
          onItemToggle={onItemToggle}
          selectedItemKeys={['5']}
        />,
      );
    });

    const selected = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Прибрати 💻 4 зБпС 50 обрБпС з фільтра"]',
    );
    const add = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Додати інша мережа до поточного фільтра"]',
    );

    expect(selected?.getAttribute('aria-pressed')).toBe('true');
    await click(selected as HTMLButtonElement);
    await click(add as HTMLButtonElement);

    expect(onItemToggle).toHaveBeenCalledWith('5');
    expect(onItemAdd).toHaveBeenCalledWith('7');
  });
});
