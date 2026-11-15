import { describe, expect, it } from 'vitest';

import {
  AI_AGENT_TOKEN_WARNING,
  getAiAgentEngineTransport,
  getAiAgentTokenNotice,
  getAiEngineModelId,
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
        url: 'https://inference.ai.mod.gov.ua/v1',
      })?.severity,
    ).toBe('info');
  });
});

it('refuses direct OpenAI engines even with a stored token', () => {
  const engine = { enabled: true, hasToken: true, url: 'https://api.openai.com/v1' };
  expect(isAiAgentEligibleEngine(engine)).toBe(false);
  expect(getAiAgentTokenNotice(engine)).toBeNull();
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

it('uses the Echo gateway for government models behind a proxy and keeps its key server-side', () => {
  for (const url of ['http://proxy.internal:8080/v1', 'https://proxy.example.ts.net/v1']) {
    const engine = {
      enabled: true,
      hasToken: true,
      url,
      modelName: 'inference.ai.mod.gov.ua/glm-5.3',
    };
    expect(getAiAgentEngineTransport(engine)).toBe('echo_gateway');
    expect(isAiAgentEligibleEngine(engine)).toBe(true);
    expect(getAiAgentTokenNotice(engine)?.severity).toBe('info');
    expect(getAiAgentTokenNotice({ ...engine, hasToken: false })?.severity).toBe('warning');
  }
});

it('refuses a mistyped proxy prefix instead of handing its token to a container', () => {
  const engine = {
    enabled: true,
    hasToken: true,
    url: 'http://proxy.internal:8080/v1',
    modelName: 'inference.ai.mod.gov.au/glm-5.3',
  };
  expect(getAiAgentEngineTransport(engine)).toBeNull();
  expect(isAiAgentEligibleEngine(engine)).toBe(false);
  expect(
    getAiAgentEngineTransport({
      ...engine,
      url: 'http://vllm.internal:8000/v1',
      modelName: 'google/gemma-3-27b-it',
    }),
  ).toBe('direct_http');
});

it('strips the proxy prefix only from proxied government models', () => {
  expect(
    getAiEngineModelId({
      url: 'http://proxy.internal:8080/v1',
      modelName: 'inference.ai.mod.gov.ua/gpt-luna',
    }),
  ).toBe('gpt-luna');
  expect(
    getAiEngineModelId({ url: 'http://vllm.internal:8000/v1', modelName: 'google/gemma-3-27b-it' }),
  ).toBe('google/gemma-3-27b-it');
  expect(
    getAiEngineModelId({ url: 'https://inference.ai.mod.gov.ua/v1', modelName: 'gpt-6-luna' }),
  ).toBe('gpt-6-luna');
});
