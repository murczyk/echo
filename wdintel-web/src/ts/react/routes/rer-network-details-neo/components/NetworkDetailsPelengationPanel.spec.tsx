/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkPoint } from '../../../../../Bindings';

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
        pelengSince="2026-05-20T00:00"
        pelengTill="2026-05-20T01:00"
        pelengSearch=""
        pelengEnabledFreqs={[]}
        pelengShowLabels={true}
        onReloadPelengPoints={vi.fn()}
        onPelengSinceChange={vi.fn()}
        onPelengTillChange={vi.fn()}
        onPelengSearchChange={vi.fn()}
        onPelengEnabledFreqsChange={vi.fn()}
        onPelengShowLabelsChange={vi.fn()}
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

  it('keeps recovery controls visible when filters hide all points', () => {
    const view = renderPanel([visiblePoint]);
    rendered.push(view);

    expect(view.container.textContent).toContain('Немає видимих пеленгів');
    expect(view.container.querySelector('[data-testid="pelengation-map"]')).toBeNull();
    expect(view.container.querySelector('input[placeholder="Пошук частот"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Частоти');
    expect(view.container.textContent).toContain('Усі');
    expect(view.container.textContent).toContain('Нічого');
  });
});
