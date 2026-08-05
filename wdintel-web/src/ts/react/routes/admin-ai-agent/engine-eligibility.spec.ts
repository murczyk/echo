import { describe, expect, it } from 'vitest';

import {
  AI_AGENT_GATEWAY_TOKEN_NOTICE,
  AI_AGENT_TOKEN_WARNING,
  getAiAgentEngineCompatibility,
  getAiAgentTokenNotice,
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
    ).toEqual({ compatible: true, explanation: 'Доступний через захищений шлюз Echo.' });
    expect(
      getAiAgentEngineCompatibility({
        enabled: true,
        hasToken: false,
        url: 'https://api.openai.com/v1',
      }),
    ).toEqual({
      compatible: false,
      explanation: 'Шлюз Echo для OpenAI потребує токен провайдера.',
    });
  });

  it('shows token handling according to the provider transport', () => {
    expect(
      getAiAgentTokenNotice({
        enabled: true,
        hasToken: true,
        url: 'http://vllm.example:8000/v1',
      }),
    ).toEqual({ message: AI_AGENT_TOKEN_WARNING, severity: 'warning' });
    expect(
      getAiAgentTokenNotice({
        enabled: true,
        hasToken: true,
        url: 'https://api.openai.com/v1',
      }),
    ).toEqual({ message: AI_AGENT_GATEWAY_TOKEN_NOTICE, severity: 'info' });
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
