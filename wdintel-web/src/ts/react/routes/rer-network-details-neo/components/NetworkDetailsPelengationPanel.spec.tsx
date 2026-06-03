/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkPoint } from '../../../../../Bindings';

vi.mock('./NetworkDatePickerField', () => ({
  NetworkDatePickerField: ({ label }: { label: string }) => <div data-testid={`date-picker-${label}`} />,
}));
vi.mock('./NetworkDetailsLoadingState', () => ({
  NetworkDetailsLoadingState: ({ message }: { message: string }) => <div data-testid="peleng-loading">{message}</div>,
}));
vi.mock('./NetworkDetailsPelengationMap', () => ({
  NetworkDetailsPelengationMap: () => <div data-testid="pelengation-map" />,
}));

import { NetworkDetailsPelengationPanel } from './NetworkDetailsPelengationPanel';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const visiblePoint: NetworkPoint = {
  id: 1,
  lat: 49.1,
  lng: 32.1,
  body: 'one',
  freq: '146.5000',
};

function renderPanel(pelengPoints: NetworkPoint[] = []) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <NetworkDetailsPelengationPanel
        pelengPoints={pelengPoints}
        pelengPointsLoaded={true}
        pelengPointsLoading={false}
        pelengPointsError={null}
        pelengSince="2026-05-20"
        pelengTill="2026-05-20"
        pelengSearch=""
        pelengEnabledFreqs={[]}
        pelengShowLabels={true}
        pelengSatelliteEnabled={true}
        pelengHeatmapEnabled={false}
        onReloadPelengPoints={vi.fn()}
        onPelengSinceChange={vi.fn()}
        onPelengTillChange={vi.fn()}
        onPelengSearchChange={vi.fn()}
        onPelengEnabledFreqsChange={vi.fn()}
        onPelengShowLabelsChange={vi.fn()}
        onPelengSatelliteEnabledChange={vi.fn()}
        onPelengHeatmapEnabledChange={vi.fn()}
      />,
    );
  });

  return { container, root };
}

function renderLoadingPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <NetworkDetailsPelengationPanel
        pelengPoints={[]}
        pelengPointsLoaded={false}
        pelengPointsLoading={true}
        pelengPointsError={null}
        pelengSince="2026-05-20"
        pelengTill="2026-05-20"
        pelengSearch=""
        pelengEnabledFreqs={[]}
        pelengShowLabels={true}
        pelengSatelliteEnabled={true}
        pelengHeatmapEnabled={false}
        onReloadPelengPoints={vi.fn()}
        onPelengSinceChange={vi.fn()}
        onPelengTillChange={vi.fn()}
        onPelengSearchChange={vi.fn()}
        onPelengEnabledFreqsChange={vi.fn()}
        onPelengShowLabelsChange={vi.fn()}
        onPelengSatelliteEnabledChange={vi.fn()}
        onPelengHeatmapEnabledChange={vi.fn()}
      />,
    );
  });

  return { container, root };
}

describe('NetworkDetailsPelengationPanel', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    document.body.innerHTML = '';
  });

  it('shows the empty-state card when no pelengation points exist', () => {
    const view = renderPanel();
    rendered.push(view);

    expect(view.container.textContent).toContain('Немає пеленгації');
    expect(view.container.textContent).toContain('Підключіть пости, щоб бачити геопросторові дані');
    expect(view.container.querySelector('[data-testid="pelengation-map"]')).toBeNull();
  });

  it('shows loading state while pelengation points are reloading', () => {
    const view = renderLoadingPanel();
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="peleng-loading"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Завантажуємо пеленги');
    expect(view.container.querySelector('[data-testid="pelengation-map"]')).toBeNull();
    expect(view.container.querySelector('input[placeholder="Пошук"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="date-picker-Від"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="date-picker-До"]')).not.toBeNull();
  });

  it('keeps recovery controls visible when filters hide all points', () => {
    const view = renderPanel([visiblePoint]);
    rendered.push(view);

    expect(view.container.textContent).toContain('Немає видимих пеленгів');
    expect(view.container.querySelector('[data-testid="pelengation-map"]')).toBeNull();
    expect(view.container.querySelector('input[placeholder="Пошук"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="date-picker-Від"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="date-picker-До"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Частоти');
    expect(view.container.textContent).not.toContain('Усі');
    expect(view.container.textContent).not.toContain('Нічого');
    expect(view.container.textContent).toContain('Супутник');
    expect(view.container.textContent).toContain('Heatmap');
  });
});
