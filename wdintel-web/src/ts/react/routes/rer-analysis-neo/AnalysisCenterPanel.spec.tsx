import { describe, expect, it } from 'vitest';

import { ANALYSIS_TAB_FONT_SIZE, analysisNewestFirstLabelSx } from './analysis-tab-styles';

describe('AnalysisCenterPanel navigation typography', () => {
  it('uses the shared readable tab typography for the newest-first control', () => {
    expect(ANALYSIS_TAB_FONT_SIZE).toBe('0.875rem');
    expect(analysisNewestFirstLabelSx.width).toBe('auto');
    expect(analysisNewestFirstLabelSx.flexShrink).toBe(0);
    expect(analysisNewestFirstLabelSx['& .MuiFormControlLabel-label']).toMatchObject({
      fontSize: '0.875rem',
      fontWeight: 500,
      lineHeight: 1.2,
    });
    expect(analysisNewestFirstLabelSx['& .MuiFormControlLabel-label'].fontSize).not.toBe(11.5);
  });
});
