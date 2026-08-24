/**
 * @vitest-environment happy-dom
 */
import { act, forwardRef } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Alert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Box: ({
    component: Component = 'div',
    children,
    ...rest
  }: {
    component?: any;
    children?: ReactNode;
  }) => <Component {...rest}>{children}</Component>,
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  CircularProgress: () => <div>loading</div>,
  Paper: forwardRef<HTMLElement, { children?: ReactNode }>(({ children }, ref) => (
    <section ref={ref}>{children}</section>
  )),
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ToggleButton: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  ToggleButtonGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { NetworkDetailsActivityPanel } from './NetworkDetailsActivityPanel';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

async function renderComponent(
  props: ComponentProps<typeof NetworkDetailsActivityPanel>,
): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<NetworkDetailsActivityPanel {...props} />);
  });
  return { container, root };
}

describe('NetworkDetailsActivityPanel', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('shows a loading state before the activity data arrives', async () => {
    const view = await renderComponent({
      networkActivity: {},
      networkActivityPeriod: 'Last10Days',
      networkActivityLoading: false,
      networkActivityLoaded: false,
      networkActivityError: null,
      onNetworkActivityPeriodChange: vi.fn(),
      onReloadNetworkActivity: vi.fn(),
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('Завантажуємо активність мережі');
    expect(view.container.textContent).toContain('Активність мережі');
  });

  it('shows an empty state when all buckets are zero or missing', async () => {
    const view = await renderComponent({
      networkActivity: {
        '1711756800000': { Alpha: 0, Beta: 0 },
      },
      networkActivityPeriod: 'Last10Days',
      networkActivityLoading: false,
      networkActivityLoaded: true,
      networkActivityError: null,
      onNetworkActivityPeriodChange: vi.fn(),
      onReloadNetworkActivity: vi.fn(),
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('Немає даних активності');
    expect(view.container.textContent).toContain(
      'Активність буде доступна після першої фіксації сигналу',
    );
    expect(view.container.querySelector('svg[data-chart="network-activity"]')).toBeNull();
  });

  it('shows an error state with a retry action', async () => {
    const onReloadNetworkActivity = vi.fn();
    const view = await renderComponent({
      networkActivity: {},
      networkActivityPeriod: 'Last10Days',
      networkActivityLoading: false,
      networkActivityLoaded: false,
      networkActivityError: 'Помилка завантаження',
      onNetworkActivityPeriodChange: vi.fn(),
      onReloadNetworkActivity,
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('Помилка завантаження');
    const retryButton =
      [...view.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Спробувати ще раз'),
      ) ?? null;
    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onReloadNetworkActivity).toHaveBeenCalledTimes(1);
  });

  it('renders stacked bars and a tooltip with actual group names', async () => {
    const now = new Date(Date.now());
    const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const view = await renderComponent({
      networkActivity: {
        [String(todayUtcMs - 86400000)]: { Alpha: 2, Bravo: 4 },
        [String(todayUtcMs)]: { Alpha: 3, Charlie: 1 },
      },
      networkActivityPeriod: 'Last10Days',
      networkActivityLoading: false,
      networkActivityLoaded: true,
      networkActivityError: null,
      onNetworkActivityPeriodChange: vi.fn(),
      onReloadNetworkActivity: vi.fn(),
    });
    rendered.push(view);

    expect(view.container.querySelector('svg')).not.toBeNull();
    const bar = view.container.querySelector('[data-group="Bravo"]');
    expect(bar).not.toBeNull();

    await act(async () => {
      bar?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    expect(document.body.textContent).toContain('Alpha');
    expect(document.body.textContent).toContain('Bravo');
    expect(document.body.textContent).toContain('Разом');

    await act(async () => {
      view.container
        .querySelector('svg[data-chart="network-activity"]')
        ?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });

    expect(document.body.textContent).not.toContain('Разом');
  });

  it('renders the selected period anchored to today instead of the last datapoint', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 4, 13, 23, 30, 0));
    const view = await renderComponent({
      networkActivity: {
        [String(Date.UTC(2026, 4, 12))]: { Alpha: 2 },
        [String(Date.UTC(2026, 4, 14))]: { Alpha: 1 },
      },
      networkActivityPeriod: 'Last30Days',
      networkActivityLoading: false,
      networkActivityLoaded: true,
      networkActivityError: null,
      onNetworkActivityPeriodChange: vi.fn(),
      onReloadNetworkActivity: vi.fn(),
    });
    rendered.push(view);
    dateNowSpy.mockRestore();

    expect(view.container.textContent).toContain('14.05');
    expect(view.container.querySelectorAll('g[data-day]')).toHaveLength(30);
  });
});
