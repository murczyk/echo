/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

vi.mock('@mui/material', () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  CircularProgress: () => <span>loading</span>,
  Paper: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../components/PowerChip', () => ({
  PowerChip: ({ label }: { label: ReactNode }) => <div>{label}</div>,
}));

import { vi } from 'vitest';

import type { AnalysisCountItem } from '../types';
import { AnalysisCallsignsCloudCard } from './AnalysisCallsignsCloudCard';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

async function renderComponent(items: AnalysisCountItem[], loading = false): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<AnalysisCallsignsCloudCard items={items} loading={loading} />);
  });

  return { container, root };
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

describe('AnalysisCallsignsCloudCard', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('shows only the top 12 callsigns by default and expands the rest on demand', async () => {
    const items = Array.from({ length: 14 }, (_value, index) => ({
      key: `Позивний ${index + 1}`,
      count: 30 - index,
    }));
    const view = await renderComponent(items);
    rendered.push(view);

    expect(view.container.textContent).toContain('Позивний 12');
    expect(view.container.textContent).not.toContain('Позивний 13');
    expect(view.container.textContent).toContain('Показати ще (2)');

    await click(getButton(view.container, 'Показати ще'));

    expect(view.container.textContent).toContain('Позивний 13');
    expect(view.container.textContent).toContain('Позивний 14');
    expect(view.container.textContent).toContain('Згорнути');
  });

  it('shows the empty state when there are no callsigns', async () => {
    const view = await renderComponent([]);
    rendered.push(view);

    expect(view.container.textContent).toContain('Немає даних');
    expect(view.container.textContent).not.toContain('Показати ще');
  });

  it('keeps existing callsign chips visible while refreshing', async () => {
    const view = await renderComponent(
      [
        { key: 'Позивний 1', count: 4 },
        { key: 'Позивний 2', count: 2 },
      ],
      true,
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('Позивний 1');
    expect(view.container.textContent).toContain('Позивний 2');
    expect(view.container.textContent).toContain('Оновлюється...');
    expect(view.container.textContent).not.toContain('Завантаження...');
  });

  it('shows the loading state before the first callsigns arrive', async () => {
    const view = await renderComponent([], true);
    rendered.push(view);

    expect(view.container.textContent).toContain('Завантаження...');
    expect(view.container.textContent).not.toContain('Оновлюється...');
  });
});
