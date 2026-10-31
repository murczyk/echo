import type { AiAgentReasoningPreset } from '../../../../Bindings';
import type { AiAgentConfiguration } from '../../services/api/ai-agent';

const PROVIDER_STORAGE_KEY = 'echo.ai-agent.provider-id';
const REASONING_STORAGE_KEY = 'echo.ai-agent.reasoning-preset';

function readItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function writeItem(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch (_) {}
}

export function saveRememberedProviderId(providerId: string) {
  writeItem(PROVIDER_STORAGE_KEY, providerId);
}

export function rememberedProviderId(configuration: AiAgentConfiguration): string {
  const remembered = readItem(PROVIDER_STORAGE_KEY);
  const rememberedProvider = configuration.providers.find(
    (provider) => provider.enabled && provider.id === remembered,
  );
  return (
    rememberedProvider?.id ??
    configuration.defaultProviderId ??
    configuration.providers[0]?.id ??
    ''
  );
}

// Deep runs for up to 30 minutes, so it is never remembered and must be picked per request.
export function saveRememberedReasoningPreset(preset: AiAgentReasoningPreset) {
  if (preset !== 'deep') writeItem(REASONING_STORAGE_KEY, preset);
}

export function rememberedReasoningPreset(): AiAgentReasoningPreset {
  return readItem(REASONING_STORAGE_KEY) === 'fast' ? 'fast' : 'balanced';
}
