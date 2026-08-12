/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

let latestCountProps: Record<string, unknown> | null = null;
let latestFrequencySearchProps: Record<string, unknown> | null = null;

vi.mock('./AnalysisCountBlock', () => ({
  AnalysisCountBlock: (props: Record<string, unknown>) => {
    latestCountProps = props;
    return <div>callsigns-navigation</div>;
  },
}));

vi.mock('./AnalysisCallsignFrequencySearch', () => ({
  AnalysisCallsignFrequencySearch: (props: Record<string, unknown>) => {
    latestFrequencySearchProps = props;
    return <div>callsign-frequency-search</div>;
  },
}));

import { AnalysisCallsignsPane } from './AnalysisCallsignsPane';

describe('AnalysisCallsignsPane', () => {
  it('renders callsign navigation with filter actions', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onAddCallsign = vi.fn();
    const onAddFreq = vi.fn();
    const onClearCallsign = vi.fn();
    const onSearchFrequencyMatches = vi.fn();
    const onToggleCallsign = vi.fn();
    const onToggleFreq = vi.fn();

    act(() => {
      root.render(
        <AnalysisCallsignsPane
          callsignOptions={[]}
          loading={false}
          onClearCallsign={onClearCallsign}
          onAddFreq={onAddFreq}
          selectedCallsigns={['ALPHA']}
          selectedFreqs={[]}
          topCallsigns={[{ key: 'ALPHA', count: 2 }]}
          onAddCallsign={onAddCallsign}
          onSearchFrequencyMatches={onSearchFrequencyMatches}
          onToggleCallsign={onToggleCallsign}
          onToggleFreq={onToggleFreq}
        />,
      );
    });

    expect(latestCountProps).toMatchObject({
      title: 'Позивні',
      items: [{ key: 'ALPHA', count: 2 }],
      selectedItemKeys: ['ALPHA'],
      onItemAdd: onAddCallsign,
      onItemToggle: onToggleCallsign,
      onClearSelection: onClearCallsign,
    });
    expect(latestFrequencySearchProps).toMatchObject({
      callsignOptions: [],
      selectedFreqs: [],
      onAddFreq,
      onSearch: onSearchFrequencyMatches,
      onToggleFreq,
    });

    act(() => root.unmount());
  });
});
