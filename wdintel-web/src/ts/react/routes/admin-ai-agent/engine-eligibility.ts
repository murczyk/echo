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

export type AiAgentEngineTransport = 'direct_http' | 'echo_gateway';

export type AiAgentTokenNotice = {
  message: string;
  severity: 'warning' | 'info';
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
    const transport = getAiAgentEngineTransport(engine);
    if (transport === 'direct_http') {
      return {
        compatible: true,
        explanation: 'Доступний для ШІ агентів.',
      };
    }
    if (transport === 'echo_gateway') {
      return {
        compatible: true,
        explanation: 'Доступний через захищений шлюз Echo.',
      };
    }
    if (url.protocol !== 'http:') {
      return {
        compatible: false,
        explanation: 'ШІ агентам потрібен внутрішній HTTP endpoint або шлюз OpenAI.',
      };
    }
    if (!isDispatcherUpstreamHost(url.hostname)) {
      return {
        compatible: false,
        explanation: 'Hostname недоступний для захищеного проксі агента.',
      };
    }
    return { compatible: false, explanation: 'Base URL має некоректний формат.' };
  } catch (_) {
    return { compatible: false, explanation: 'Base URL має некоректний формат.' };
  }
}

export function getAiAgentEngineTransport(
  engine: Pick<AiEngineItem, 'enabled' | 'hasToken' | 'url'>,
): AiAgentEngineTransport | null {
  if (!engine.enabled) {
    return null;
  }
  try {
    const url = new URL(engine.url);
    if (!isCleanProviderUrl(url)) {
      return null;
    }
    if (url.hostname.toLowerCase() === 'inference.ai.mod.gov.ua') {
      return isGovernmentAiUrl(url) ? 'echo_gateway' : null;
    }
    if (url.protocol === 'http:' && isDispatcherUpstreamHost(url.hostname)) {
      return 'direct_http';
    }
  } catch (_) {
    return null;
  }
  return null;
}

export function getAiAgentTokenNotice(
  engine: Pick<AiEngineItem, 'enabled' | 'hasToken' | 'url'>,
): AiAgentTokenNotice | null {
  try {
    if (engine.enabled && isGovernmentAiUrl(new URL(engine.url))) {
      return {
        message:
          'Шлюз Echo додає токен Azure на сервері; секрет і токен не передаються до контейнера агента.',
        severity: 'info',
      };
    }
  } catch {}
  if (!engine.hasToken) {
    return null;
  }
  return getAiAgentEngineTransport(engine) === 'direct_http'
    ? { message: AI_AGENT_TOKEN_WARNING, severity: 'warning' }
    : null;
}

function isCleanProviderUrl(url: URL): boolean {
  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname.replace(/\/+$/, '') === '/v1'
  );
}

export function isGovernmentAiUrl(url: URL): boolean {
  return (
    isCleanProviderUrl(url) &&
    url.protocol === 'https:' &&
    url.hostname.toLowerCase() === 'inference.ai.mod.gov.ua' &&
    (url.port || '443') === '443'
  );
}
