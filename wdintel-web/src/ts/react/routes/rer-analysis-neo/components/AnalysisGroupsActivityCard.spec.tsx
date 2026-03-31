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
  CircularProgress: () => <div>loading</div>,
  Paper: forwardRef<HTMLElement, { children?: ReactNode }>(({ children }, ref) => <section ref={ref}>{children}</section>),
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
                    onClick: () => onChange?.(new Event('change'), String((child as { props: { value: string } }).props.value)),
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

async function renderComponent(props: ComponentProps<typeof AnalysisGroupsActivityCard>): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AnalysisGroupsActivityCard {...props} />);
  });
  return { container, root };
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

describe('AnalysisGroupsActivityCard', () => {
  const rendered: Rendered[] = [];
  const scrollIntoView = vi.fn();

  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });

  afterEach(() => {
    scrollIntoView.mockReset();
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('offers a quick frequency selection when no frequency is selected', async () => {
    const onLoad = vi.fn();
    const onSelectFreq = vi.fn();
    const view = await renderComponent({
      groupsActivity: null,
      groupsActivityLoadedFreq: null,
      groupsActivityLoadedPeriod: null,
      loading: false,
      period: 'selected',
      selectedFreq: null,
      suggestedFreqs: ['100.100', '101.100', '102.100'],
      onLoad,
      onSelectFreq,
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('100.100');
    expect(view.container.textContent).toContain('101.100');
    expect(view.container.textContent).toContain('102.100');

    const button = Array.from(view.container.querySelectorAll('button')).find((item) => item.textContent === '101.100');
    expect(button).toBeTruthy();

    await click(button as HTMLButtonElement);

    expect(onLoad).not.toHaveBeenCalled();
    expect(onSelectFreq).toHaveBeenCalledWith('101.100');
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
      suggestedFreqs: ['100.100', '101.100'],
      onLoad,
      onSelectFreq: vi.fn(),
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
      suggestedFreqs: ['100.100'],
      onLoad: vi.fn(),
      onSelectFreq: vi.fn(),
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('Для частоти 100.100 за цей інтервал активності не знайдено.');
    expect(view.container.querySelector('bar-chart-2')).toBeNull();
  });

  it('keeps the chart visible while the same frequency and period refresh in background', async () => {
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
      suggestedFreqs: ['100.100'],
      onLoad: vi.fn(),
      onSelectFreq: vi.fn(),
    });
    rendered.push(view);

    expect(view.container.querySelector('bar-chart-2')).not.toBeNull();
    expect(view.container.textContent).not.toContain('Завантажую активність по датах…');
  });

  it('scrolls the card into view when the chart becomes ready', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    rendered.push({ container, root });

    const baseProps: ComponentProps<typeof AnalysisGroupsActivityCard> = {
      groupsActivity: null,
      groupsActivityLoadedFreq: null,
      groupsActivityLoadedPeriod: null,
      loading: true,
      period: 'selected',
      selectedFreq: '100.100',
      suggestedFreqs: ['100.100'],
      onLoad: vi.fn(),
      onSelectFreq: vi.fn(),
    };

    await act(async () => {
      root.render(<AnalysisGroupsActivityCard {...baseProps} />);
    });

    await act(async () => {
      root.render(
        <AnalysisGroupsActivityCard
          {...baseProps}
          groupsActivity={{
            dataPerDate: {
              '2026-03-31': { countByGroupName: { Alpha: 3 } },
            },
          }}
          groupsActivityLoadedFreq="100.100"
          groupsActivityLoadedPeriod="selected"
          loading={false}
        />,
      );
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'end' });
  });
});
