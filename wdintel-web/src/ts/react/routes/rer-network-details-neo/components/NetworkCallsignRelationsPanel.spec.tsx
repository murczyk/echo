/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkCallsignRelationsRsp } from '../../../../../Bindings';

vi.mock('./NetworkDatePickerField', () => ({
  NetworkDatePickerField: ({ label }: { label: string }) => <div data-testid={`date-picker-${label}`} />,
}));

import { NetworkCallsignRelationsPanel } from './NetworkCallsignRelationsPanel';
import { EMPTY_STATE_NO_RESULTS_TEXT } from '../../shared/empty-state-text';
import { NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY } from '../use-rer-network-details-neo-page.shared';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function createDenseRelations(): NetworkCallsignRelationsRsp {
  const nodes = Array.from({ length: 301 }, (_, index) => {
    const id = `NODE_${String(index).padStart(3, '0')}`;
    return {
      id,
      label: id,
      weight: 1,
      relationCount: index === 0 || index === 300 ? 1 : 2,
      activityCount: 1,
      position: null,
      unitName: null,
      knownCallsignId: null,
    };
  });

  const edges = Array.from({ length: 300 }, (_, index) => {
    const source = `NODE_${String(index).padStart(3, '0')}`;
    const target = `NODE_${String(index + 1).padStart(3, '0')}`;
    return {
      id: `${source}__${target}`,
      source,
      target,
      weight: 1,
      byFreq: [{ freq: '652.111', weight: 1 }],
    };
  });

  return {
    nodes,
    edges,
    freqs: [{ freq: '652.111', enabledByDefault: true }],
  };
}

function createDenseUiRelations(): NetworkCallsignRelationsRsp {
  const nodes = Array.from({ length: 41 }, (_, index) => {
    const id = `NODE_${String(index).padStart(3, '0')}`;
    return {
      id,
      label: id,
      weight: 1,
      relationCount: index === 0 || index === 40 ? 1 : 2,
      activityCount: 1,
      position: null,
      unitName: null,
      knownCallsignId: null,
    };
  });

  const edges = Array.from({ length: 40 }, (_, index) => {
    const source = `NODE_${String(index).padStart(3, '0')}`;
    const target = `NODE_${String(index + 1).padStart(3, '0')}`;
    return {
      id: `${source}__${target}`,
      source,
      target,
      weight: 1,
      byFreq: [{ freq: '652.111', weight: 1 }],
    };
  });

  return {
    nodes,
    edges,
    freqs: [{ freq: '652.111', enabledByDefault: true }],
  };
}

function createSparseRelations(): NetworkCallsignRelationsRsp {
  return {
    nodes: [
      {
        id: 'ALPHA',
        label: 'ALPHA',
        weight: 3,
        relationCount: 1,
        activityCount: 3,
        position: null,
        unitName: null,
        knownCallsignId: null,
      },
      {
        id: 'BRAVO',
        label: 'BRAVO',
        weight: 2,
        relationCount: 1,
        activityCount: 2,
        position: null,
        unitName: null,
        knownCallsignId: null,
      },
    ],
    edges: [
      {
        id: 'ALPHA__BRAVO',
        source: 'ALPHA',
        target: 'BRAVO',
        weight: 20,
        byFreq: [
          { freq: '652.111', weight: 12 },
          { freq: '852.111', weight: 8 },
        ],
      },
    ],
    freqs: [
      { freq: '652.111', enabledByDefault: true },
      { freq: '852.111', enabledByDefault: true },
    ],
  };
}

function createSparseRelationsWithDisabledDefaultFreq(): NetworkCallsignRelationsRsp {
  return {
    ...createSparseRelations(),
    freqs: [
      { freq: '652.111', enabledByDefault: true },
      { freq: '852.111', enabledByDefault: false },
    ],
  };
}

type PanelProps = Parameters<typeof NetworkCallsignRelationsPanel>[0];

function renderPanel(relations?: NetworkCallsignRelationsRsp | null, overrides: Partial<PanelProps> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const props: PanelProps = {
    relations: relations ?? {
      nodes: [
        {
          id: 'ALPHA',
          label: 'ALPHA',
          weight: 3,
          relationCount: 1,
          activityCount: 3,
          position: null,
          unitName: null,
          knownCallsignId: null,
        },
        {
          id: 'BRAVO',
          label: 'BRAVO',
          weight: 2,
          relationCount: 1,
          activityCount: 2,
          position: null,
          unitName: null,
          knownCallsignId: null,
        },
      ],
      edges: [
        {
          id: 'ALPHA__BRAVO',
          source: 'ALPHA',
          target: 'BRAVO',
          weight: 20,
          byFreq: [
            { freq: '652.111', weight: 12 },
            { freq: '852.111', weight: 8 },
          ],
        },
      ],
      freqs: [
        { freq: '652.111', enabledByDefault: true },
        { freq: '852.111', enabledByDefault: true },
      ],
    },
    relationsLoaded: true,
    relationsLoading: false,
    relationsError: null,
    relationsSearch: 'alpha',
    relationsEnabledFreqs: ['652.111'],
    relationsMinIntensity: 12,
    relationsShowLabels: true,
    relationsSelectedNodeId: null,
    relationsSelectedEdgeId: null,
    relationsSince: '2026-04-20',
    relationsTill: '2026-05-20',
    onReload: vi.fn(),
    onSearchChange: vi.fn(),
    onEnabledFreqsChange: vi.fn(),
    onMinIntensityChange: vi.fn(),
    onShowLabelsChange: vi.fn(),
    onSelectNodeId: vi.fn(),
    onSelectEdgeId: vi.fn(),
    onRelationsSinceChange: vi.fn(),
    onRelationsTillChange: vi.fn(),
    ...overrides,
  };

  act(() => {
    root.render(<NetworkCallsignRelationsPanel {...(props as any)} />);
  });

  return { container, root, props };
}

describe('NetworkCallsignRelationsPanel', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('shows search clear and settings toggles', () => {
    const view = renderPanel();
    rendered.push(view);

    expect(view.container.querySelector('[aria-label="Очистити пошук"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Налаштування"]')).not.toBeNull();

    act(() => {
      view.container.querySelector<HTMLButtonElement>('[aria-label="Очистити пошук"]')?.click();
    });
    expect(view.props.onSearchChange).toHaveBeenCalledWith('');

    act(() => {
      view.container.querySelector<HTMLButtonElement>('[id$="-filters"]')?.click();
    });

    act(() => {
      const checkboxes = document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      checkboxes[1]?.click();
    });
    expect(view.props.onEnabledFreqsChange).toHaveBeenLastCalledWith([]);
  });

  it('keeps filter controls available when filters hide all graph data', () => {
    const view = renderPanel();
    rendered.push(view);

    act(() => {
      view.root.render(
        <NetworkCallsignRelationsPanel
          {...(view.props as any)}
          relationsMinIntensity={25}
          relationsEnabledFreqs={['652.111']}
        />,
      );
    });

    expect(view.container.textContent).toContain(EMPTY_STATE_NO_RESULTS_TEXT);
    expect(view.container.querySelector('[data-testid="clear-empty-filters"]')).not.toBeNull();
    expect(view.container.querySelector('[id$="-filters"]')).not.toBeNull();
  });

  it('shows the empty-state clear action when search is empty and graph filters hide all data', () => {
    const view = renderPanel(undefined, {
      relationsSearch: '',
      relationsMinIntensity: 25,
    });
    rendered.push(view);

    act(() => {
      view.root.render(
        <NetworkCallsignRelationsPanel
          {...(view.props as any)}
          relationsMinIntensity={25}
          relationsEnabledFreqs={['652.111']}
          relationsSearch=""
        />,
      );
    });

    expect(view.container.textContent).toContain(EMPTY_STATE_NO_RESULTS_TEXT);
    expect(view.container.querySelector('[data-testid="clear-empty-filters"]')).not.toBeNull();
  });

  it('clears search and graph filters from the empty-state action', () => {
    const view = renderPanel(createSparseRelationsWithDisabledDefaultFreq(), {
      relationsSearch: 'alpha',
      relationsMinIntensity: 25,
    });
    rendered.push(view);

    act(() => {
      view.root.render(
        <NetworkCallsignRelationsPanel
          {...(view.props as any)}
          relationsMinIntensity={25}
          relationsEnabledFreqs={['652.111']}
          relationsSearch="alpha"
        />,
      );
    });

    const clearButton = view.container.querySelector<HTMLButtonElement>('[data-testid="clear-empty-filters"]');
    expect(clearButton).not.toBeNull();

    act(() => {
      clearButton?.click();
    });

    expect(view.props.onSearchChange).toHaveBeenCalledWith('');
    expect(view.props.onEnabledFreqsChange).toHaveBeenCalledWith(['652.111']);
    expect(view.props.onMinIntensityChange).toHaveBeenCalledWith(NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY);
  });

  it('hides the empty-state clear action when empty data has no active graph filters', () => {
    const view = renderPanel(
      {
        nodes: [],
        edges: [],
        freqs: [],
      },
      {
        relationsSearch: '',
        relationsEnabledFreqs: [],
        relationsMinIntensity: NETWORK_RELATIONS_DEFAULT_MIN_INTENSITY,
      },
    );
    rendered.push(view);

    expect(view.container.textContent).toContain(EMPTY_STATE_NO_RESULTS_TEXT);
    expect(view.container.querySelector('[data-testid="clear-empty-filters"]')).toBeNull();
  });

  it('lets the user close an opened relation edge drill-down', () => {
    const view = renderPanel(undefined, {
      relationsSelectedEdgeId: 'ALPHA__BRAVO',
    });
    rendered.push(view);

    const closeButton = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.getAttribute('aria-label')?.startsWith('Закрити деталі зв'),
    );
    expect(closeButton).not.toBeNull();

    act(() => {
      closeButton?.click();
    });

    expect(view.props.onSelectEdgeId).toHaveBeenCalledWith(null);
  });

  it('shows the shared loading card before relations arrive', () => {
    const view = renderPanel();
    rendered.push(view);

    act(() => {
      view.root.render(
        <NetworkCallsignRelationsPanel
          {...(view.props as any)}
          relations={null}
          relationsLoaded={false}
          relationsLoading={true}
          relationsError={null}
        />,
      );
    });

    expect(view.container.textContent).toContain('Завантажуємо граф зв\'язків');
    expect(view.container.textContent).toContain('Граф зв\'язків');
  });

  it('shows a no-data card before relations arrive', () => {
    const view = renderPanel();
    rendered.push(view);

    act(() => {
      view.root.render(
        <NetworkCallsignRelationsPanel
          {...(view.props as any)}
          relations={null}
          relationsLoaded={true}
          relationsLoading={false}
          relationsError={null}
        />,
      );
    });

    expect(view.container.textContent).toContain('Немає графових даних');
    expect(view.container.textContent).toContain("Граф будується після першого зв'язку між позивними.");
    expect([...view.container.querySelectorAll('button')].some((button) => button.textContent?.includes('Оновити'))).toBe(true);
  });

  it('keeps the graph shell available when a successful response has no edges', () => {
    const view = renderPanel({
      nodes: [],
      edges: [],
      freqs: [],
    });
    rendered.push(view);

    expect(view.container.querySelector('[aria-label="Очистити пошук"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Налаштування"]')).not.toBeNull();
    expect(view.container.textContent).toContain(EMPTY_STATE_NO_RESULTS_TEXT);
  });

  it('keeps the graph shell available when relations contain nodes but no edges', () => {
    const view = renderPanel({
      nodes: [
        {
          id: 'ALPHA',
          label: 'ALPHA',
          weight: 1,
          relationCount: 0,
          activityCount: 1,
          position: null,
          unitName: null,
          knownCallsignId: null,
        },
      ],
      edges: [],
      freqs: [{ freq: '652.111', enabledByDefault: true }],
    });
    rendered.push(view);

    expect(view.container.querySelector('[aria-label="Очистити пошук"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Налаштування"]')).not.toBeNull();
    expect(view.container.textContent).toContain(EMPTY_STATE_NO_RESULTS_TEXT);
  });

  it('keeps the graph visible while refreshing relations', () => {
    const view = renderPanel();
    rendered.push(view);

    act(() => {
      view.root.render(
        <NetworkCallsignRelationsPanel
          {...(view.props as any)}
          relationsLoading={true}
        />,
      );
    });

    expect(view.container.textContent).toContain("Граф зв'язків");
    expect(view.container.textContent).toContain("Оновлюємо граф зв'язків");
    expect(view.container.textContent).not.toContain("Завантажуємо граф зв'язків");
  });

  it('shows the dense-graph warning while keeping graph controls visible', () => {
    const view = renderPanel(createDenseRelations(), {
      relationsSearch: 'node',
      relationsEnabledFreqs: ['652.111'],
      relationsMinIntensity: 1,
    });
    rendered.push(view);

    expect(view.container.textContent).toContain("Забагато зв'язків для відображення");
    expect(view.container.textContent).toContain('Збільшіть інтенсивність, звузьте період або вимкніть частоти.');
    expect(view.container.querySelector('[aria-label="Очистити пошук"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Налаштування"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="date-picker-Від"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="date-picker-До"]')).not.toBeNull();
  });

  it('hides labels in dense mode and disables the switch', () => {
    const view = renderPanel(createDenseUiRelations(), {
      relationsSearch: 'node',
      relationsEnabledFreqs: ['652.111'],
      relationsMinIntensity: 1,
      relationsShowLabels: true,
    });
    rendered.push(view);

    expect(view.container.querySelector('input[type="checkbox"][disabled]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Пояснення про підписи"]')).not.toBeNull();
  });

  it('turns off labels when dense mode hides them', () => {
    const view = renderPanel(createDenseRelations(), {
      relationsSearch: 'node',
      relationsEnabledFreqs: ['652.111'],
      relationsMinIntensity: 1,
      relationsShowLabels: true,
    });
    rendered.push(view);

    expect(view.props.onShowLabelsChange).toHaveBeenCalledWith(false);
  });

  it('restores labels after dense mode clears', () => {
    const view = renderPanel(createDenseUiRelations(), {
      relationsSearch: 'node',
      relationsEnabledFreqs: ['652.111'],
      relationsMinIntensity: 1,
      relationsShowLabels: true,
    });
    rendered.push(view);

    act(() => {
      view.root.render(
        <NetworkCallsignRelationsPanel
          {...(view.props as any)}
          relations={createSparseRelations()}
          relationsSearch=""
          relationsMinIntensity={12}
          relationsShowLabels={false}
        />,
      );
    });

    expect(view.props.onShowLabelsChange).toHaveBeenLastCalledWith(true);
  });
});
