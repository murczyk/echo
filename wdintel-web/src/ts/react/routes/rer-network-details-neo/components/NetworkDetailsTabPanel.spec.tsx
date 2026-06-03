/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./NetworkCallsignsTables', () => ({
  NetworkDetailsCallsignsPanel: () => <div data-testid="callsigns-panel" />,
}));
vi.mock('./NetworkDetailsActivityPanel', () => ({
  NetworkDetailsActivityPanel: () => <div data-testid="activity-panel" />,
}));
vi.mock('./NetworkDetailsDescriptionsPanel', () => ({
  NetworkDetailsDescriptionsPanel: () => <div data-testid="descriptions-panel" />,
}));
vi.mock('./NetworkDetailsFrequenciesPanel', () => ({
  NetworkDetailsFrequenciesPanel: () => <div data-testid="frequencies-panel" />,
}));
vi.mock('./NetworkDetailsPelengationPanel', () => ({
  NetworkDetailsPelengationPanel: () => <div data-testid="pelengation-panel" />,
}));
vi.mock('./NetworkCallsignRelationsPanel', () => ({
  NetworkCallsignRelationsPanel: () => <div data-testid="relations-panel" />,
}));

import { NetworkDetailsTabPanel } from './NetworkDetailsTabPanel';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function renderPanel(): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const props = {
    network: null,
    loading: false,
    confirmationDescriptions: [],
    signDescriptions: [],
    canManageDescriptions: false,
    canManageFrequencies: false,
    canViewActivityTab: true,
    canViewRelationsTab: true,
    activeNetworkDetailsTab: 'relations',
    expandedDescriptionIds: [],
    onSetActiveNetworkDetailsTab: vi.fn(),
    onToggleExpanded: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onCreate: vi.fn(),
    freqs: [],
    freqsLoaded: false,
    freqsLoading: false,
    freqsError: null,
    networkActivity: {},
    networkActivityLoaded: false,
    networkActivityLoading: false,
    networkActivityError: null,
    relations: {
      nodes: [],
      edges: [],
      freqs: [],
    },
    relationsLoaded: true,
    relationsLoading: false,
    relationsError: null,
    relationsSearch: '',
    relationsEnabledFreqs: [],
    relationsMinIntensity: 10,
    relationsShowLabels: true,
    relationsSelectedNodeId: null,
    relationsSelectedEdgeId: null,
    onReloadRelations: vi.fn(),
    onRelationsSearchChange: vi.fn(),
    onRelationsEnabledFreqsChange: vi.fn(),
    onRelationsMinIntensityChange: vi.fn(),
    onRelationsShowLabelsChange: vi.fn(),
    onRelationsSelectNodeId: vi.fn(),
    onRelationsSelectEdgeId: vi.fn(),
    pelengPoints: [],
    pelengPointsLoaded: false,
    pelengPointsLoading: false,
    pelengPointsError: null,
    pelengSince: '2026-05-20',
    pelengTill: '2026-05-20',
    pelengSearch: '',
    pelengEnabledFreqs: [],
    pelengShowLabels: true,
    pelengSatelliteEnabled: true,
    pelengHeatmapEnabled: false,
    onReloadNetworkActivity: vi.fn(),
    onReloadPelengPoints: vi.fn(),
    onPelengSinceChange: vi.fn(),
    onPelengTillChange: vi.fn(),
    onPelengSearchChange: vi.fn(),
    onPelengEnabledFreqsChange: vi.fn(),
    onPelengShowLabelsChange: vi.fn(),
    onPelengSatelliteEnabledChange: vi.fn(),
    onPelengHeatmapEnabledChange: vi.fn(),
    modulations: [],
    expandedFrequencyGroupIds: [],
    toggleFrequencyGroupExpanded: vi.fn(),
    onOpenFreqCreateWizard: vi.fn(),
    onOpenFreqEditDrawer: vi.fn(),
    onOpenFreqTechDrawer: vi.fn(),
    onOpenDeleteFreqDialog: vi.fn(),
    onOpenFreqRowActions: vi.fn(),
    onCloseFreqRowActions: vi.fn(),
    freqRowActionMenuAnchorEl: null,
    freqRowActionTargetId: null,
    onReloadFrequencies: vi.fn(),
    callsignPanelProps: {} as any,
  } as const;

  act(() => {
    root.render(<NetworkDetailsTabPanel {...(props as any)} />);
  });

  return { container, root };
}

describe('NetworkDetailsTabPanel', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('renders the relations tab label and panel', async () => {
    const view = renderPanel();
    rendered.push(view);

    expect(view.container.textContent).toContain("Граф зв'язків");
    expect(view.container.querySelector('[data-testid="relations-panel"]')).not.toBeNull();
  });

  it('hides the activity and relations tabs when access is not granted', async () => {
    const view = renderPanel();
    rendered.push(view);

    act(() => {
      view.root.render(
        <NetworkDetailsTabPanel
          network={null}
          loading={false}
          confirmationDescriptions={[]}
          signDescriptions={[]}
          canManageDescriptions={false}
          canManageFrequencies={false}
          canViewActivityTab={false}
          canViewRelationsTab={false}
          activeNetworkDetailsTab="descriptions"
          expandedDescriptionIds={[]}
          onSetActiveNetworkDetailsTab={vi.fn()}
          onToggleExpanded={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onCreate={vi.fn()}
          freqs={[]}
          freqsLoaded={false}
          freqsLoading={false}
          freqsError={null}
          networkActivity={{}}
          networkActivityLoaded={false}
          networkActivityLoading={false}
          networkActivityError={null}
          relations={null}
          relationsLoaded={false}
          relationsLoading={false}
          relationsError={null}
          relationsSearch=""
          relationsEnabledFreqs={[]}
          relationsMinIntensity={10}
          relationsShowLabels={true}
          relationsSelectedNodeId={null}
          relationsSelectedEdgeId={null}
          relationsSince=""
          relationsTill=""
          pelengSince="2026-05-20"
          pelengTill="2026-05-20"
          pelengSearch=""
          pelengEnabledFreqs={[]}
          pelengShowLabels={true}
          pelengSatelliteEnabled={true}
          pelengHeatmapEnabled={false}
          onReloadRelations={vi.fn()}
          onRelationsSearchChange={vi.fn()}
          onRelationsEnabledFreqsChange={vi.fn()}
          onRelationsMinIntensityChange={vi.fn()}
          onRelationsShowLabelsChange={vi.fn()}
          onRelationsSelectNodeId={vi.fn()}
          onRelationsSelectEdgeId={vi.fn()}
          onRelationsSinceChange={vi.fn()}
          onRelationsTillChange={vi.fn()}
          onPelengSinceChange={vi.fn()}
          onPelengTillChange={vi.fn()}
          onPelengSearchChange={vi.fn()}
          onPelengEnabledFreqsChange={vi.fn()}
          onPelengShowLabelsChange={vi.fn()}
          onPelengSatelliteEnabledChange={vi.fn()}
          onPelengHeatmapEnabledChange={vi.fn()}
          pelengPoints={[]}
          pelengPointsLoaded={false}
          pelengPointsLoading={false}
          pelengPointsError={null}
          onReloadNetworkActivity={vi.fn()}
          onReloadPelengPoints={vi.fn()}
          modulations={[]}
          expandedFrequencyGroupIds={[]}
          toggleFrequencyGroupExpanded={vi.fn()}
          onOpenFreqCreateWizard={vi.fn()}
          onOpenFreqEditDrawer={vi.fn()}
          onOpenFreqTechDrawer={vi.fn()}
          onOpenDeleteFreqDialog={vi.fn()}
          onOpenFreqRowActions={vi.fn()}
          onCloseFreqRowActions={vi.fn()}
          freqRowActionMenuAnchorEl={null}
          freqRowActionTargetId={null}
          onReloadFrequencies={vi.fn()}
          callsignPanelProps={{} as any}
        />,
      );
    });

    expect(view.container.textContent).not.toContain('Активність');
    expect(view.container.textContent).not.toContain("Граф зв'язків");
  });
});
