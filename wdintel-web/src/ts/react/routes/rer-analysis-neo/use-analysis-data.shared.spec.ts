import { describe, expect, it } from 'vitest';

import { isAnalysisInboxPageExhausted } from './use-analysis-data.shared';

describe('isAnalysisInboxPageExhausted', () => {
  it('treats analysis inbox pages shorter than the provided backend page limit as exhausted', () => {
    expect(isAnalysisInboxPageExhausted([], 20)).toBe(true);
    expect(isAnalysisInboxPageExhausted(Array.from({ length: 9 }, (_, index) => [index, {}]), 10)).toBe(true);
    expect(isAnalysisInboxPageExhausted(Array.from({ length: 10 }, (_, index) => [index, {}]), 10)).toBe(false);
  });

  it('does not guess exhaustion when the page limit is missing', () => {
    expect(isAnalysisInboxPageExhausted([], null)).toBe(false);
    expect(isAnalysisInboxPageExhausted([], undefined)).toBe(false);
  });
});
