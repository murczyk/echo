/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  NetworkCallsignRelationMessage,
  NetworkCallsignRelationNode,
} from '../../../../../Bindings';
import type { NetworkCallsignRelationsEdgeView } from '../network-relations';
import { NetworkCallsignRelationsGraphDetails } from './NetworkCallsignRelationsGraphDetails';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function createNode(): NetworkCallsignRelationNode {
  return {
    id: 'ALPHA',
    label: 'ALPHA',
    weight: 3,
    relationCount: 1,
    activityCount: 3,
    mainRadioStation: true,
    commandControl: false,
    position: 'КР',
    unitName: '1 мб',
    knownCallsignId: 10,
  };
}

function createEdge(): NetworkCallsignRelationsEdgeView {
  return {
    id: 'ALPHA__BRAVO',
    source: 'ALPHA',
    target: 'BRAVO',
    weight: 2,
    byFreq: [{ freq: '652.111', weight: 2 }],
    visibleWeight: 2,
    visibleByFreq: [{ freq: '652.111', weight: 2 }],
  };
}

function createMessage(): NetworkCallsignRelationMessage {
  return {
    id: 1,
    timestamp: 1717000000000,
    freq: '652.111',
    text: 'test message',
    callsigns: ['ALPHA', 'BRAVO'],
  };
}

function renderDetails(
  overrides: Partial<Parameters<typeof NetworkCallsignRelationsGraphDetails>[0]> = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const props: Parameters<typeof NetworkCallsignRelationsGraphDetails>[0] = {
    selectedNode: createNode(),
    selectedEdge: null,
    drilldownNode: null,
    selectedNodeEdges: [createEdge()],
    selectedMessages: [createMessage()],
    selectedMessagesLoading: false,
    selectedMessagesError: null,
    selectedEdgeId: null,
    onBackToNode: () => {},
    onSelectNodeId: () => {},
    onSelectEdgeId: () => {},
    onOpenNodeEdgeId: () => {},
    ...overrides,
  };

  act(() => {
    root.render(<NetworkCallsignRelationsGraphDetails {...props} />);
  });

  return { container, root };
}

describe('NetworkCallsignRelationsGraphDetails', () => {
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

  it('shows selected message cards', () => {
    const view = renderDetails();
    rendered.push(view);

    expect(view.container.textContent).toContain('test message');
    expect(view.container.textContent).toContain('652.111');
    expect(view.container.textContent).toContain('ALPHA');
    expect(view.container.textContent).toContain('BRAVO');
  });

  it('shows a loading state for message fetches', () => {
    const view = renderDetails({ selectedMessages: [], selectedMessagesLoading: true });
    rendered.push(view);

    expect(view.container.textContent).toContain('Завантажуємо повідомлення');
  });

  it('shows message load errors', () => {
    const view = renderDetails({ selectedMessages: [], selectedMessagesError: 'boom' });
    rendered.push(view);

    expect(view.container.textContent).toContain('boom');
  });

  it('shows a back action when edge details were opened from a node list', () => {
    const onBackToNode = vi.fn();
    const view = renderDetails({
      selectedNode: null,
      selectedEdge: createEdge(),
      drilldownNode: createNode(),
      selectedNodeEdges: [],
      onBackToNode,
    });
    rendered.push(view);

    const button = Array.from(view.container.querySelectorAll('button')).find((item) =>
      item.textContent?.includes('До списку ALPHA'),
    );
    expect(button).toBeTruthy();

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onBackToNode).toHaveBeenCalledOnce();
  });
});
