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
      <button type="button" onClick={() => onInputChange?.('КОМЕТА')}>
        Шукати КОМЕТА
      </button>
    </>
  ),
}));

import { AnalysisCallsignFrequencySearch } from '../AnalysisCallsignFrequencySearch';

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
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Обрати позивні')
        ?.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Знайти'))
        ?.click();
    });

    expect(onSearch).toHaveBeenCalledWith(['alpha', 'bravo'], 2);
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
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Обрати позивні')
        ?.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Знайти'))
        ?.click();
    });

    expect(onSearch).toHaveBeenCalledWith(['комета', 'кот'], 2);
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
    await act(async () => vi.advanceTimersByTimeAsync(250));
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
});
