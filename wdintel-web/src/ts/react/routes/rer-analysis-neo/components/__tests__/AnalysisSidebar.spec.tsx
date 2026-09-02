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

vi.mock('.././AnalysisStatsPane', () => ({
  AnalysisStatsPane: (props: Record<string, unknown>) => (
    <div>{`charts-panel${'groupsActivity' in props ? '-with-activity' : ''}`}</div>
  ),
}));

vi.mock('.././AnalysisFrequenciesPane', () => ({
  AnalysisFrequenciesPane: (props: Record<string, unknown>) => (
    <div>{`frequencies-pane${'groupsActivity' in props ? '-with-activity' : ''}`}</div>
  ),
}));

vi.mock('.././AnalysisMapPane', () => ({
  AnalysisMapPane: () => <div>map-pane</div>,
}));

vi.mock('.././AnalysisCallsignsPane', () => ({
  AnalysisCallsignsPane: (props: Record<string, unknown>) => {
    callsignsPaneSpy(props);
    return <div>callsigns-pane</div>;
  },
}));

vi.mock('.././AnalysisCallsignGraphPane', () => ({
  AnalysisCallsignGraphPane: () => <div>graph-pane</div>,
}));

vi.mock('.././AnalysisNewCallsignsCard', () => ({
  AnalysisNewCallsignsCard: () => <div>new-callsigns-card</div>,
}));

import { AnalysisSidebar } from '.././AnalysisSidebar';

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

// @test-scope safeguard: preserves selected callsign values and sidebar close/tab actions so the analysis workspace cannot apply a user action to the wrong active panel.
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

  it('allows a null tab while the right panel is closed', async () => {
    const view = await renderComponent(
      buildProps({ rightPanelOpen: false, rightSidebarTab: null }),
    );
    rendered.push(view);

    expect(view.container.textContent).not.toContain('callsigns-pane');
  });
});
