/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tab: (props: { label: ReactNode; value: string; onClick?: () => void }) => (
    <button type="button" onClick={props.onClick} data-value={props.value}>
      {props.label}
    </button>
  ),
  Tabs: (props: {
    children: ReactNode;
    onChange?: (_event: Event, value: string) => void;
  }) => (
    <div>
      {Array.isArray(props.children)
        ? props.children.map((child, index) =>
            child && typeof child === 'object' && 'props' in child
              ? {
                  ...child,
                  props: {
                    ...(child as { props: Record<string, unknown> }).props,
                    onClick: () => props.onChange?.(new Event('change'), String((child as { props: { value: string } }).props.value)),
                    key: index,
                  },
                }
              : child,
          )
        : props.children}
    </div>
  ),
  useMediaQuery: () => false,
}));

vi.mock('./AnalysisStatsPane', () => ({
  AnalysisStatsPane: () => <div>charts-panel</div>,
}));

vi.mock('./AnalysisMapPane', () => ({
  AnalysisMapPane: () => <div>map-pane</div>,
}));

vi.mock('./AnalysisCallsignsPane', () => ({
  AnalysisCallsignsPane: () => <div>callsigns-pane</div>,
}));

vi.mock('./AnalysisNewCallsignsCard', () => ({
  AnalysisNewCallsignsCard: () => <div>new-callsigns-card</div>,
}));

import { AnalysisSidebar } from './AnalysisSidebar';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function buildProps(overrides: Partial<ComponentProps<typeof AnalysisSidebar>> = {}): ComponentProps<typeof AnalysisSidebar> {
  return {
    callsignGraph: null,
    callsignGraphLoading: false,
    callsignGraphLoadVersion: 0,
    callsignGraphNolimit: false,
    correlatedFreqs: [],
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
    loadCallsignGraph: vi.fn(),
    loadCorrelatedFreqs: vi.fn(),
    loadGroupsActivity: vi.fn(),
    loadMessagesForMap: vi.fn(),
    newCallsigns: [],
    newCallsignsLoading: false,
    rightSidebarLoading: false,
    queryState: {
      freqsSelected: [],
      search: '',
    } as ComponentProps<typeof AnalysisSidebar>['queryState'],
    rightPanelOpen: true,
    rightSidebarTab: 'stats',
    selectOnlyFreq: vi.fn(),
    setRightSidebarTab: vi.fn(),
    topCallsigns: [],
    topFreqs: [],
    topLocations: [],
    topUnits: [],
    refreshMapDateRange: vi.fn(),
    toggleCallsignGraphNolimit: vi.fn(),
    toggleUnitFromMap: vi.fn(),
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
  });

  it('renders stats content for the stats tab', async () => {
    const view = await renderComponent(buildProps({ rightSidebarTab: 'stats' }));
    rendered.push(view);

    expect(view.container.textContent).toContain('charts-panel');
    expect(view.container.textContent).not.toContain('callsigns-pane');
  });

  it('renders the map content for the map tab', async () => {
    const view = await renderComponent(buildProps({ analysisMapInSidebar: true, rightSidebarTab: 'map' }));
    rendered.push(view);

    expect(view.container.textContent).toContain('map-pane');
    expect(view.container.textContent).not.toContain('charts-panel');
  });

  it('hides the map tab when the map is not in the sidebar', async () => {
    const view = await renderComponent(buildProps({ analysisMapInSidebar: false }));
    rendered.push(view);

    expect(Array.from(view.container.querySelectorAll('button')).some((button) => button.textContent?.includes('Мапа'))).toBe(false);
  });

  it('shows the map tab when the map is in the sidebar', async () => {
    const view = await renderComponent(buildProps({ analysisMapInSidebar: true }));
    rendered.push(view);

    expect(Array.from(view.container.querySelectorAll('button')).some((button) => button.textContent?.includes('Мапа'))).toBe(true);
  });

  it('renders only the callsigns content for the callsigns tab', async () => {
    const view = await renderComponent(buildProps({ rightSidebarTab: 'callsigns' }));
    rendered.push(view);

    expect(view.container.textContent).toContain('callsigns-pane');
    expect(view.container.textContent).not.toContain('overview-card');
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

  it('allows a null tab while the right panel is closed', async () => {
    const view = await renderComponent(buildProps({ rightPanelOpen: false, rightSidebarTab: null }));
    rendered.push(view);

    expect(view.container.textContent).not.toContain('callsigns-pane');
  });
});
