import type { AiAgentCompletionMetadata, AiAgentReasoningPreset } from '../../../../Bindings';
import type { AiAgentMessage, AiAgentProvider } from '../../services/api/ai-agent';
import type { LiveRequest } from './index';

/** Completion reasons after which another model may succeed (#4112). */
export const MODEL_FAILURE_NOTES: Record<string, string> = {
  provider_error: 'Провайдер не відповів',
  model_refusal: 'Модель відмовилася відповідати',
};

export function modelFailureNote(
  metadata: AiAgentCompletionMetadata | null | undefined,
): string | null {
  return metadata ? (MODEL_FAILURE_NOTES[metadata.reason] ?? null) : null;
}

export type ConversationTurn = {
  requestId: string;
  providerId: string | null;
  prompt: string;
  preset: AiAgentReasoningPreset | null;
  state: string;
  completionMetadata: AiAgentCompletionMetadata | null;
};

/** One entry per request, oldest first; live requests the saved list lacks are newer. */
export function conversationTurns(
  messages: AiAgentMessage[],
  liveRequests: LiveRequest[],
): ConversationTurn[] {
  const live = new Map(liveRequests.map((request) => [request.id, request]));
  const saved = messages
    .filter((message) => message.role === 'user')
    .map((message): ConversationTurn => {
      const request = live.get(message.requestId);
      return {
        requestId: message.requestId,
        providerId: request?.providerId ?? message.aiEngineId ?? null,
        prompt: message.content,
        preset: message.reasoningPreset ?? null,
        state: request?.state ?? message.requestState,
        completionMetadata: request?.completionMetadata ?? message.completionMetadata ?? null,
      };
    });
  const listed = new Set(saved.map((turn) => turn.requestId));
  const newer = liveRequests
    .filter((request) => !listed.has(request.id))
    .map((request): ConversationTurn => ({
      requestId: request.id,
      providerId: request.providerId ?? null,
      prompt: request.prompt,
      preset: request.reasoningPreset ?? null,
      state: request.state,
      completionMetadata: request.completionMetadata ?? null,
    }));
  return [...saved, ...newer];
}

function failedModel(turn: ConversationTurn): boolean {
  return (
    (turn.state === 'completed' || turn.state === 'failed') &&
    modelFailureNote(turn.completionMetadata) !== null
  );
}

export type ModelFallback = {
  turn: ConversationTurn;
  next: AiAgentProvider | null;
};

/**
 * The newest turn when its model failed, and the engine to suggest next. Engines that
 * already failed in the same unbroken run of failures are skipped, so GLM-5.3 → Flash →
 * Sol does not loop back to GLM-5.3.
 */
export function modelFallback(
  turns: ConversationTurn[],
  providers: AiAgentProvider[],
): ModelFallback | null {
  const turn = turns.at(-1);
  if (!turn || !failedModel(turn)) return null;
  const tried = new Set<string>();
  for (const earlier of [...turns].reverse()) {
    if (!failedModel(earlier)) break;
    if (earlier.providerId) tried.add(earlier.providerId);
  }
  return { turn, next: nextProvider(providers, turn.providerId, tried) };
}

/** The next usable engine after `fromId` in the admin's order, wrapping around. */
export function nextProvider(
  providers: AiAgentProvider[],
  fromId: string | null,
  excluded: Set<string> = new Set(),
): AiAgentProvider | null {
  const start = providers.findIndex((provider) => provider.id === fromId);
  for (let offset = 1; offset <= providers.length; offset += 1) {
    const provider = providers[(start + offset + providers.length) % providers.length];
    if (
      provider.id !== fromId &&
      provider.enabled &&
      !provider.unhealthy &&
      !excluded.has(provider.id)
    ) {
      return provider;
    }
  }
  return null;
}

/** The turn's depth when the target engine offers it; otherwise the engine decides. */
export function presetFor(
  provider: AiAgentProvider,
  preset: AiAgentReasoningPreset | null,
  fallback: AiAgentReasoningPreset,
): AiAgentReasoningPreset {
  const presets = provider.reasoningPresets ?? [];
  if (preset && presets.some((option) => option.preset === preset)) return preset;
  return presets.some((option) => option.preset === fallback)
    ? fallback
    : (presets[0]?.preset ?? fallback);
}
