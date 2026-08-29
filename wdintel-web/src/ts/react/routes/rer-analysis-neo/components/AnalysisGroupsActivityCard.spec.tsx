/**
 * @vitest-environment happy-dom
 */
import { act, forwardRef } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Alert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Skeleton: () => <div>loading-skeleton</div>,
  Paper: forwardRef<HTMLElement, { children?: ReactNode }>(({ children }, ref) => (
    <section ref={ref}>{children}</section>
  )),
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ToggleButton: ({
    children,
    onClick,
    value,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    value?: string;
  }) => (
    <button type="button" data-value={value} onClick={onClick}>
      {children}
    </button>
  ),
  ToggleButtonGroup: ({
    children,
    onChange,
  }: {
    children?: ReactNode;
    onChange?: (_event: Event, value: string) => void;
  }) => (
    <div>
      {Array.isArray(children)
        ? children.map((child, index) =>
            child && typeof child === 'object' && 'props' in child
              ? {
                  ...child,
                  props: {
                    ...(child as { props: Record<string, unknown> }).props,
                    onClick: () =>
                      onChange?.(
                        new Event('change'),
                        String((child as { props: { value: string } }).props.value),
                      ),
                    key: index,
                  },
                }
              : child,
          )
        : children}
    </div>
  ),
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { AnalysisGroupsActivityCard } from './AnalysisGroupsActivityCard';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

async function renderComponent(
  props: ComponentProps<typeof AnalysisGroupsActivityCard>,
): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AnalysisGroupsActivityCard {...props} />);
  });
  return { container, root };
}

describe('AnalysisGroupsActivityCard', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('offers an explicit global-filter load when no frequency is selected', async () => {
    const onLoad = vi.fn();
    const view = await renderComponent({
      groupsActivity: null,
      groupsActivityLoadedFreq: null,
      groupsActivityLoadedPeriod: null,
      loading: false,
      period: 'selected',
      selectedFreq: null,
      onLoad,
    });
    rendered.push(view);

    expect(onLoad).not.toHaveBeenCalled();
    const loadButton = Array.from(view.container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Завантажити',
    );
    expect(loadButton).toBeDefined();

    await act(async () => {
      loadButton?.click();
    });
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('loads activity automatically when a frequency is already selected', async () => {
    const onLoad = vi.fn();
    const view = await renderComponent({
      groupsActivity: null,
      groupsActivityLoadedFreq: null,
      groupsActivityLoadedPeriod: null,
      loading: false,
      period: 'selected',
      selectedFreq: '100.100',
      onLoad,
    });
    rendered.push(view);

    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('shows an empty-period message instead of an empty chart when all buckets are zero', async () => {
    const view = await renderComponent({
      groupsActivity: {
        dataPerDate: {
          '2026-03-01': { countByGroupName: { Alpha: 0 } },
          '2026-03-02': { countByGroupName: { Alpha: 0, Bravo: 0 } },
        },
      },
      groupsActivityLoadedFreq: '100.100',
      groupsActivityLoadedPeriod: 'month',
      loading: false,
      period: 'month',
      selectedFreq: '100.100',
      onLoad: vi.fn(),
    });
    rendered.push(view);

    expect(view.container.textContent).toContain(
      'Для частоти 100.100 за цей інтервал активності не знайдено.',
    );
    expect(view.container.querySelector('dashboard-chart')).toBeNull();
  });

  it('replaces the chart with a skeleton while refreshing in background', async () => {
    const view = await renderComponent({
      groupsActivity: {
        dataPerDate: {
          '2026-03-31': { countByGroupName: { Alpha: 3 } },
        },
      },
      groupsActivityLoadedFreq: '100.100',
      groupsActivityLoadedPeriod: 'selected',
      loading: true,
      period: 'selected',
      selectedFreq: '100.100',
      onLoad: vi.fn(),
    });
    rendered.push(view);

    expect(view.container.querySelector('dashboard-chart')).toBeNull();
    expect(view.container.textContent).toContain('loading-skeleton');
  });
});
