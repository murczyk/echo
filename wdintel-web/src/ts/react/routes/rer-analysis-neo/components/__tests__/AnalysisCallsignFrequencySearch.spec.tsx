/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchAnalysisCallsignPage: vi.fn() }));

vi.mock('../../../../services/api/analysis', () => api);

vi.mock('../../../../components/SearchableMultiOptionAutocomplete', () => ({
  SearchableMultiOptionAutocomplete: ({
    onInputChange,
    onValueIdsChange,
    options,
  }: {
    onInputChange?: (value: string) => void;
    onValueIdsChange: (ids: number[]) => void;
    options: Array<{ id: number }>;
  }) => (
    <>
      <button type="button" onClick={() => onValueIdsChange(options.map((option) => option.id))}>
        Обрати позивні
      </button>
      <button
        type="button"
        onClick={() => onValueIdsChange(options.slice(0, 2).map((option) => option.id))}
      >
        Обрати перші два
      </button>
      <button type="button" onClick={() => onInputChange?.('КОМЕТА')}>
        Шукати КОМЕТА
      </button>
    </>
  ),
}));

import { AnalysisCallsignFrequencySearch } from '../AnalysisCallsignFrequencySearch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const callsignOptions = [
  { value: 'ALPHA', label: 'ALPHA', count: 4 },
  { value: 'BRAVO', label: 'BRAVO', count: 3 },
  { value: 'CHARLIE', label: 'CHARLIE', count: 2 },
];

function open(container: HTMLElement) {
  container.querySelector<HTMLButtonElement>('[aria-label="Розгорнути Пошук частот"]')?.click();
}

function select(container: HTMLElement, selection = 'Обрати позивні') {
  Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent === selection)
    ?.click();
}

function find(container: HTMLElement) {
  Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent?.includes('Знайти'))
    ?.click();
}

describe('AnalysisCallsignFrequencySearch', () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
  });
  it('searches with two matches by default and renders selectable frequency cards', async () => {
    const container = document.createElement('div');
    root = createRoot(container);
    const onSearch = vi.fn().mockResolvedValue({
      frequencies: [
        { freq: '123.45', callsigns: ['ALPHA', 'BRAVO'], messageCount: 7 },
        { freq: '456.78', callsigns: ['ALPHA', 'BRAVO'], messageCount: 3 },
      ],
    });
    const onAddFreq = vi.fn();
    const onToggleFreq = vi.fn();

    await act(async () => {
      root?.render(
        <AnalysisCallsignFrequencySearch
          callsignOptions={[
            { value: 'ALPHA', label: 'ALPHA', count: 4 },
            { value: 'BRAVO', label: 'BRAVO', count: 3 },
          ]}
          onAddFreq={onAddFreq}
          onSearch={onSearch}
          onToggleFreq={onToggleFreq}
          selectedFreqs={[]}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Розгорнути Пошук частот"]')?.click();
    });

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Обрати позивні')
        ?.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Знайти'))
        ?.click();
    });

    expect(onSearch).toHaveBeenCalledWith(['alpha', 'bravo'], 2, expect.any(AbortSignal));
    expect(container.textContent).toContain('123.45');
    expect(container.textContent).toContain('Повідомлень: 7');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Вибрати лише 123.45"]')?.click();
    });
    expect(onToggleFreq).toHaveBeenCalledWith('123.45');

    const updatedOnSearch = vi.fn().mockResolvedValue({ frequencies: [] });
    await act(async () => {
      root?.render(
        <AnalysisCallsignFrequencySearch
          callsignOptions={[
            { value: 'ALPHA', label: 'ALPHA', count: 4 },
            { value: 'BRAVO', label: 'BRAVO', count: 3 },
          ]}
          onAddFreq={onAddFreq}
          onSearch={updatedOnSearch}
          onToggleFreq={onToggleFreq}
          selectedFreqs={['123.45']}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Розгорнути Пошук частот"]')?.click();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Додати 456.78 до поточного фільтра"]')
        ?.click();
    });
    expect(onAddFreq).toHaveBeenCalledWith('456.78');
  });
  it('searches with the original callsign values behind uppercase labels', async () => {
    const container = document.createElement('div');
    root = createRoot(container);
    const onSearch = vi.fn().mockResolvedValue({ frequencies: [] });

    await act(async () => {
      root?.render(
        <AnalysisCallsignFrequencySearch
          callsignOptions={[
            { value: 'КОМЕТА', label: 'КОМЕТА', count: 4, values: ['комета'] },
            { value: 'КОТ', label: 'КОТ', count: 3, values: ['кот'] },
          ]}
          onAddFreq={vi.fn()}
          onSearch={onSearch}
          onToggleFreq={vi.fn()}
          selectedFreqs={[]}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Розгорнути Пошук частот"]')?.click();
    });

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Обрати позивні')
        ?.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Знайти'))
        ?.click();
    });

    expect(onSearch).toHaveBeenCalledWith(['комета', 'кот'], 2, expect.any(AbortSignal));
  });

  it('uses its own full-scope server suggestions when searching callsigns', async () => {
    vi.useFakeTimers();
    api.fetchAnalysisCallsignPage.mockReset();
    api.fetchAnalysisCallsignPage.mockResolvedValue({
      entries: [{ value: 'комета', label: 'КОМЕТА', values: ['Комета', 'комета'], count: 2 }],
      hasMore: false,
      nextCursor: null,
    });
    const container = document.createElement('div');
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <AnalysisCallsignFrequencySearch
          analysisReq={{} as never}
          onAddFreq={vi.fn()}
          onSearch={vi.fn().mockResolvedValue({ frequencies: [] })}
          onToggleFreq={vi.fn()}
          selectedFreqs={[]}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Розгорнути Пошук частот"]')?.click();
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(api.fetchAnalysisCallsignPage).toHaveBeenCalledTimes(1);
    api.fetchAnalysisCallsignPage.mockClear();

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Шукати КОМЕТА')
        ?.click();
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));

    expect(api.fetchAnalysisCallsignPage).toHaveBeenCalledTimes(1);
    expect(api.fetchAnalysisCallsignPage.mock.calls[0]?.[0]).toMatchObject({
      query: 'КОМЕТА',
      cursor: null,
      pageSize: 50,
      order: 'match_then_name',
    });
  });

  it('rejects a response when minimum matches changes during a request', async () => {
    const pending = deferred<{
      frequencies: Array<{ freq: string; callsigns: string[]; messageCount: number }>;
    }>();
    const container = document.createElement('div');
    root = createRoot(container);
    const onSearch = vi.fn().mockReturnValue(pending.promise);

    await act(async () => {
      root?.render(
        <AnalysisCallsignFrequencySearch
          callsignOptions={callsignOptions}
          onAddFreq={vi.fn()}
          onSearch={onSearch}
          onToggleFreq={vi.fn()}
          selectedFreqs={[]}
        />,
      );
    });
    await act(async () => open(container));
    await act(async () => select(container));
    await act(async () => find(container));
    expect(onSearch).toHaveBeenCalledTimes(1);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Збільшити мінімум збігів"]')
        ?.click();
    });
    expect(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Знайти'),
      )?.disabled,
    ).toBe(false);

    await act(async () => {
      pending.resolve({
        frequencies: [{ freq: '100.00', callsigns: ['ALPHA', 'BRAVO'], messageCount: 1 }],
      });
    });
    expect(container.textContent).not.toContain('100.00');
  });

  it('invalidates pending and completed results when the selection or analysis scope changes', async () => {
    const pending = deferred<{
      frequencies: Array<{ freq: string; callsigns: string[]; messageCount: number }>;
    }>();
    const firstScope = { fromDateTime: '2026-08-07T00:00:00Z' } as never;
    const secondScope = { fromDateTime: '2026-08-08T00:00:00Z' } as never;
    const container = document.createElement('div');
    root = createRoot(container);
    const onSearch = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        frequencies: [{ freq: '200.00', callsigns: ['ALPHA', 'BRAVO'], messageCount: 2 }],
      });
    const render = (analysisReq: never) => (
      <AnalysisCallsignFrequencySearch
        analysisReq={analysisReq}
        callsignOptions={callsignOptions}
        onAddFreq={vi.fn()}
        onSearch={onSearch}
        onToggleFreq={vi.fn()}
        selectedFreqs={[]}
      />
    );

    await act(async () => root?.render(render(firstScope)));
    await act(async () => open(container));
    await act(async () => select(container, 'Обрати перші два'));
    await act(async () => find(container));
    await act(async () => select(container, 'Обрати позивні'));
    await act(async () => {
      pending.resolve({
        frequencies: [{ freq: '100.00', callsigns: ['ALPHA', 'BRAVO'], messageCount: 1 }],
      });
    });
    expect(container.textContent).not.toContain('100.00');

    await act(async () => find(container));
    expect(container.textContent).toContain('200.00');
    await act(async () => root?.render(render(secondScope)));
    expect(container.textContent).not.toContain('200.00');
  });

  it('keeps only the newest overlapping request and retains results across equivalent rerenders', async () => {
    const first = deferred<{
      frequencies: Array<{ freq: string; callsigns: string[]; messageCount: number }>;
    }>();
    const second = deferred<{
      frequencies: Array<{ freq: string; callsigns: string[]; messageCount: number }>;
    }>();
    const container = document.createElement('div');
    root = createRoot(container);
    const onSearch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const analysisReq = { fromDateTime: '2026-08-07T00:00:00Z' } as never;
    const render = (request = analysisReq) => (
      <AnalysisCallsignFrequencySearch
        analysisReq={request}
        callsignOptions={callsignOptions}
        onAddFreq={vi.fn()}
        onSearch={onSearch}
        onToggleFreq={vi.fn()}
        selectedFreqs={[]}
      />
    );

    await act(async () => root?.render(render()));
    await act(async () => open(container));
    await act(async () => select(container));
    await act(async () => find(container));
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Збільшити мінімум збігів"]')
        ?.click();
    });
    await act(async () => {
      find(container);
    });
    await act(async () => {
      second.resolve({
        frequencies: [{ freq: '300.00', callsigns: ['ALPHA', 'BRAVO'], messageCount: 3 }],
      });
    });
    await act(async () => {
      first.resolve({
        frequencies: [{ freq: '100.00', callsigns: ['ALPHA', 'BRAVO'], messageCount: 1 }],
      });
    });
    expect(container.textContent).toContain('300.00');
    expect(container.textContent).not.toContain('100.00');

    await act(async () => root?.render(render({ fromDateTime: '2026-08-07T00:00:00Z' } as never)));
    expect(container.textContent).toContain('300.00');
  });

  it('invalidates a pending request when unmounted', async () => {
    const pending = deferred<{
      frequencies: Array<{ freq: string; callsigns: string[]; messageCount: number }>;
    }>();
    const container = document.createElement('div');
    root = createRoot(container);
    const onSearch = vi.fn().mockReturnValue(pending.promise);

    await act(async () => {
      root?.render(
        <AnalysisCallsignFrequencySearch
          callsignOptions={callsignOptions}
          onAddFreq={vi.fn()}
          onSearch={onSearch}
          onToggleFreq={vi.fn()}
          selectedFreqs={[]}
        />,
      );
    });
    await act(async () => open(container));
    await act(async () => select(container, 'Обрати перші два'));
    await act(async () => find(container));
    const signal = onSearch.mock.calls[0]?.[2] as AbortSignal;
    await act(async () => root?.unmount());
    root = null;
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve({
        frequencies: [{ freq: '100.00', callsigns: ['ALPHA', 'BRAVO'], messageCount: 1 }],
      });
    });
  });
});
