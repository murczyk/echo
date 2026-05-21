/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./NetworkDatePickerField', () => ({
  NetworkDatePickerField: ({ label }: { label: string }) => <div data-testid={`date-picker-${label}`} />,
}));

import { NetworkCallsignRelationsPanel } from './NetworkCallsignRelationsPanel';
import { EMPTY_STATE_NO_RESULTS_TEXT } from '../../shared/empty-state-text';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function renderPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const props = {
    relations: {
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
            { freq: '652.111', weight: 12, messageIds: [1, 2] },
            { freq: '852.111', weight: 8, messageIds: [3] },
          ],
          messagesPreview: [
            { id: 1, timestamp: 1, freq: '652.111', text: 'alpha bravo', callsigns: ['ALPHA', 'BRAVO'] },
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
  } as const;

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
});
