/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const callsignsPaneSpy = vi.hoisted(() => vi.fn());

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  IconButton: ({
    children,
    onClick,
    'aria-label': ariaLabel,
  }: {
    children: ReactNode;
    onClick?: () => void;
    'aria-label'?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  ),
  Tab: (props: { label: ReactNode; value: string; onClick?: () => void }) => (
    <button type="button" onClick={props.onClick} data-value={props.value}>
      {props.label}
    </button>
  ),
  Tabs: (props: { children: ReactNode; onChange?: (_event: Event, value: string) => void }) => (
    <div>
      {Array.isArray(props.children)
        ? props.children.map((child, index) =>
            child && typeof child === 'object' && 'props' in child
              ? {
                  ...child,
                  props: {
                    ...(child as { props: Record<string, unknown> }).props,
                    onClick: () =>
                      props.onChange?.(
                        new Event('change'),
                        String((child as { props: { value: string } }).props.value),
                      ),
                    key: index,
                  },
                }
              : child,
          )
        : props.children}
    </div>
  ),
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  useMediaQuery: () => false,
}));

vi.mock('@mui/icons-material/KeyboardArrowUp', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/KeyboardArrowDown', () => ({ default: () => <span /> }));

vi.mock('./AnalysisStatsPane', () => ({
  AnalysisStatsPane: (props: Record<string, unknown>) => (
    <div>{`charts-panel${'groupsActivity' in props ? '-with-activity' : ''}`}</div>
  ),
}));

vi.mock('./AnalysisFrequenciesPane', () => ({
  AnalysisFrequenciesPane: (props: Record<string, unknown>) => (
    <div>{`frequencies-pane${'groupsActivity' in props ? '-with-activity' : ''}`}</div>
  ),
}));

vi.mock('./AnalysisMapPane', () => ({
  AnalysisMapPane: () => <div>map-pane</div>,
}));

vi.mock('./AnalysisCallsignsPane', () => ({
  AnalysisCallsignsPane: (props: Record<string, unknown>) => {
    callsignsPaneSpy(props);
    return <div>callsigns-pane</div>;
  },
}));

vi.mock('./AnalysisCallsignGraphPane', () => ({
  AnalysisCallsignGraphPane: () => <div>graph-pane</div>,
}));

vi.mock('./AnalysisNewCallsignsCard', () => ({
  AnalysisNewCallsignsCard: () => <div>new-callsigns-card</div>,
}));

import {
  AnalysisSidebar,
  analysisSidebarContentSx,
  analysisSidebarRootSx,
} from './AnalysisSidebar';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function buildProps(
  overrides: Partial<ComponentProps<typeof AnalysisSidebar>> = {},
): ComponentProps<typeof AnalysisSidebar> {
  return {
    callsignGraph: null,
    callsignGraphLoading: false,
    correlatedFreqs: [],
    correlatedFreqsLoaded: false,
    correlatedFreqsLoading: false,
    groupsActivity: null,
    groupsActivityLoadedFreq: null,
    groupsActivityLoadedPeriod: null,
    groupsActivityPeriod: 'selected',
    groupsActivityLoading: false,
    analysisMapInSidebar: false,
    mapAttrs: {
      daterange: '',
      daterangeLoading: '',
      messages: '',
      palitras: '',
      palitrasLoaded: '',
      palitrasLoadState: 'idle',
      points: '',
      selectedUnits: '',
    },
    findCallsignFrequencyMatches: vi.fn(),
    loadCallsignGraph: vi.fn(),
    loadCorrelatedFreqs: vi.fn(),
    loadGroupsActivity: vi.fn(),
    loadMessagesForMap: vi.fn(),
    newCallsigns: [],
    newCallsignsLoading: false,
    options: {
      callsigns: [],
      groups: [],
      networks: [],
    } as ComponentProps<typeof AnalysisSidebar>['options'],
    rightSidebarLoading: false,
    queryState: {
      callsignsSelected: [],
      freqsSelected: [],
      locationsSelected: [],
      networksSelected: [],
      search: '',
      unitsSelected: [],
    } as ComponentProps<typeof AnalysisSidebar>['queryState'],
    rightPanelOpen: true,
    rightSidebarTab: 'stats',
    setRightSidebarTab: vi.fn(),
    topCallsigns: [],
    topFreqs: [],
    topLocations: [],
    topUnits: [],
    refreshMapDateRange: vi.fn(),
    toggleUnitFromMap: vi.fn(),
    toggleRightPanel: vi.fn(),
    updateQueryState: vi.fn(),
    ...overrides,
  };
}

async function renderComponent(props: ComponentProps<typeof AnalysisSidebar>): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AnalysisSidebar {...props} />);
  });
  return { container, root };
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

describe('AnalysisSidebar', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    callsignsPaneSpy.mockClear();
  });

  it('renders stats content for the stats tab', async () => {
    const view = await renderComponent(buildProps({ rightSidebarTab: 'stats' }));
    rendered.push(view);

    expect(view.container.textContent).toContain('charts-panel');
    expect(view.container.textContent).not.toContain('callsigns-pane');
  });

  it('renders the map content for the map tab', async () => {
    const view = await renderComponent(
      buildProps({ analysisMapInSidebar: true, rightSidebarTab: 'map' }),
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('map-pane');
    expect(view.container.textContent).not.toContain('charts-panel');
  });

  it('renders adjacent frequencies only in the frequencies tab', async () => {
    const statsView = await renderComponent(buildProps({ rightSidebarTab: 'stats' }));
    const frequenciesView = await renderComponent(buildProps({ rightSidebarTab: 'frequencies' }));
    rendered.push(statsView, frequenciesView);

    expect(statsView.container.textContent).not.toContain('frequencies-pane');
    expect(statsView.container.textContent).not.toContain('with-activity');
    expect(frequenciesView.container.textContent).toContain('frequencies-pane-with-activity');
    expect(frequenciesView.container.textContent).not.toContain('charts-panel');
  });

  it('hides the map tab when the map is not in the sidebar', async () => {
    const view = await renderComponent(buildProps({ analysisMapInSidebar: false }));
    rendered.push(view);

    expect(
      Array.from(view.container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Мапа'),
      ),
    ).toBe(false);
  });

  it('shows the map tab when the map is in the sidebar', async () => {
    const view = await renderComponent(buildProps({ analysisMapInSidebar: true }));
    rendered.push(view);

    expect(
      Array.from(view.container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Мапа'),
      ),
    ).toBe(true);
  });

  it('renders only the callsigns content for the callsigns tab', async () => {
    const view = await renderComponent(buildProps({ rightSidebarTab: 'callsigns' }));
    rendered.push(view);

    expect(view.container.textContent).toContain('callsigns-pane');
    expect(view.container.textContent).not.toContain('graph-pane');
    expect(view.container.textContent).not.toContain('overview-card');
  });

  it('sends lowercase callsigns selected from the right panel', async () => {
    const updateQueryState = vi.fn();
    const view = await renderComponent(
      buildProps({
        options: {
          callsigns: [{ value: 'НУГУШ', label: 'НУГУШ', count: 3 }],
          groups: [],
          networks: [],
        } as ComponentProps<typeof AnalysisSidebar>['options'],
        rightSidebarTab: 'callsigns',
        updateQueryState,
      }),
    );
    rendered.push(view);

    const callsignsProps = callsignsPaneSpy.mock.lastCall?.[0] as {
      onToggleCallsign: (callsign: string) => void;
    };
    callsignsProps.onToggleCallsign('НУГУШ');

    expect(updateQueryState).toHaveBeenCalledWith({ callsignsSelected: ['нугуш'] });
  });

  it('renders the relations graph only in the graph tab', async () => {
    const view = await renderComponent(buildProps({ rightSidebarTab: 'graph' }));
    rendered.push(view);

    expect(view.container.textContent).toContain('graph-pane');
    expect(view.container.textContent).not.toContain('callsigns-pane');
  });

  it('keeps the sidebar tab order without the summary table', async () => {
    const view = await renderComponent(buildProps({ analysisMapInSidebar: false }));
    rendered.push(view);

    const tabLabels = Array.from(view.container.querySelectorAll('button'))
      .map((button) => button.textContent?.trim())
      .filter((label): label is string => Boolean(label));

    expect(tabLabels.slice(0, 5)).toEqual(['Зведення', 'Частоти', 'Позивні', 'Граф', 'Нові']);
    expect(tabLabels.some((label) => label.includes('Зведена таблиця'))).toBe(false);
  });

  it('routes tab clicks into the page callback', async () => {
    const setRightSidebarTab = vi.fn();
    const view = await renderComponent(buildProps({ setRightSidebarTab }));
    rendered.push(view);

    const statsTab = Array.from(view.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Зведення'),
    );
    expect(statsTab).toBeTruthy();

    await click(statsTab as HTMLButtonElement);

    expect(setRightSidebarTab).toHaveBeenCalledWith('stats');
  });

  it('closes the sidebar from its narrow-layout control', async () => {
    const toggleRightPanel = vi.fn();
    const view = await renderComponent(buildProps({ toggleRightPanel }));
    rendered.push(view);

    const closeButton = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Згорнути праву панель"]',
    );
    expect(closeButton).not.toBeNull();

    await click(closeButton as HTMLButtonElement);
    expect(toggleRightPanel).toHaveBeenCalledTimes(1);
  });

  it('keeps the sidebar body as the narrow vertical scroll owner', () => {
    expect(analysisSidebarRootSx.height).toBe('100%');
    expect(analysisSidebarRootSx.overflow).toBe('hidden');
    expect(analysisSidebarContentSx.overflowY).toBe('auto');
    expect(analysisSidebarContentSx.overflowX).toBe('hidden');
  });

  it('allows a null tab while the right panel is closed', async () => {
    const view = await renderComponent(
      buildProps({ rightPanelOpen: false, rightSidebarTab: null }),
    );
    rendered.push(view);

    expect(view.container.textContent).not.toContain('callsigns-pane');
  });
});
