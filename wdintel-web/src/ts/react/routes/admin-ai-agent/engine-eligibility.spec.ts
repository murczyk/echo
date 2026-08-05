import { describe, expect, it } from 'vitest';

import {
  getAiAgentEngineCompatibility,
  getAiReviewerEngineCompatibility,
  isAiAgentEligibleEngine,
} from './engine-eligibility';

describe('isAiAgentEligibleEngine', () => {
  it('allows the same internal HTTP /v1 upstreams as the backend', () => {
    expect(
      isAiAgentEligibleEngine({
        enabled: true,
        hasToken: false,
        url: 'http://vllm.example:8000/v1',
      }),
    ).toBe(true);
    expect(
      isAiAgentEligibleEngine({
        enabled: true,
        hasToken: false,
        url: 'http://100.64.1.2:8000/v1/',
      }),
    ).toBe(true);
    expect(
      isAiAgentEligibleEngine({
        enabled: false,
        hasToken: false,
        url: 'http://vllm.example:8000/v1',
      }),
    ).toBe(false);
    expect(
      isAiAgentEligibleEngine({
        enabled: true,
        hasToken: true,
        url: 'http://vllm.example:8000/v1',
      }),
    ).toBe(true);
    expect(
      isAiAgentEligibleEngine({
        enabled: true,
        hasToken: false,
        url: 'https://vllm.example:8000/v1',
      }),
    ).toBe(false);
    expect(
      isAiAgentEligibleEngine({ enabled: true, hasToken: false, url: 'http://vllm:8000/v1' }),
    ).toBe(false);
    expect(
      isAiAgentEligibleEngine({
        enabled: true,
        hasToken: false,
        url: 'http://vllm.example:8000',
      }),
    ).toBe(false);
    expect(
      isAiAgentEligibleEngine({
        enabled: true,
        hasToken: false,
        url: 'http://user:password@vllm.example:8000/v1',
      }),
    ).toBe(false);
    expect(
      isAiAgentEligibleEngine({
        enabled: true,
        hasToken: false,
        url: 'http://vllm.example:8000/v1?debug=true',
      }),
    ).toBe(false);
    expect(isAiAgentEligibleEngine({ enabled: true, hasToken: false, url: 'not-a-url' })).toBe(
      false,
    );
  });

  it('does not treat a token as an incompatibility', () => {
    expect(
      getAiAgentEngineCompatibility({
        enabled: true,
        hasToken: true,
        url: 'http://vllm.example:8000/v1',
      }),
    ).toEqual({ compatible: true, explanation: 'Доступний для ШІ агентів.' });
    expect(
      getAiAgentEngineCompatibility({
        enabled: true,
        hasToken: true,
        url: 'https://api.openai.com/v1',
      }),
    ).toEqual({
      compatible: false,
      explanation: 'ШІ агентам потрібен внутрішній HTTP endpoint.',
    });
  });

  it('allows enabled HTTPS token providers for trusted backend reviews', () => {
    expect(
      getAiReviewerEngineCompatibility({
        enabled: true,
        url: 'https://api.openai.com/v1',
      }),
    ).toEqual({
      compatible: true,
      explanation: 'Доступний для безпекової перевірки.',
    });
  });
});
