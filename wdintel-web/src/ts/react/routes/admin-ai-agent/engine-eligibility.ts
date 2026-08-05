import type { AiEngineItem } from '../../../../Bindings';

const DISPATCHER_HOSTNAME_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const AI_AGENT_TOKEN_WARNING =
  'Увага: використання цього провайдера ШІ агентом передає токен до ізольованого контейнера.';

function isIpv4Address(hostname: string): boolean {
  const parts = hostname.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

function isDispatcherUpstreamHost(hostname: string): boolean {
  return (
    isIpv4Address(hostname) ||
    (hostname.length <= 253 && DISPATCHER_HOSTNAME_RE.test(hostname.toLowerCase()))
  );
}

export function isAiAgentEligibleEngine(
  engine: Pick<AiEngineItem, 'enabled' | 'hasToken' | 'url'>,
): boolean {
  return getAiAgentEngineCompatibility(engine).compatible;
}

export type AiAgentEngineCompatibility = {
  compatible: boolean;
  explanation: string;
};

export function getAiReviewerEngineCompatibility(
  engine: Pick<AiEngineItem, 'enabled' | 'url'>,
): AiAgentEngineCompatibility {
  if (!engine.enabled) {
    return { compatible: false, explanation: 'Провайдер вимкнений.' };
  }
  try {
    const url = new URL(engine.url);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      return { compatible: false, explanation: 'Base URL має некоректний формат.' };
    }
    return { compatible: true, explanation: 'Доступний для безпекової перевірки.' };
  } catch (_) {
    return { compatible: false, explanation: 'Base URL має некоректний формат.' };
  }
}

export function getAiAgentEngineCompatibility(
  engine: Pick<AiEngineItem, 'enabled' | 'hasToken' | 'url'>,
): AiAgentEngineCompatibility {
  if (!engine.enabled) {
    return { compatible: false, explanation: 'Провайдер вимкнений.' };
  }
  try {
    const url = new URL(engine.url);
    if (url.protocol !== 'http:') {
      return {
        compatible: false,
        explanation: 'ШІ агентам потрібен внутрішній HTTP endpoint.',
      };
    }
    if (url.username || url.password) {
      return {
        compatible: false,
        explanation: 'URL не може містити вбудовані облікові дані.',
      };
    }
    if (url.search || url.hash) {
      return {
        compatible: false,
        explanation: 'URL не може містити query-параметри або fragment.',
      };
    }
    if (url.pathname.replace(/\/+$/, '') !== '/v1') {
      return {
        compatible: false,
        explanation: 'Base URL має завершуватися шляхом /v1.',
      };
    }
    if (!isDispatcherUpstreamHost(url.hostname)) {
      return {
        compatible: false,
        explanation: 'Hostname недоступний для захищеного проксі агента.',
      };
    }
    return {
      compatible: true,
      explanation: 'Доступний для ШІ агентів.',
    };
  } catch (_) {
    return { compatible: false, explanation: 'Base URL має некоректний формат.' };
  }
}
