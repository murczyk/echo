/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childMockState = vi.hoisted(() => ({
  networkCallsignsError: null as string | null,
  catalogCallsignsError: null as string | null,
  interceptedCallsignsError: null as string | null,
  networkPeriod: null as string | null,
  catalogPeriod: null as string | null,
  interceptedPeriod: null as string | null,
  networkRows: [] as Array<{ id: number; messageCount: number; lastDatetime: number | null }>,
  networkStats: null as NetworkCallsignsTableStats | null,
}));

vi.mock('../NetworkCallsignsNetworkTable', () => ({
  NetworkCallsignsNetworkTable: (props: {
    loadingError: string | null;
    period: string;
    rows: typeof childMockState.networkRows;
    stats: NetworkCallsignsTableStats;
  }) => {
    childMockState.networkCallsignsError = props.loadingError;
    childMockState.networkPeriod = props.period;
    childMockState.networkRows = props.rows;
    childMockState.networkStats = props.stats;
    return <div data-testid="network-table">network</div>;
  },
}));

vi.mock('../NetworkCallsignsCatalogTable', () => ({
  NetworkCallsignsCatalogTable: (props: { loadingError: string | null; period: string }) => {
    childMockState.catalogCallsignsError = props.loadingError;
    childMockState.catalogPeriod = props.period;
    return <div data-testid="catalog-table">catalog</div>;
  },
}));

vi.mock('../NetworkFreqCallsignPeriodSettings', () => ({
  NetworkFreqCallsignPeriodSettings: (props: { period: string }) => (
    <div data-testid="intercepted-period-settings">{props.period}</div>
  ),
}));

vi.mock('../NetworkCallsignsInterceptedPanel', () => ({
  NetworkCallsignsInterceptedPanel: (props: { loadingError: string | null }) => {
    childMockState.interceptedCallsignsError = props.loadingError;
    return <div data-testid="intercepted-panel">intercepted</div>;
  },
}));

import { NetworkDetailsCallsignsPanel } from '../NetworkCallsignsTables';
import type { NetworkCallsignsTableStats } from '../NetworkCallsignsNetworkTable';
import { createNetworkCallsignStatsMap } from '../../network-callsigns.stats';
import { ROW_REMOVAL_ANIMATION_MS } from '../../use-animated-row-removal';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

type CallsignPanelProps = ComponentProps<typeof NetworkDetailsCallsignsPanel>;

function createNetworkCallsign(
  overrides: Partial<CallsignPanelProps['networkCallsigns'][number]> = {},
) {
  return {
    id: 1,
    networkId: 42,
    callsign: 'сокіл-1',
    fullName: '',
    knownCallsignId: null,
    position: 'Командир',
    comment: '',
    unitId: 101,
    unitName: '1 мб',
    sourceId: 1,
    radioFreq: null,
    createdAt: 1710000000000,
    active: true,
    developing: false,
    messageCount: 5,
    lastDatetime: 1710000000000,
    freqs: ['145.1000'],
    unitDeveloping: false,
    mainRadioStation: false,
    commandControl: false,
    ...overrides,
  };
}

function createCatalogGroup(
  overrides: Partial<CallsignPanelProps['catalogCallsignGroups'][number]> = {},
) {
  return {
    callsign: 'БАРС-4',
    knownCallsigns: [
      {
        id: 20,
        callsign: 'Барс-4',
        position: 'ЗКМ',
        comment: 'Збiг',
        unitId: 201,
        unitName: 'арт. дивізіон',
        sourceName: 'Каталог 2024',
        createdAt: 1710100000000,
      },
    ],
    messageCount: 8,
    lastDatetime: 1710200000000,
    freqs: ['145.2000'],
    isOld: false,
    isInDictionary: false,
    activity: null,
    ...overrides,
  };
}

function createInterceptedRow(
  overrides: Partial<CallsignPanelProps['unknownInterceptedCallsigns'][number]> = {},
) {
  return {
    callsign: 'ГІЄНА-4',
    messageCount: 9,
    lastDatetime: 1710300000000,
    freqs: ['145.3000'],
    isOld: false,
    isInDictionary: false,
    activity: null,
    ...overrides,
  };
}

const NETWORK_STATS_PROPS = {
  networkCallsignStats: createNetworkCallsignStatsMap([]),
  networkCallsignStatsLoading: false,
  networkCallsignStatsError: null,
  networkCallsignStatsPeriod: 'Last21Days',
  networkCallsignsAddedSinceStats: new Set<number>(),
  onRetryNetworkCallsignStats: vi.fn(),
  onLoadAllTimeNetworkCallsignStats: vi.fn(),
} satisfies Partial<CallsignPanelProps>;

function createPanelProps(overrides: Partial<CallsignPanelProps> = {}): CallsignPanelProps {
  return {
    sources: [],
    networkCallsigns: [
      createNetworkCallsign({ id: 1, messageCount: 0, lastDatetime: null }),
      createNetworkCallsign({ id: 2, callsign: 'барс-2', messageCount: 0, lastDatetime: null }),
    ],
    ...NETWORK_STATS_PROPS,
    catalogCallsignGroups: [],
    unknownInterceptedCallsigns: [],
    networkCallsignsLoading: false,
    networkCallsignsError: null,
    catalogCallsignsLoading: false,
    catalogCallsignsError: null,
    interceptedCallsignsLoading: false,
    interceptedCallsignsError: null,
    loadingError: null,
    canManage: false,
    sectionMode: 'network',
    onSectionModeChange: vi.fn(),
    statusFilter: 'All',
    onStatusFilterChange: vi.fn(),
    networkPeriod: 'Unlimited',
    onNetworkPeriodChange: vi.fn(),
    catalogPeriod: 'Last21Days',
    onCatalogPeriodChange: vi.fn(),
    interceptedPeriod: 'Last21Days',
    onInterceptedPeriodChange: vi.fn(),
    interceptedExpanded: false,
    onToggleInterceptedExpanded: vi.fn(),
    onOpenCreateDrawer: vi.fn(),
    onOpenEditDrawer: vi.fn(),
    onOpenDeleteDialog: vi.fn(),
    onSetMarkerMode: vi.fn(),
    onAddKnownCallsign: vi.fn(),
    onAddInterceptedToDeveloping: vi.fn(),
    onAddInterceptedToNetwork: vi.fn(),
    onReload: vi.fn(),
    inFlightCreateCallsigns: [],
    inFlightAddIds: [],
    inFlightUpdateIds: [],
    inFlightDeleteIds: [],
    ...overrides,
  };
}

function renderComponent(props: ComponentProps<typeof NetworkDetailsCallsignsPanel>): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(createElement(NetworkDetailsCallsignsPanel, props));
  });

  return { container, root };
}
describe('NetworkDetailsCallsignsPanel', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    childMockState.networkCallsignsError = null;
    childMockState.catalogCallsignsError = null;
    childMockState.interceptedCallsignsError = null;
    childMockState.networkPeriod = null;
    childMockState.catalogPeriod = null;
    childMockState.interceptedPeriod = null;
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('shows an aggregate retry alert when loading fails and rows are already visible', () => {
    const onReload = vi.fn();
    const view = renderComponent({
      sources: [],
      networkCallsigns: [createNetworkCallsign()],
      ...NETWORK_STATS_PROPS,
      catalogCallsignGroups: [createCatalogGroup()],
      unknownInterceptedCallsigns: [createInterceptedRow()],
      networkCallsignsLoading: false,
      networkCallsignsError: 'Позивні мережі помилка',
      catalogCallsignsLoading: false,
      catalogCallsignsError: 'Каталог помилка',
      interceptedCallsignsLoading: false,
      interceptedCallsignsError: 'Перехоплення помилка',
      loadingError: 'Activity failed',
      canManage: false,
      sectionMode: 'network',
      onSectionModeChange: vi.fn(),
      statusFilter: 'All',
      onStatusFilterChange: vi.fn(),
      networkPeriod: 'Last21Days',
      onNetworkPeriodChange: vi.fn(),
      catalogPeriod: 'Last7Days',
      onCatalogPeriodChange: vi.fn(),
      interceptedPeriod: 'Unlimited',
      onInterceptedPeriodChange: vi.fn(),
      interceptedExpanded: false,
      onToggleInterceptedExpanded: vi.fn(),
      onOpenCreateDrawer: vi.fn(),
      onOpenEditDrawer: vi.fn(),
      onOpenDeleteDialog: vi.fn(),
      onSetMarkerMode: vi.fn(),
      onAddKnownCallsign: vi.fn(),
      onAddInterceptedToDeveloping: vi.fn(),
      onAddInterceptedToNetwork: vi.fn(),
      onReload,
      inFlightCreateCallsigns: [],
      inFlightAddIds: [],
      inFlightUpdateIds: [],
      inFlightDeleteIds: [],
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('Activity failed');
    expect(view.container.textContent).toContain('network');
    expect(view.container.textContent).toContain('catalog');
    expect(view.container.textContent).toContain('intercepted');
    expect(childMockState.networkPeriod).toBe('Last21Days');
    expect(childMockState.catalogPeriod).toBe('Last7Days');
    expect(
      view.container.querySelector('[data-testid="intercepted-period-settings"]')?.textContent,
    ).toBe('Unlimited');
    expect(childMockState.networkCallsignsError).toBe('Позивні мережі помилка');
    expect(childMockState.catalogCallsignsError).toBe('Каталог помилка');
    expect(childMockState.interceptedCallsignsError).toBe('Перехоплення помилка');

    const retryButton =
      [...view.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Спробувати ще раз'),
      ) ?? null;
    expect(retryButton).not.toBeNull();
    act(() => {
      retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  describe('network callsign stats', () => {
    const ACTIVE_STATS = createNetworkCallsignStatsMap([
      createNetworkCallsign({ id: 1, messageCount: 5, lastDatetime: 1000 }),
    ]);
    const rowIds = () => childMockState.networkRows.map((row) => row.id);

    function rerender(view: Rendered, props: CallsignPanelProps) {
      act(() => {
        view.root.render(createElement(NetworkDetailsCallsignsPanel, props));
      });
    }

    it('keeps every row in the all-time list and merges available stats', () => {
      rendered.push(renderComponent(createPanelProps({ networkCallsignStats: ACTIVE_STATS })));

      expect(rowIds()).toEqual([1, 2]);
      expect(childMockState.networkRows.map((row) => row.messageCount)).toEqual([5, 0]);
      expect(childMockState.networkStats?.available).toBe(true);
    });

    it('does not show old numbers or filter rows while stats load', () => {
      rendered.push(
        renderComponent(
          createPanelProps({
            networkPeriod: 'Last7Days',
            networkCallsignStats: ACTIVE_STATS,
            networkCallsignStatsLoading: true,
            networkCallsignStatsPeriod: 'Last7Days',
          }),
        ),
      );

      expect(rowIds()).toEqual([1, 2]);
      expect(childMockState.networkRows.map((row) => row.messageCount)).toEqual([0, 0]);
      expect(childMockState.networkStats?.loading).toBe(true);
      expect(childMockState.networkStats?.available).toBe(false);
    });

    it('keeps rows and reports stats as unavailable after a failure', () => {
      rendered.push(
        renderComponent(
          createPanelProps({
            networkPeriod: 'Last21Days',
            networkCallsignStats: ACTIVE_STATS,
            networkCallsignStatsError: 'stats failed',
          }),
        ),
      );

      expect(rowIds()).toEqual([1, 2]);
      expect(childMockState.networkStats?.available).toBe(false);
      expect(childMockState.networkStats?.error).toBe('stats failed');
    });

    it('keeps a row added after the stats request under a period filter', () => {
      rendered.push(
        renderComponent(
          createPanelProps({
            networkPeriod: 'Last21Days',
            networkCallsignStats: ACTIVE_STATS,
            networkCallsignsAddedSinceStats: new Set([2]),
          }),
        ),
      );

      expect(rowIds()).toEqual([1, 2]);
      expect(childMockState.networkStats?.exitingRowIds.size).toBe(0);
      expect([...(childMockState.networkStats?.unknownRowIds ?? [])]).toEqual([2]);
    });

    it('fades out rows without activity, then removes them', () => {
      vi.useFakeTimers();
      try {
        const props = createPanelProps({ networkCallsignStats: ACTIVE_STATS });
        const view = renderComponent(props);
        rendered.push(view);

        rerender(view, { ...props, networkPeriod: 'Last21Days' });

        expect(rowIds()).toEqual([1, 2]);
        expect([...(childMockState.networkStats?.exitingRowIds ?? [])]).toEqual([2]);

        act(() => {
          vi.advanceTimersByTime(ROW_REMOVAL_ANIMATION_MS);
        });

        expect(rowIds()).toEqual([1]);
        expect(childMockState.networkStats?.exitingRowIds.size).toBe(0);

        rerender(view, props);

        expect(rowIds()).toEqual([1, 2]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('keeps the empty-state error behavior with the retry action', () => {
    const view = renderComponent({
      sources: [],
      networkCallsigns: [],
      ...NETWORK_STATS_PROPS,
      catalogCallsignGroups: [],
      unknownInterceptedCallsigns: [],
      networkCallsignsLoading: false,
      networkCallsignsError: null,
      catalogCallsignsLoading: false,
      catalogCallsignsError: null,
      interceptedCallsignsLoading: false,
      interceptedCallsignsError: null,
      loadingError: 'Activity failed',
      canManage: false,
      sectionMode: 'network',
      onSectionModeChange: vi.fn(),
      statusFilter: 'All',
      onStatusFilterChange: vi.fn(),
      networkPeriod: 'Last21Days',
      onNetworkPeriodChange: vi.fn(),
      catalogPeriod: 'Last21Days',
      onCatalogPeriodChange: vi.fn(),
      interceptedPeriod: 'Last21Days',
      onInterceptedPeriodChange: vi.fn(),
      interceptedExpanded: false,
      onToggleInterceptedExpanded: vi.fn(),
      onOpenCreateDrawer: vi.fn(),
      onOpenEditDrawer: vi.fn(),
      onOpenDeleteDialog: vi.fn(),
      onSetMarkerMode: vi.fn(),
      onAddKnownCallsign: vi.fn(),
      onAddInterceptedToDeveloping: vi.fn(),
      onAddInterceptedToNetwork: vi.fn(),
      onReload: vi.fn(),
      inFlightCreateCallsigns: [],
      inFlightAddIds: [],
      inFlightUpdateIds: [],
      inFlightDeleteIds: [],
    });
    rendered.push(view);

    expect(view.container.textContent).toContain('Activity failed');
    const retryButton =
      [...view.container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Спробувати ще раз'),
      ) ?? null;
    expect(retryButton).not.toBeNull();
    act(() => {
      retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(childMockState.networkCallsignsError).toBeNull();
    expect(childMockState.catalogCallsignsError).toBeNull();
    expect(childMockState.interceptedCallsignsError).toBeNull();
  });
});
