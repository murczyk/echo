import { describe, expect, it } from 'vitest';

import {
  analysisLoadingSkeletonPaperSx,
  analysisLoadingSkeletonTabsSx,
  getAnalysisLoadingSkeletonCount,
} from './AnalysisLoadingSkeletons';

describe('AnalysisLoadingSkeletons', () => {
  it('limits narrow loading cards and keeps one horizontal tab row', () => {
    expect(getAnalysisLoadingSkeletonCount(375)).toBe(2);
    expect(getAnalysisLoadingSkeletonCount(768)).toBe(3);
    expect(analysisLoadingSkeletonTabsSx.flexWrap).toBe('nowrap');
    expect(analysisLoadingSkeletonTabsSx.overflow).toBe('hidden');
  });

  it('uses an external narrow gutter without changing desktop margin', () => {
    expect(analysisLoadingSkeletonPaperSx.mx).toEqual({ xs: 1, lg: 0 });
    expect(analysisLoadingSkeletonPaperSx.width).toBe('auto');
  });
});
