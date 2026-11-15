import type { AiEngineItem } from '../../../../Bindings';

const DISPATCHER_HOSTNAME_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const GOVERNMENT_AI_HOST = 'inference.ai.mod.gov.ua';
// Mirrors AI_GOV_UA_PROXY_MODEL_PREFIX in wdintel-rs/src/config.rs.
const GOVERNMENT_AI_PROXY_MODEL_PREFIX = `${GOVERNMENT_AI_HOST}/`;

type AiAgentEngineFields = Pick<AiEngineItem, 'enabled' | 'hasToken' | 'url'> &
  Partial<Pick<AiEngineItem, 'modelName'>>;

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

export function isAiAgentEligibleEngine(engine: AiAgentEngineFields): boolean {
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
  engine: AiAgentEngineFields,
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
    if (hasUnknownHostPrefix(engine)) {
      return {
        compatible: false,
        explanation: `Префікс моделі схожий на хост, але не є ${GOVERNMENT_AI_PROXY_MODEL_PREFIX}`,
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
  engine: AiAgentEngineFields,
): AiAgentEngineTransport | null {
  if (!engine.enabled) {
    return null;
  }
  try {
    const url = new URL(engine.url);
    if (!isCleanProviderUrl(url)) {
      return null;
    }
    if (url.hostname.toLowerCase() === GOVERNMENT_AI_HOST) {
      return isGovernmentAiUrl(url) ? 'echo_gateway' : null;
    }
    // Echo adds the proxy key on the server; it never reaches a container.
    if (isGovernmentAiProxyEngine(engine)) {
      return 'echo_gateway';
    }
    if (hasUnknownHostPrefix(engine)) {
      return null;
    }
    if (url.protocol === 'http:' && isDispatcherUpstreamHost(url.hostname)) {
      return 'direct_http';
    }
  } catch (_) {
    return null;
  }
  return null;
}

export function getAiAgentTokenNotice(engine: AiAgentEngineFields): AiAgentTokenNotice | null {
  try {
    if (engine.enabled && isGovernmentAiUrl(new URL(engine.url))) {
      return {
        message:
          'Шлюз Echo додає токен Azure на сервері; секрет і токен не передаються до контейнера агента.',
        severity: 'info',
      };
    }
  } catch {}
  if (engine.enabled && isGovernmentAiProxyEngine(engine)) {
    return engine.hasToken
      ? {
          message:
            'Шлюз Echo додає ключ проксі державного шлюзу на сервері; ключ не передається до контейнера агента.',
          severity: 'info',
        }
      : {
          message: 'Вкажіть ключ проксі державного шлюзу ШІ як токен движка.',
          severity: 'warning',
        };
  }
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

function isDirectOpenAiHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  return host === 'openai.com' || host.endsWith('.openai.com');
}

/**
 * The model name Echo's model quirks see: without the proxy prefix on a
 * proxied government engine. Mirrors `model_id` in
 * wdintel-rs/src/ai_engine/client.rs.
 */
export function getAiEngineModelId(engine: Pick<AiEngineItem, 'url' | 'modelName'>): string {
  return isGovernmentAiProxyEngine(engine)
    ? engine.modelName.slice(GOVERNMENT_AI_PROXY_MODEL_PREFIX.length)
    : engine.modelName;
}

/**
 * The government gateway reached through a proxy that holds its credentials
 * (Bifrost or another one). Mirrors `is_government_proxy` in
 * wdintel-rs/src/ai_engine/client.rs.
 */
export function isGovernmentAiProxyEngine(
  engine: Pick<AiEngineItem, 'url'> & Partial<Pick<AiEngineItem, 'modelName'>>,
): boolean {
  const modelName = engine.modelName ?? '';
  if (
    !modelName.startsWith(GOVERNMENT_AI_PROXY_MODEL_PREFIX) ||
    modelName.length === GOVERNMENT_AI_PROXY_MODEL_PREFIX.length
  ) {
    return false;
  }
  try {
    const url = new URL(engine.url);
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      host !== GOVERNMENT_AI_HOST &&
      !isDirectOpenAiHost(host)
    );
  } catch {
    return false;
  }
}

/** A model name starting with a host other than the government gateway's. */
function hasUnknownHostPrefix(
  engine: Pick<AiEngineItem, 'url'> & Partial<Pick<AiEngineItem, 'modelName'>>,
): boolean {
  const modelName = engine.modelName ?? '';
  const slash = modelName.indexOf('/');
  if (slash < 0 || !modelName.slice(0, slash).includes('.')) {
    return false;
  }
  try {
    if (isGovernmentAiUrl(new URL(engine.url))) {
      return false;
    }
  } catch {}
  return !isGovernmentAiProxyEngine(engine);
}

export function isGovernmentAiUrl(url: URL): boolean {
  return (
    isCleanProviderUrl(url) &&
    url.protocol === 'https:' &&
    url.hostname.toLowerCase() === GOVERNMENT_AI_HOST &&
    (url.port || '443') === '443'
  );
}
