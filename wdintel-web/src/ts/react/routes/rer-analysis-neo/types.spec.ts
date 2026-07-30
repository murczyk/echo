import { describe, expect, it } from 'vitest';

import { getAnalysisCenterTabs, getAnalysisSidebarTabs } from './types';

describe('rer-analysis-neo tabs', () => {
  it('keeps the summary tab in the center panel order', () => {
    expect(getAnalysisCenterTabs(false)).toEqual(['messages', 'map', 'summary']);
    expect(getAnalysisCenterTabs(true)).toEqual(['messages', 'summary']);
  });

  it('keeps the sidebar free of the summary tab', () => {
    expect(getAnalysisSidebarTabs(false)).toEqual([
      'stats',
      'frequencies',
      'callsigns',
      'graph',
      'newCallsigns',
    ]);
    expect(getAnalysisSidebarTabs(true)).toEqual([
      'map',
      'stats',
      'frequencies',
      'callsigns',
      'graph',
      'newCallsigns',
    ]);
  });
});
