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
}));

vi.mock('./AnalysisOverviewCard', () => ({
  AnalysisOverviewCard: () => <div>overview-card</div>,
}));

vi.mock('./AnalysisChartsPanel', () => ({
  AnalysisChartsPanel: () => <div>charts-panel</div>,
}));

vi.mock('./AnalysisCallsignsCloudCard', () => ({
  AnalysisCallsignsCloudCard: () => <div>callsigns-cloud</div>,
}));

vi.mock('./AnalysisCallsignGraphCard', () => ({
  AnalysisCallsignGraphCard: () => <div>callsign-graph</div>,
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
    counts: null,
    filtersLoading: false,
    groupsActivity: null,
    groupsActivityLoadedFreq: null,
    groupsActivityLoadedPeriod: null,
    groupsActivityPeriod: 'selected',
    groupsActivityLoading: false,
    loadCallsignGraph: vi.fn(),
    loadCorrelatedFreqs: vi.fn(),
    loadGroupsActivity: vi.fn(),
    newCallsigns: [],
    newCallsignsLoading: false,
    queryState: {
      freqsSelected: [],
    } as ComponentProps<typeof AnalysisSidebar>['queryState'],
    rightPanelOpen: true,
    rightSidebarTab: 'stats',
    selectOnlyFreq: vi.fn(),
    setRightSidebarTab: vi.fn(),
    topCallsigns: [],
    topFreqs: [],
    topLocations: [],
    topUnits: [],
    toggleCallsignGraphNolimit: vi.fn(),
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

    expect(view.container.textContent).toContain('overview-card');
    expect(view.container.textContent).toContain('charts-panel');
    expect(view.container.textContent).not.toContain('callsigns-cloud');
  });

  it('renders only the callsigns content for the callsigns tab', async () => {
    const view = await renderComponent(buildProps({ rightSidebarTab: 'callsigns' }));
    rendered.push(view);

    expect(view.container.textContent).toContain('callsigns-cloud');
    expect(view.container.textContent).toContain('callsign-graph');
    expect(view.container.textContent).not.toContain('overview-card');
  });

  it('routes tab clicks into the page callback', async () => {
    const setRightSidebarTab = vi.fn();
    const view = await renderComponent(buildProps({ setRightSidebarTab }));
    rendered.push(view);

    const newTab = Array.from(view.container.querySelectorAll('button')).find((button) => button.textContent?.includes('Нові'));
    expect(newTab).toBeTruthy();

    await click(newTab as HTMLButtonElement);

    expect(setRightSidebarTab).toHaveBeenCalledWith('newCallsigns');
  });
});
