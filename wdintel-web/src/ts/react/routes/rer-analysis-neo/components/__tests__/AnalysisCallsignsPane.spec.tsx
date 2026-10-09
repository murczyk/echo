/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const callsignPage = vi.hoisted(() => ({
  onError: undefined as ((error: unknown) => void) | undefined,
  value: {
    canRetry: false,
    entries: [],
    error: null,
    hasMore: false,
    hasLoadedOnce: true,
    hasPrevious: false,
    loadFirstPage: vi.fn(),
    loadNextPage: vi.fn(),
    loadPreviousPage: vi.fn(),
    loading: false,
    pending: false,
    pageIndex: 0,
    query: '',
    retry: vi.fn(),
    setQuery: vi.fn(),
    snapshotEntries: [],
    snapshotPageIndex: null,
    stale: false,
  },
}));
const snackbar = vi.hoisted(() => ({ notify: vi.fn() }));

vi.mock('../../shared/RadioFeatures', () => ({ useRadioFeatures: () => false }));
vi.mock('../../use-callsign-page', () => ({
  useCallsignPage: ({ onError }: { onError: (error: unknown) => void }) => {
    callsignPage.onError = onError;
    return callsignPage.value;
  },
}));
vi.mock('../../../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => snackbar,
}));

import { AnalysisCallsignsPane } from '../AnalysisCallsignsPane';

describe('AnalysisCallsignsPane', () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    snackbar.notify.mockReset();
  });

  it('forwards callsign loading failures to the snackbar once', async () => {
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

    act(() => callsignPage.onError?.(new Error('callsign load failed')));
    expect(snackbar.notify).toHaveBeenCalledTimes(1);
    expect(snackbar.notify).toHaveBeenCalledWith({
      severity: 'error',
      message: 'callsign load failed',
    });
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
      (button) => button.getAttribute('aria-label') === 'ALPHA 2 повідомлень',
    );
    expect(alphaRow?.getAttribute('data-selected')).toBe('true');

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.getAttribute('aria-label')?.startsWith('Додати BRAVO'))
        ?.click();
    });
    expect(onAddCallsign).toHaveBeenCalledWith(['Bravo']);

    await act(async () =>
      root?.render(<AnalysisCallsignsPane {...props} selectedCallsigns={['alpha', 'bravo']} />),
    );
    expect(
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.getAttribute('aria-label') === 'ALPHA 2 повідомлень')
        ?.getAttribute('data-selected'),
    ).toBe('true');

    callsignPage.value = { ...callsignPage.value, entries: [] };
    await act(async () =>
      root?.render(<AnalysisCallsignsPane {...props} selectedCallsigns={['alpha', 'bravo']} />),
    );
    expect(container.textContent).toContain('ALPHA');
    expect(container.textContent).toContain('BRAVO');

    await act(async () => {
      container
        .querySelector('.MuiChip-deleteIcon')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRemoveCallsign).toHaveBeenCalledWith(['Alpha', 'alpha']);
  });

  it('keeps first-page navigation available at the oldest retained history boundary', async () => {
    const loadFirstPage = vi.fn();
    callsignPage.value = {
      ...callsignPage.value,
      canRetry: true,
      entries: [{ value: 'Alpha', label: 'ALPHA', values: ['Alpha'], count: 1 }],
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

    const firstPage = container.querySelector<HTMLButtonElement>(
      '[aria-label="Перша сторінка позивних"]',
    );
    expect(firstPage?.disabled).toBe(false);

    await act(async () => firstPage?.click());
    expect(loadFirstPage).toHaveBeenCalledOnce();
  });

  it('keeps current rows visible but disables their actions while a page changes', async () => {
    const loadFirstPage = vi.fn();
    const loadNextPage = vi.fn();
    callsignPage.value = {
      ...callsignPage.value,
      entries: [{ value: 'Alpha', label: 'ALPHA', values: ['Alpha'], count: 2 }],
      hasMore: true,
      loadFirstPage,
      loadNextPage,
      loading: true,
      pending: true,
      pageIndex: 1,
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

    expect(container.textContent).toContain('ALPHA');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Оновлення позивних"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Завантаження позивних"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
        button.getAttribute('aria-label')?.startsWith('Додати ALPHA'),
      )?.disabled,
    ).toBe(true);
    const firstPage = container.querySelector<HTMLButtonElement>(
      '[aria-label="Перша сторінка позивних"]',
    );
    const nextPage = container.querySelector<HTMLButtonElement>(
      '[aria-label="Наступна сторінка позивних"]',
    );
    expect(firstPage?.disabled).toBe(true);
    expect(nextPage?.disabled).toBe(true);
    await act(async () => {
      firstPage?.click();
      nextPage?.click();
    });
    expect(loadFirstPage).not.toHaveBeenCalled();
    expect(loadNextPage).not.toHaveBeenCalled();
  });

  it('stops loading after a failed scope refresh while keeping its snapshot noninteractive', async () => {
    callsignPage.value = {
      ...callsignPage.value,
      canRetry: true,
      entries: [],
      error: new Error('refresh failed'),
      hasMore: false,
      pending: false,
      snapshotEntries: [{ value: 'Bravo', label: 'BRAVO', values: ['Bravo'], count: 1 }],
      snapshotPageIndex: 1,
      stale: true,
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

    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.querySelector('[aria-label="Оновлення позивних"]')).toBeNull();
    expect(container.textContent).toContain('Показано результати попереднього запиту.');
    expect(container.textContent).toContain('51–51 позивних');
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Повторити',
      )?.disabled,
    ).toBe(false);
    expect(
      container.querySelector('[aria-label="BRAVO 1 повідомлень"]')?.getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('does not leave an enabled add action for a fully selected callsign group', async () => {
    callsignPage.value = {
      ...callsignPage.value,
      entries: [{ value: 'Alpha', label: 'ALPHA', values: ['Alpha', 'alpha'], count: 2 }],
      pending: false,
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
          selectedCallsigns={['alpha']}
          selectedFreqs={[]}
        />,
      ),
    );

    expect(container.querySelector('[aria-label="Додати ALPHA до поточного фільтра"]')).toBeNull();
  });

  it('keeps a completed empty result out of the initial skeleton state', async () => {
    callsignPage.value = {
      ...callsignPage.value,
      entries: [],
      error: null,
      hasLoadedOnce: true,
      pending: false,
      snapshotEntries: [],
      snapshotPageIndex: null,
      stale: false,
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

    expect(container.querySelector('[aria-label="Завантаження позивних"]')).toBeNull();
    expect(container.textContent).toContain('У поточній області аналізу немає позивних.');
  });

  it('shows results-region progress for a refresh after an empty result', async () => {
    callsignPage.value = {
      ...callsignPage.value,
      entries: [],
      error: null,
      hasLoadedOnce: true,
      pending: true,
      snapshotEntries: [],
      snapshotPageIndex: null,
      stale: false,
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

    expect(container.querySelector('[aria-label="Завантаження позивних"]')).toBeNull();
    expect(container.querySelector('.MuiCircularProgress-root')).not.toBeNull();
    expect(container.querySelector('[aria-label="Наступна сторінка позивних"]')).toBeNull();
  });

  it('uses the actual entries to display a cursor-page range', async () => {
    callsignPage.value = {
      ...callsignPage.value,
      entries: [{ value: 'Bravo', label: 'BRAVO', values: ['Bravo'], count: 1 }],
      loading: false,
      pageIndex: 1,
      pending: false,
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
    expect(container.textContent).toContain('51–51 позивних');
  });

  it('clears the server callsign search from its trailing control', async () => {
    const setQuery = vi.fn();
    callsignPage.value = { ...callsignPage.value, loading: false, query: 'ALPHA', setQuery };
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

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Очистити пошук позивного"]')
        ?.click(),
    );
    expect(setQuery).toHaveBeenCalledWith('');
  });
});
