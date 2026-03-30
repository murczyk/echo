/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  List: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ListItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Paper: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  Skeleton: () => <div>loading-skeleton</div>,
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { vi } from 'vitest';

import type { AnalysisCountItem } from '../types';
import { AnalysisCountBlock } from './AnalysisCountBlock';

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

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(label));
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

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
});
