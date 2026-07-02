/**
 * @vitest-environment happy-dom
 */
import type { ComponentProps, ReactNode } from 'react';
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NETWORK_STATUS_ACTIVE } from '../network-status';

vi.mock('@mui/icons-material/ContentCopyOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/KeyboardArrowLeftOutlined', () => ({
  default: () => <span data-testid="arrow-left" />,
}));
vi.mock('@mui/icons-material/KeyboardArrowDownOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/KeyboardArrowUpOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/MoreVertOutlined', () => ({ default: () => <span /> }));

vi.mock('@mui/material', () => ({
  Box: ({ children, ...props }: { children: ReactNode }) => <div {...props}>{children}</div>,
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Chip: ({ label }: { label: ReactNode }) => <span>{label}</span>,
  Divider: () => <hr />,
  IconButton: ({
    children,
    onClick,
    disabled,
    ...props
  }: {
    children: ReactNode;
    onClick?: (event: MouseEvent) => void;
    disabled?: boolean;
    [key: string]: unknown;
  }) => (
    <button type="button" onClick={onClick as any} disabled={disabled} {...props}>
      {children}
    </button>
  ),
  ListItemIcon: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Paper: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  Skeleton: ({ children }: { children?: ReactNode }) => <div>{children ?? 'skeleton'}</div>,
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('../../../components/PowerMenu', () => ({
  PowerMenu: ({
    children,
    open,
    TransitionProps,
  }: {
    children: ReactNode;
    open: boolean;
    TransitionProps?: { onExited?: () => void };
  }) => {
    const previousOpen = useRef(open);
    useEffect(() => {
      if (previousOpen.current && !open) {
        TransitionProps?.onExited?.();
      }
      previousOpen.current = open;
    }, [TransitionProps, open]);

    return open ? <div data-testid="panel-menu">{children}</div> : null;
  },
}));

import { NetworkDetailsLeftPanel } from './NetworkDetailsLeftPanel';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

async function renderPanel(
  props: ComponentProps<typeof NetworkDetailsLeftPanel>,
): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<NetworkDetailsLeftPanel {...props} />);
  });

  return { container, root };
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function baseProps(overrides: Partial<ComponentProps<typeof NetworkDetailsLeftPanel>> = {}) {
  return {
    placement: 'left' as const,
    collapsed: false,
    isLoading: false,
    unitNames: ['Підрозділ 1'],
    network: {
      location: 'ЯКЕСЬ МІСТО',
      purpose: 'для управління',
      operationMode: 'дулекс',
      operationType: 'службовий',
      operationPeriod: 'цілодобово',
      radioStation: 'ТУТ',
      createdAt: '2024-01-01T00:00:00Z',
      lastUpdatedAt: '2024-02-01T00:00:00Z',
      lastUpdatedBy: 'Оператор',
      activeFrom: '2022-02-24T00:00:00Z',
      status: NETWORK_STATUS_ACTIVE,
      deleted: false,
    } as any,
    aorVisible: [{ id: 1, label: 'АОР 1' }],
    aorCollapsedCount: 2,
    showAllAors: false,
    onToggleShowAllAors: vi.fn(),
    callsignCount: 11,
    statusTone: 'success' as const,
    statusLabel: 'Активна',
    rangeLabel: 'DMRe',
    transferTypeLabel: 'TУТ',
    postItems: [{ id: 1, label: 'Пост 1' }],
    onPlacementChange: vi.fn(),
    onToggleCollapsed: vi.fn(),
    onCopyMainInfo: vi.fn(),
    ...overrides,
  };
}

describe('NetworkDetailsLeftPanel', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('switches placement from the panel menu', async () => {
    const onPlacementChange = vi.fn();
    const view = await renderPanel(baseProps({ placement: 'top', onPlacementChange }));
    rendered.push(view);

    const menuButton = view.container.querySelector('button[aria-label="Дії панелі"]');
    expect(menuButton).not.toBeNull();
    await click(menuButton!);

    expect(view.container.textContent).toContain('Відображати ліворуч');
    expect(view.container.querySelector('[data-testid="arrow-left"]')).not.toBeNull();

    const placementButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Відображати ліворуч'),
    );
    expect(placementButton).toBeDefined();

    await click(placementButton!);
    expect(onPlacementChange).toHaveBeenCalledWith('left');
    expect(view.container.querySelector('[data-testid="panel-menu"]')).toBeNull();
  });

  it('keeps left actions out of the content flow', async () => {
    const view = await renderPanel(baseProps({ placement: 'left' }));
    rendered.push(view);

    expect(
      view.container.querySelector('[data-testid="network-details-panel-actions"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="network-details-panel-collapsed-summary"]'),
    ).toBeNull();
  });

  it('renders the collapsed top summary with values only', async () => {
    const view = await renderPanel(
      baseProps({
        placement: 'top',
        collapsed: true,
      }),
    );
    rendered.push(view);

    expect(
      view.container.querySelector('[data-testid="network-details-panel-collapsed-summary"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="network-details-panel-collapsed-summary"]')
        ?.textContent,
    ).not.toContain('Підрозділ 1');
    expect(view.container.querySelector('[data-summary-key="callsigns"]')?.textContent).toContain(
      'Склад кореспондентів',
    );
    expect(view.container.querySelector('[data-summary-key="callsigns"]')?.textContent).toContain(
      '11',
    );
    expect(
      view.container
        .querySelector('[data-summary-key="activity"]')
        ?.getAttribute('data-summary-tone'),
    ).toBe('success');
    expect(view.container.textContent).not.toContain('|');

    const itemKeys = Array.from(view.container.querySelectorAll('[data-summary-key]')).map((node) =>
      node.getAttribute('data-summary-key'),
    );
    expect(itemKeys).toEqual(['location', 'aor', 'callsigns', 'activity', 'created', 'operator']);
    expect(view.container.textContent).not.toContain('Оновлено');
  });

  it('renders a warning-tone collapsed activity summary', async () => {
    const view = await renderPanel(
      baseProps({
        placement: 'top',
        collapsed: true,
        statusTone: 'warning',
        statusLabel: 'Неактивна',
      }),
    );
    rendered.push(view);

    expect(
      view.container
        .querySelector('[data-summary-key="activity"]')
        ?.getAttribute('data-summary-tone'),
    ).toBe('default');
    expect(view.container.querySelector('[data-summary-key="activity"]')?.textContent).toContain(
      'Неактивна',
    );
  });

  it('calls the copy helper from the menu', async () => {
    const onCopyMainInfo = vi.fn();
    const view = await renderPanel(baseProps({ onCopyMainInfo }));
    rendered.push(view);

    const menuButton = view.container.querySelector('button[aria-label="Дії панелі"]');
    await click(menuButton!);

    const copyButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Копіювати основне'),
    );
    expect(copyButton).toBeDefined();

    await click(copyButton!);
    expect(onCopyMainInfo).toHaveBeenCalledTimes(1);
    expect(onCopyMainInfo.mock.calls[0][0]).toMatchObject({
      unitNames: ['Підрозділ 1'],
      location: 'ЯКЕСЬ МІСТО',
      aorLabels: ['АОР 1'],
      aorCollapsedCount: 2,
      callsignCount: 11,
      activityLabel: '24.02.22 — досі',
    });
  });
});
