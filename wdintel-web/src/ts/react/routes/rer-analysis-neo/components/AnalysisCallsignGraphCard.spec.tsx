/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NetJsonGraphAndMeta } from '../../../../../Bindings';

vi.mock('../../../../../../static/netjsongraph/netjsongraph.min.js', () => ({}));

import { AnalysisCallsignGraphCard } from './AnalysisCallsignGraphCard';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

type MockGraph = {
  render: () => void;
  el: HTMLElement;
  config: { el: HTMLElement };
};

const renderCalls: string[] = [];
let shouldRenderThrow = false;

class MockNetJSONGraph implements MockGraph {
  el: HTMLElement;
  config: { el: HTMLElement };

  constructor(_graphData: unknown, options: { el: HTMLElement }) {
    this.el = options.el;
    this.config = { el: options.el };
  }

  render() {
    renderCalls.push(this.el.id || this.el.className || 'graph');
    if (shouldRenderThrow) {
      throw new Error('render failed');
    }
    this.el.replaceChildren();
    const marker = document.createElement('div');
    marker.textContent = 'netjson-graph';
    this.el.appendChild(marker);
    const sideBar = document.createElement('div');
    sideBar.className = 'njg-sideBar';
    sideBar.appendChild(document.createElement('button')).className = 'sideBarHandle';
    this.el.appendChild(sideBar);
  }
}

function createGraph(label = 'ALPHA'): NetJsonGraphAndMeta {
  return {
    graph: {
      type_: 'netjson',
      nodes: [{ id: label, label, count: 1 }],
      links: [],
    },
    linkCategories: [],
    overallCount: 1,
  } as NetJsonGraphAndMeta;
}

async function renderComponent(
  props: Partial<Parameters<typeof AnalysisCallsignGraphCard>[0]> = {},
): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <AnalysisCallsignGraphCard
        graph={null}
        loading={false}
        loadVersion={0}
        nolimit={false}
        onLoad={vi.fn()}
        onToggleNolimit={vi.fn()}
        visible={true}
        {...props}
      />,
    );
    await Promise.resolve();
  });

  return { container, root };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AnalysisCallsignGraphCard', () => {
  const rendered: Rendered[] = [];

  beforeEach(() => {
    shouldRenderThrow = false;
    renderCalls.length = 0;
    (
      window as typeof window & {
        NetJSONGraph?: typeof MockNetJSONGraph;
        netjson_graphs?: Record<string, MockGraph>;
      }
    ).NetJSONGraph = MockNetJSONGraph;
    window.netjson_graphs = {};
  });

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    delete (window as typeof window & { NetJSONGraph?: typeof MockNetJSONGraph }).NetJSONGraph;
    delete window.netjson_graphs;
    vi.clearAllMocks();
  });

  it('shows the initial loading state before the graph arrives', async () => {
    const view = await renderComponent({ loading: true, graph: null });
    rendered.push(view);

    expect(view.container.textContent).toContain('Завантажуємо граф позивних');
    expect(view.container.querySelector('[aria-label="Оновити граф"]')).not.toBeNull();
  });

  it('keeps the existing graph visible while refreshing', async () => {
    const graph = createGraph();
    const view = await renderComponent({ graph, loading: false });
    rendered.push(view);
    await flush();

    expect(view.container.textContent).toContain('netjson-graph');
    expect(view.container.querySelector('.analysis-callsign-graph')).not.toBeNull();
    expect(view.container.querySelector('.analysis-callsign-graph .njg-sideBar')).not.toBeNull();
    expect(view.container.querySelector('.analysis-callsign-graph .sideBarHandle')).not.toBeNull();

    await act(async () => {
      view.root.render(
        <AnalysisCallsignGraphCard
          graph={graph}
          loading={true}
          loadVersion={0}
          nolimit={false}
          onLoad={vi.fn()}
          onToggleNolimit={vi.fn()}
          visible={true}
        />,
      );
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('netjson-graph');
    expect(view.container.textContent).toContain('Оновлюється...');
    expect(view.container.textContent).not.toContain('Завантажуємо граф позивних');
    expect(view.container.querySelector('[role="progressbar"]')).toBeNull();
    expect(renderCalls.length).toBeGreaterThan(0);
  });

  it('keeps the previous graph visible when a render attempt fails', async () => {
    const view = await renderComponent({ graph: createGraph(), loading: false });
    rendered.push(view);
    await flush();

    const previousGraph = Object.values(window.netjson_graphs ?? {})[0] as MockGraph | undefined;
    shouldRenderThrow = true;

    await act(async () => {
      view.root.render(
        <AnalysisCallsignGraphCard
          graph={createGraph('CHARLIE')}
          loading={false}
          loadVersion={1}
          nolimit={false}
          onLoad={vi.fn()}
          onToggleNolimit={vi.fn()}
          visible={true}
        />,
      );
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('netjson-graph');
    expect(view.container.textContent).toContain('Не вдалося оновити, показано попередній граф.');
    expect(Object.values(window.netjson_graphs ?? {})[0]).toBe(previousGraph);
  });

  it('keeps one refresh control in the header', async () => {
    const view = await renderComponent({ graph: createGraph(), loading: false });
    rendered.push(view);
    await flush();

    expect(view.container.querySelectorAll('[aria-label="Оновити граф"]')).toHaveLength(1);
  });
});
