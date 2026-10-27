/**
 * @vitest-environment happy-dom
 */
import { RadioFeaturesProvider } from '../../../shared/RadioFeatures';
import { act } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../AnalysisCountBlock', () => ({
  AnalysisCountBlock: ({ title }: { title: string }) => (
    <section aria-label={title}>{title}</section>
  ),
}));

import { AnalysisStatsPane } from '../AnalysisStatsPane';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function buildProps(
  overrides: Partial<ComponentProps<typeof AnalysisStatsPane>> = {},
): ComponentProps<typeof AnalysisStatsPane> {
  return {
    groupsLoading: false,
    hideNetworks: false,
    onClearFreq: vi.fn(),
    onClearGroup: vi.fn(),
    onClearLocation: vi.fn(),
    onClearNetwork: vi.fn(),
    onClearUnit: vi.fn(),
    onAddFreq: vi.fn(),
    onAddGroup: vi.fn(),
    onAddLocation: vi.fn(),
    onAddNetwork: vi.fn(),
    onAddUnit: vi.fn(),
    onToggleFreq: vi.fn(),
    onToggleGroup: vi.fn(),
    onToggleLocation: vi.fn(),
    onToggleNetwork: vi.fn(),
    onToggleUnit: vi.fn(),
    rightSidebarLoading: false,
    selectedFreqs: [],
    selectedGroups: [],
    selectedLocations: [],
    selectedNetworks: [],
    selectedUnits: [],
    topFreqs: [],
    topGroups: [],
    topLocations: [],
    topNetworks: [],
    topUnits: [],
    ...overrides,
  };
}

async function renderComponent(props: ComponentProps<typeof AnalysisStatsPane>): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <RadioFeaturesProvider allowed>
        <AnalysisStatsPane {...props} />
      </RadioFeaturesProvider>,
    );
  });
  return { container, root };
}

describe('AnalysisStatsPane', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  // Regression: https://github.com/echoua/echo/issues/3598
  it('hides only the network block when network visibility is disabled', async () => {
    const hidden = await renderComponent(buildProps({ hideNetworks: true }));
    rendered.push(hidden);

    expect(hidden.container.querySelector('[aria-label="Мережі"]')).toBeNull();
    expect(hidden.container.querySelector('[aria-label="Частоти"]')).not.toBeNull();
    expect(hidden.container.querySelector('[aria-label="Підрозділи"]')).not.toBeNull();
    expect(hidden.container.querySelector('[aria-label="Локації"]')).not.toBeNull();

    const visible = await renderComponent(buildProps());
    rendered.push(visible);

    expect(visible.container.querySelector('[aria-label="Мережі"]')).not.toBeNull();
  });
});
