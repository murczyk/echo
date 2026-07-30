/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

let countBlockProps: Record<string, unknown> | null = null;

vi.mock('./AnalysisCountBlock', () => ({
  AnalysisCountBlock: (props: Record<string, unknown>) => {
    countBlockProps = props;
    return <div>frequency-cards</div>;
  },
}));

vi.mock('./AnalysisCorrelatedFreqsCard', () => ({
  AnalysisCorrelatedFreqsCard: ({ selectedFreq }: { selectedFreq: string | null }) => (
    <div>
      {selectedFreq
        ? 'correlated-frequencies'
        : 'Оберіть частоту, щоб завантажити суміжні частоти.'}
    </div>
  ),
}));

vi.mock('./AnalysisGroupsActivityCard', () => ({
  AnalysisGroupsActivityCard: () => <div>frequency-activity</div>,
}));

import { AnalysisFrequenciesPane } from './AnalysisFrequenciesPane';

describe('AnalysisFrequenciesPane', () => {
  it('renders selectable frequency cards before the empty-selection prompt', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onAddFreq = vi.fn();
    const onToggleFreq = vi.fn();

    act(() => {
      root.render(
        <AnalysisFrequenciesPane
          correlatedFreqs={[]}
          correlatedFreqsLoaded={false}
          correlatedFreqsLoading={false}
          groupsActivity={null}
          groupsActivityLoadedFreq={null}
          groupsActivityLoadedPeriod={null}
          groupsActivityLoading={false}
          groupsActivityPeriod="selected"
          onAddFreq={onAddFreq}
          onLoadCorrelatedFreqs={vi.fn()}
          onLoadGroupsActivity={vi.fn()}
          onToggleFreq={onToggleFreq}
          selectedFreq={null}
          selectedFreqs={['123.45']}
          topFreqs={[{ key: '123.45', count: 7 }]}
        />,
      );
    });

    expect(container.textContent?.indexOf('frequency-cards')).toBeLessThan(
      container.textContent?.indexOf('Оберіть частоту') ?? 0,
    );
    expect(countBlockProps).toMatchObject({
      title: 'Частоти',
      items: [{ key: '123.45', count: 7 }],
      selectedItemKeys: ['123.45'],
      onItemAdd: onAddFreq,
      onItemToggle: onToggleFreq,
    });

    act(() => root.unmount());
  });
});
