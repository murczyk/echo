import { describe, expect, it } from 'vitest';

import type { AiAgentProvider } from '../../../services/api/ai-agent';
import {
  conversationTurns,
  modelFallback,
  nextProvider,
  presetFor,
  type ConversationTurn,
} from '../provider-fallback';

function provider(id: string, overrides: Partial<AiAgentProvider> = {}): AiAgentProvider {
  return {
    id,
    name: id,
    modelName: id,
    unhealthy: false,
    healthMessage: null,
    enabled: true,
    isDefault: false,
    ...overrides,
  };
}

const GLM = provider('glm');
const FLASH = provider('flash');
const SOL = provider('sol');

function turn(providerId: string, reason: string | null, state = 'completed'): ConversationTurn {
  return {
    requestId: `request-${providerId}-${reason}`,
    providerId,
    prompt: 'Де позиції?',
    preset: 'balanced',
    state,
    completionMetadata: reason ? { coverageLimited: false, reason } : null,
  };
}

describe('#4112 provider fallback', () => {
  it('walks the admin order, wraps around and skips unhealthy engines', () => {
    expect(nextProvider([GLM, FLASH, SOL], 'glm')?.id).toBe('flash');
    expect(nextProvider([GLM, FLASH, SOL], 'sol')?.id).toBe('glm');
    expect(nextProvider([GLM, { ...FLASH, unhealthy: true }, SOL], 'glm')?.id).toBe('sol');
    expect(nextProvider([GLM, FLASH], 'removed')?.id).toBe('glm');
    expect(nextProvider([GLM], 'glm')).toBeNull();
  });

  it('skips engines that already failed in the same run of failures', () => {
    const providers = [GLM, FLASH, SOL];
    expect(modelFallback([turn('glm', 'provider_error')], providers)?.next?.id).toBe('flash');
    expect(
      modelFallback([turn('glm', 'provider_error'), turn('flash', 'provider_error')], providers)
        ?.next?.id,
    ).toBe('sol');
    expect(
      modelFallback(
        [
          turn('glm', 'provider_error'),
          turn('flash', 'provider_error'),
          turn('sol', 'model_refusal'),
        ],
        providers,
      )?.next,
    ).toBeNull();
    expect(
      modelFallback(
        [turn('flash', 'provider_error'), turn('glm', null), turn('sol', 'model_refusal')],
        providers,
      )?.next?.id,
      'a success ends the run',
    ).toBe('glm');
  });

  it('offers nothing after a success, a running turn or an infrastructure failure', () => {
    expect(modelFallback([turn('glm', null)], [GLM, FLASH])).toBeNull();
    expect(modelFallback([turn('glm', 'provider_error', 'running')], [GLM, FLASH])).toBeNull();
    expect(modelFallback([turn('glm', null, 'failed')], [GLM, FLASH])).toBeNull();
    expect(modelFallback([turn('glm', 'time_limit')], [GLM, FLASH])).toBeNull();
    expect(modelFallback([turn('glm', 'provider_error', 'failed')], [GLM, FLASH])?.next?.id).toBe(
      'flash',
    );
  });

  it('keeps the depth when the target engine offers it', () => {
    const presets = [{ preset: 'fast' as const, maxRuntimeSeconds: 120, reasoningEffort: 'low' }];
    const fastOnly = { ...SOL, reasoningPresets: presets };
    expect(presetFor(fastOnly, 'fast', 'balanced')).toBe('fast');
    expect(presetFor(fastOnly, 'deep', 'balanced')).toBe('fast');
    expect(presetFor(SOL, 'deep', 'balanced')).toBe('balanced');
  });

  it('reads saved turns and newer live requests in order', () => {
    const turns = conversationTurns(
      [
        {
          id: 'a-user',
          requestId: 'a',
          requestState: 'completed',
          role: 'user',
          content: 'Перше',
          createdAt: 1,
          citations: [],
          aiEngineId: 'glm',
          completionMetadata: { coverageLimited: true, reason: 'provider_error' },
        },
      ],
      [
        {
          id: 'b',
          conversationId: 'c',
          providerId: 'flash',
          prompt: 'Друге',
          createdAt: 2,
          state: 'running',
          assistantText: '',
          progress: [],
          tools: [],
          sources: [],
          lastSequence: 0,
          streamError: null,
        },
      ],
    );
    expect(turns.map((item) => [item.requestId, item.providerId, item.state])).toEqual([
      ['a', 'glm', 'completed'],
      ['b', 'flash', 'running'],
    ]);
  });
});
