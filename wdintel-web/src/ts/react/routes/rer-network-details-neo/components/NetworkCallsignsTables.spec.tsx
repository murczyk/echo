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
}));

vi.mock('./NetworkCallsignsNetworkTable', () => ({
  NetworkCallsignsNetworkTable: (props: { loadingError: string | null }) => {
    childMockState.networkCallsignsError = props.loadingError;
    return <div data-testid="network-table">network</div>;
  },
}));

vi.mock('./NetworkCallsignsCatalogTable', () => ({
  NetworkCallsignsCatalogTable: (props: { loadingError: string | null }) => {
    childMockState.catalogCallsignsError = props.loadingError;
    return <div data-testid="catalog-table">catalog</div>;
  },
}));

vi.mock('./NetworkCallsignsInterceptedPanel', () => ({
  NetworkCallsignsInterceptedPanel: (props: { loadingError: string | null }) => {
    childMockState.interceptedCallsignsError = props.loadingError;
    return <div data-testid="intercepted-panel">intercepted</div>;
  },
}));

import { NetworkDetailsCallsignsPanel } from './NetworkCallsignsTables';

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

  it('keeps the empty-state error behavior with the retry action', () => {
    const view = renderComponent({
      sources: [],
      networkCallsigns: [],
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
