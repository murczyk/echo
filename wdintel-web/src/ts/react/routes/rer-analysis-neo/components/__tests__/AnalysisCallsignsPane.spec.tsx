/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const callsignPage = vi.hoisted(() => ({
  value: {
    canRetry: false,
    entries: [],
    error: null,
    hasMore: false,
    hasPrevious: false,
    loadFirstPage: vi.fn(),
    loadNextPage: vi.fn(),
    loadPreviousPage: vi.fn(),
    loading: false,
    pageIndex: 0,
    query: '',
    retry: vi.fn(),
    setQuery: vi.fn(),
  },
}));

vi.mock('../../shared/RadioFeatures', () => ({ useRadioFeatures: () => false }));
vi.mock('../../use-callsign-page', () => ({ useCallsignPage: () => callsignPage.value }));

import { AnalysisCallsignsPane } from '../AnalysisCallsignsPane';

describe('AnalysisCallsignsPane', () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  it('retains normalized selected groups outside the current page and removes one group only', async () => {
    callsignPage.value = {
      ...callsignPage.value,
      entries: [
        { value: 'Alpha', label: 'ALPHA', values: ['Alpha', 'alpha'], count: 2 },
        { value: 'Bravo', label: 'BRAVO', values: ['Bravo'], count: 1 },
      ],
    };
    const container = document.createElement('div');
    root = createRoot(container);
    const onAddCallsign = vi.fn();
    const onRemoveCallsign = vi.fn();
    const props = {
      analysisReq: null,
      onAddCallsign,
      onAddFreq: vi.fn(),
      onClearCallsign: vi.fn(),
      onRemoveCallsign,
      onSearchFrequencyMatches: vi.fn(),
      onToggleCallsign: vi.fn(),
      onToggleFreq: vi.fn(),
      selectedCallsigns: ['alpha'],
      selectedFreqs: [],
    };
    await act(async () => root?.render(<AnalysisCallsignsPane {...props} />));

    const alphaRow = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'ALPHA2',
    );
    expect(alphaRow?.className).toContain('MuiButton-colorPrimary');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Додати BRAVO"]')?.click();
    });
    expect(onAddCallsign).toHaveBeenCalledWith(['Bravo']);

    await act(async () =>
      root?.render(<AnalysisCallsignsPane {...props} selectedCallsigns={['alpha', 'bravo']} />),
    );
    expect(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'ALPHA2',
      )?.className,
    ).toContain('MuiButton-colorPrimary');

    callsignPage.value = { ...callsignPage.value, entries: [] };
    await act(async () =>
      root?.render(<AnalysisCallsignsPane {...props} selectedCallsigns={['alpha', 'bravo']} />),
    );
    expect(container.textContent).toContain('ALPHA');
    expect(container.textContent).toContain('BRAVO');

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'ALPHA ×')
        ?.click();
    });
    expect(onRemoveCallsign).toHaveBeenCalledWith(['Alpha', 'alpha']);
  });

  it('keeps first-page navigation available at the oldest retained history boundary', async () => {
    const loadFirstPage = vi.fn();
    callsignPage.value = {
      ...callsignPage.value,
      hasPrevious: false,
      loadFirstPage,
      pageIndex: 6,
    };
    const container = document.createElement('div');
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <AnalysisCallsignsPane
          analysisReq={null}
          onAddCallsign={vi.fn()}
          onAddFreq={vi.fn()}
          onClearCallsign={vi.fn()}
          onRemoveCallsign={vi.fn()}
          onSearchFrequencyMatches={vi.fn()}
          onToggleCallsign={vi.fn()}
          onToggleFreq={vi.fn()}
          selectedCallsigns={[]}
          selectedFreqs={[]}
        />,
      ),
    );

    const firstPage = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Перша',
    );
    expect(firstPage?.disabled).toBe(false);

    await act(async () => firstPage?.click());
    expect(loadFirstPage).toHaveBeenCalledOnce();
  });
});
