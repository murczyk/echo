import { describe, expect, it } from 'vitest';

import {
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
});
