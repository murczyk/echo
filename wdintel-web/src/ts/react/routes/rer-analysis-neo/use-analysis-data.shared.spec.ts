import { describe, expect, it } from 'vitest';

import { ANALYSIS_INBOX_PAGE_LIMIT, isAnalysisInboxPageExhausted } from './use-analysis-data.shared';

describe('isAnalysisInboxPageExhausted', () => {
  it('treats analysis inbox pages shorter than the backend page limit as exhausted', () => {
    expect(ANALYSIS_INBOX_PAGE_LIMIT).toBe(20);
    expect(isAnalysisInboxPageExhausted([])).toBe(true);
    expect(isAnalysisInboxPageExhausted(Array.from({ length: ANALYSIS_INBOX_PAGE_LIMIT - 1 }, (_, index) => [index, {}]))).toBe(true);
    expect(isAnalysisInboxPageExhausted(Array.from({ length: ANALYSIS_INBOX_PAGE_LIMIT }, (_, index) => [index, {}]))).toBe(false);
  });
});
