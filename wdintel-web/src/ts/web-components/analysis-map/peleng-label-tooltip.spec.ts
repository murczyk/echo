import { describe, expect, it } from 'vitest';

import { buildPelengLabelTooltipHtml } from './peleng-label-tooltip';

describe('buildPelengLabelTooltipHtml', () => {
  it('renders a single point as escaped plain text', () => {
    const html = buildPelengLabelTooltipHtml({
      displayKind: 'single-point',
      displayLabel: '147.4750 <live>',
      pointsCount: 1,
      knownFreqCount: 1,
      uniqueFreqs: ['147.4750 <live>'],
    });

    expect(html).toBe('147.4750 &lt;live&gt;');
  });

  it('renders a same-frequency cluster with the antenna svg and frequency text', () => {
    const html = buildPelengLabelTooltipHtml({
      displayKind: 'single-freq-cluster',
      displayLabel: '2 (147.4750)',
      pointsCount: 2,
      knownFreqCount: 1,
      uniqueFreqs: ['147.4750'],
    });

    expect(html).toContain('2 (');
    expect(html).toContain('peleng-point-label__freq-icon');
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('147.4750');
  });

  it('renders a multi-frequency cluster with the antenna svg and known-frequency count', () => {
    const html = buildPelengLabelTooltipHtml({
      displayKind: 'multi-freq-cluster',
      displayLabel: '3 (2 частоти)',
      pointsCount: 3,
      knownFreqCount: 2,
      uniqueFreqs: ['147.4750', '148.2000'],
    });

    expect(html).toContain('3 (');
    expect(html).toContain('peleng-point-label__freq-icon');
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('2)');
  });

  it('returns null for unknown-only groups', () => {
    const html = buildPelengLabelTooltipHtml({
      displayKind: null,
      displayLabel: null,
      pointsCount: 2,
      knownFreqCount: 0,
      uniqueFreqs: [],
    });

    expect(html).toBeNull();
  });
});
