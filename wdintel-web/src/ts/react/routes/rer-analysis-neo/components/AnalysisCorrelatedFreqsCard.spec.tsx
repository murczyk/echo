/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { AnalysisCorrelatedFreqsCard } from './AnalysisCorrelatedFreqsCard';

describe('AnalysisCorrelatedFreqsCard', () => {
  it('waits for an explicit load when a frequency is selected', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onLoad = vi.fn();

    act(() => {
      root.render(
        <AnalysisCorrelatedFreqsCard
          correlatedFreqs={[]}
          loaded={false}
          loading={false}
          onLoad={onLoad}
          selectedFreq="148.7000"
        />,
      );
    });

    expect(onLoad).not.toHaveBeenCalled();
    const loadButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Завантажити',
    );
    expect(loadButton).toBeTruthy();

    act(() => loadButton?.click());
    expect(onLoad).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });
});
