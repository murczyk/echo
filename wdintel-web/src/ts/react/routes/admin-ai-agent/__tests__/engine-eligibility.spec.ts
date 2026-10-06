import { describe, expect, it } from 'vitest';

import {
  AI_AGENT_GATEWAY_TOKEN_NOTICE,
  AI_AGENT_TOKEN_WARNING,
  getAiAgentTokenNotice,
  isAiAgentEligibleEngine,
} from '.././engine-eligibility';

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
});

// Regression: https://github.com/echoua/echo/issues/3682
it('uses the Echo capability gateway for government engines without static tokens', () => {
  const engine = { enabled: true, hasToken: false, url: 'https://inference.ai.mod.gov.ua/v1' };
  expect(isAiAgentEligibleEngine(engine)).toBe(true);
  expect(getAiAgentTokenNotice(engine)?.severity).toBe('info');
  for (const url of [
    'http://inference.ai.mod.gov.ua/v1',
    'https://inference.ai.mod.gov.ua:8443/v1',
    'https://inference.ai.mod.gov.ua/v1?key=secret',
  ]) {
    expect(isAiAgentEligibleEngine({ ...engine, url })).toBe(false);
  }
});
