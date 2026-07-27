const OBSERVED_ORIGIN_TTL_MS = 5 * 60 * 1000;
const MAX_TRACKED_ORIGINS = 4096;

type OriginState = {
  eventReceived: boolean;
  status: 'pending' | 'succeeded' | 'failed';
  timeout: ReturnType<typeof setTimeout> | null;
};

export type LocalInboxChangeDisposition = 'unmatched' | 'ignore' | 'reconcile';

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const originPrefix = `${randomId()}.`;
const origins = new Map<string, OriginState>();

function scheduleObservedCleanup(origin: string, state: OriginState) {
  if (state.timeout != null) return;
  state.timeout = setTimeout(() => {
    origins.delete(origin);
  }, OBSERVED_ORIGIN_TTL_MS);
}

function registerOrigin() {
  if (origins.size >= MAX_TRACKED_ORIGINS) {
    const oldestOrigin = origins.keys().next().value;
    if (oldestOrigin != null) {
      const oldestState = origins.get(oldestOrigin);
      if (oldestState?.timeout != null) clearTimeout(oldestState.timeout);
      origins.delete(oldestOrigin);
    }
  }
  const origin = `${originPrefix}${randomId()}`;
  origins.set(origin, {
    eventReceived: false,
    status: 'pending',
    timeout: null,
  });
  return origin;
}

function completeOrigin(origin: string) {
  const state = origins.get(origin);
  if (state == null) return;
  state.status = 'succeeded';
  if (state.eventReceived) scheduleObservedCleanup(origin, state);
}

function failOrigin(origin: string) {
  const state = origins.get(origin);
  if (state == null) return false;
  state.status = 'failed';
  if (state.eventReceived) scheduleObservedCleanup(origin, state);
  return state.eventReceived;
}

function classifyOrigin(origin: string): LocalInboxChangeDisposition {
  const state = origins.get(origin);
  if (state == null) {
    return origin.startsWith(originPrefix) ? 'reconcile' : 'unmatched';
  }

  state.eventReceived = true;
  if (state.status !== 'pending') scheduleObservedCleanup(origin, state);
  return state.status === 'failed' ? 'reconcile' : 'ignore';
}

const localInboxChangeOrigins = {
  classifyOrigin,
  completeOrigin,
  failOrigin,
  registerOrigin,
};

export function useLocalInboxChangeOrigins() {
  return localInboxChangeOrigins;
}
