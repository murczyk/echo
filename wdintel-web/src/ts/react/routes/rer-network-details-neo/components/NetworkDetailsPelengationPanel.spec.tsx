/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./NetworkDetailsPelengationMap', () => ({
  NetworkDetailsPelengationMap: () => <div data-testid="pelengation-map" />,
}));

import { NetworkDetailsPelengationPanel } from './NetworkDetailsPelengationPanel';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function renderPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <NetworkDetailsPelengationPanel
        pelengPoints={[]}
        pelengPointsLoaded={true}
        pelengPointsLoading={false}
        pelengPointsError={null}
        onReloadPelengPoints={vi.fn()}
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
    expect(view.container.textContent).toContain('Підключіть пости, щоб бачити геопросторові дані.');
    expect(view.container.querySelector('[data-testid="pelengation-map"]')).toBeNull();
  });
});
