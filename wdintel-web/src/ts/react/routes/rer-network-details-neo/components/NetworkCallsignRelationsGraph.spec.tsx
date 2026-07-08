/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkCallsignRelationsRsp } from '../../../../../Bindings';

vi.mock('../../../services/api/networks', () => ({
  getNetworkCallsignRelationMessages: vi.fn(),
}));

vi.mock('./NetworkDatePickerField', () => ({
  NetworkDatePickerField: ({ label }: { label: string }) => (
    <div data-testid={`date-picker-${label}`} />
  ),
}));

import { getNetworkCallsignRelationMessages } from '../../../services/api/networks';
import { NetworkCallsignRelationsGraph } from './NetworkCallsignRelationsGraph';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

type GraphProps = Parameters<typeof NetworkCallsignRelationsGraph>[0];

function createGraph(): NetworkCallsignRelationsRsp {
  return {
    nodes: [
      {
        id: 'ALPHA',
        label: 'ALPHA',
        weight: 3,
        relationCount: 1,
        activityCount: 3,
        mainRadioStation: true,
        commandControl: false,
        position: null,
        unitName: null,
        knownCallsignId: null,
        enrichmentSource: 'RelationEnrichmentNetwork',
      },
      {
        id: 'BRAVO',
        label: 'BRAVO',
        weight: 2,
        relationCount: 1,
        activityCount: 2,
        mainRadioStation: false,
        commandControl: true,
        position: null,
        unitName: null,
        knownCallsignId: null,
        enrichmentSource: 'RelationEnrichmentNone',
      },
    ],
    edges: [
      {
        id: 'ALPHA__BRAVO',
        source: 'ALPHA',
        target: 'BRAVO',
        weight: 2,
        byFreq: [{ freq: '652.111', weight: 2 }],
      },
    ],
    freqs: [{ freq: '652.111', enabledByDefault: true }],
  };
}

function renderGraph(overrides: Partial<GraphProps> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const deferred = (() => {
    let resolve!: (value: {
      messages: Array<{
        id: number;
        timestamp: number | null;
        freq: string | null;
        text: string;
        callsigns: string[];
      }>;
    }) => void;
    const promise = new Promise<{
      messages: Array<{
        id: number;
        timestamp: number | null;
        freq: string | null;
        text: string;
        callsigns: string[];
      }>;
    }>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  })();

  vi.mocked(getNetworkCallsignRelationMessages).mockImplementation(() => deferred.promise);

  const props: GraphProps = {
    networkId: 42,
    relations: createGraph(),
    relationsSearch: '',
    relationsEnabledFreqs: ['652.111'],
    relationsMinIntensity: 1,
    relationsShowLabels: true,
    relationsSelectedNodeId: null,
    relationsSelectedEdgeId: null,
    relationsSince: '2026-05-20',
    relationsTill: '2026-05-21',
    relationsLoading: false,
    onSearchChange: vi.fn(),
    onEnabledFreqsChange: vi.fn(),
    onMinIntensityChange: vi.fn(),
    onShowLabelsChange: vi.fn(),
    onSelectNodeId: vi.fn(),
    onSelectEdgeId: vi.fn(),
    onRelationsSinceChange: vi.fn(),
    onRelationsTillChange: vi.fn(),
    onReload: vi.fn(),
    ...overrides,
  };

  act(() => {
    root.render(<NetworkCallsignRelationsGraph {...props} />);
  });

  return { container, root, deferred, props };
}

describe('NetworkCallsignRelationsGraph', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('loads selected node messages and renders them in the details panel', async () => {
    const view = renderGraph({ relationsSelectedNodeId: 'ALPHA' });
    rendered.push(view);

    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain('Завантажуємо повідомлення');

    await act(async () => {
      view.deferred.resolve({
        messages: [
          {
            id: 7,
            timestamp: 1717000000000,
            freq: '652.111',
            text: 'hello',
            callsigns: ['ALPHA'],
          },
        ],
      });
      await view.deferred.promise;
    });

    expect(view.container.textContent).toContain('hello');
    expect(view.container.textContent).toContain('652.111');
  });

  it('does not refetch selected messages when only search or intensity changes', async () => {
    const view = renderGraph({ relationsSelectedNodeId: 'ALPHA' });
    rendered.push(view);

    await act(async () => {
      await Promise.resolve();
    });

    expect(getNetworkCallsignRelationMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.root.render(
        <NetworkCallsignRelationsGraph
          {...view.props}
          relationsSearch="alp"
          relationsMinIntensity={2}
        />,
      );
    });

    expect(getNetworkCallsignRelationMessages).toHaveBeenCalledTimes(1);
  });

  it('toggles fullscreen through the stage portal and exits on Escape', async () => {
    const view = renderGraph();
    rendered.push(view);

    const fullscreenButton = view.container.querySelector('button[aria-label="Розгорнути граф"]');
    expect(fullscreenButton).not.toBeNull();

    await act(async () => {
      fullscreenButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.classList.contains('small-map-fullscreen-open')).toBe(true);
    expect(view.container.querySelector('svg[aria-label="Граф зв\'язків позивних"]')).toBeNull();
    expect(document.body.querySelector('svg[aria-label="Граф зв\'язків позивних"]')).not.toBeNull();

    const intensityButton = document.body.querySelector(
      'button[aria-label="Налаштувати інтенсивність: 1"]',
    );
    expect(intensityButton).not.toBeNull();

    await act(async () => {
      intensityButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const intensityButtonAfterOpen = document.body.querySelector(
      'button[aria-label="Налаштувати інтенсивність: 1"]',
    );
    const intensityPopoverId = intensityButtonAfterOpen?.getAttribute('aria-controls');
    expect(intensityPopoverId).not.toBeNull();

    const intensityPopover = document.body.querySelector('[data-testid="graph-intensity-popover"]');
    expect(intensityPopover).not.toBeNull();
    expect((intensityPopover as HTMLElement).getAttribute('data-zindex')).toBe('10001');

    const filterButton = document.body.querySelector('button[aria-label="Налаштувати частоти"]');
    expect(filterButton).not.toBeNull();

    await act(async () => {
      filterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const filterPopover = document.body.querySelector('[data-testid="graph-filters-popover"]');
    expect(filterPopover).not.toBeNull();
    expect((filterPopover as HTMLElement).getAttribute('data-zindex')).toBe('10001');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(document.body.classList.contains('small-map-fullscreen-open')).toBe(false);
    expect(
      view.container.querySelector('svg[aria-label="Граф зв\'язків позивних"]'),
    ).not.toBeNull();
  });

  it('opens the intensity settings from the overlay and keeps the frequency filter separate', async () => {
    const view = renderGraph();
    rendered.push(view);

    const intensityButton = view.container.querySelector(
      'button[aria-label="Налаштувати інтенсивність: 1"]',
    );
    expect(intensityButton).not.toBeNull();

    await act(async () => {
      intensityButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.querySelector('[data-testid="graph-intensity-popover"]')).not.toBeNull();

    const filterButton = view.container.querySelector('button[id$="-filters"]');
    expect(filterButton).not.toBeNull();

    await act(async () => {
      filterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const filtersPopover = document.body.querySelector('[data-testid="graph-filters-popover"]');
    expect(filtersPopover).not.toBeNull();
    expect(filtersPopover?.textContent).toContain('652.111');
    expect(filtersPopover?.textContent).not.toContain('Інтенсивність');
  });

  it('keeps wheel zoom working before fullscreen, during fullscreen, and after exit', async () => {
    const view = renderGraph();
    rendered.push(view);

    const getNormalSvg = () =>
      view.container.querySelector('svg[aria-label="Граф зв\'язків позивних"]');
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });

    const initialViewBox = getNormalSvg()?.getAttribute('viewBox');
    expect(initialViewBox).not.toBeNull();

    await act(async () => {
      getNormalSvg()?.dispatchEvent(wheel);
    });

    const zoomedViewBox = getNormalSvg()?.getAttribute('viewBox');
    expect(zoomedViewBox).not.toBe(initialViewBox);

    const fullscreenButton = view.container.querySelector('button[aria-label="Розгорнути граф"]');
    expect(fullscreenButton).not.toBeNull();

    await act(async () => {
      fullscreenButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const getFullscreenSvg = () =>
      document.body.querySelector('svg[aria-label="Граф зв\'язків позивних"]');
    const fullscreenInitialViewBox = getFullscreenSvg()?.getAttribute('viewBox');
    expect(fullscreenInitialViewBox).not.toBeNull();

    await act(async () => {
      getFullscreenSvg()?.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }),
      );
    });

    const fullscreenZoomedViewBox = getFullscreenSvg()?.getAttribute('viewBox');
    expect(fullscreenZoomedViewBox).not.toBe(fullscreenInitialViewBox);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    const restoredSvg = getNormalSvg();
    expect(restoredSvg).not.toBeNull();
    const restoredViewBox = restoredSvg?.getAttribute('viewBox');

    await act(async () => {
      restoredSvg?.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }),
      );
    });

    expect(restoredSvg?.getAttribute('viewBox')).not.toBe(restoredViewBox);
  });
});
