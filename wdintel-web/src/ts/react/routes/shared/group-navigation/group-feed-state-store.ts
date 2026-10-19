import type { AcknowledgeGroupFeedReq, GroupFeedState } from '../../../../../Bindings';
import {
  acknowledgeGroupFeedTail,
  fetchGroupFeedStates,
} from '../../../services/api/group-feed-state';
import { HttpRequestError } from '../../../services/api/client';
import { inboxChangedEvents } from '../useInboxChangedMessageIds';

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_EVENT_DEBOUNCE_MS = 150;

export type GroupFeedStateSnapshot = {
  groups: GroupFeedState[];
  loading: boolean;
  error: unknown;
  stale: boolean;
};

type StoreOptions = {
  fetchStates?: (signal?: AbortSignal) => Promise<GroupFeedState[]>;
  acknowledge?: (request: AcknowledgeGroupFeedReq, signal?: AbortSignal) => Promise<GroupFeedState>;
  ttlMs?: number;
  eventDebounceMs?: number;
  now?: () => number;
};

export type GroupFeedStateStore = ReturnType<typeof createGroupFeedStateStore>;

type InFlightRequest = {
  generation: number;
  controller: AbortController;
  promise: Promise<void>;
  keepAlive: boolean;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function createGroupFeedStateStore(options: StoreOptions = {}) {
  const fetchStates = options.fetchStates ?? fetchGroupFeedStates;
  const acknowledgeRequest = options.acknowledge ?? acknowledgeGroupFeedTail;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const eventDebounceMs = options.eventDebounceMs ?? DEFAULT_EVENT_DEBOUNCE_MS;
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let snapshot: GroupFeedStateSnapshot = {
    groups: [],
    loading: false,
    error: null,
    stale: true,
  };
  let visibleConsumers = 0;
  let generation = 0;
  let lastFetchedAt = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: InFlightRequest | null = null;
  const acknowledgements = new Map<string, Promise<GroupFeedState>>();

  const emit = () => listeners.forEach((listener) => listener());
  const update = (next: Partial<GroupFeedStateSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    emit();
  };

  const clearDebounce = () => {
    if (debounceTimer === null) return;
    clearTimeout(debounceTimer);
    debounceTimer = null;
  };

  const abortInFlight = () => {
    if (inFlight === null) return;
    inFlight.controller.abort();
    inFlight = null;
  };

  const refresh = async (force = false, keepAlive = false): Promise<void> => {
    if (!keepAlive && visibleConsumers === 0) return;
    if (inFlight !== null) {
      if (keepAlive) inFlight.keepAlive = true;
      return inFlight.promise;
    }
    const expired = lastFetchedAt === 0 || now() - lastFetchedAt >= ttlMs;
    if (!force && !snapshot.stale && !expired) return;

    clearDebounce();
    const requestGeneration = ++generation;
    const controller = new AbortController();
    update({ loading: true, error: null });
    let request: InFlightRequest;
    const promise = fetchStates(controller.signal)
      .then((groups) => {
        if (requestGeneration !== generation || (visibleConsumers === 0 && !request.keepAlive)) {
          return;
        }
        lastFetchedAt = now();
        update({ groups, loading: false, error: null, stale: false });
      })
      .catch((error: unknown) => {
        if (requestGeneration !== generation || isAbortError(error)) return;
        update({ loading: false, error, stale: true });
      })
      .finally(() => {
        if (inFlight?.generation === requestGeneration) inFlight = null;
      });
    request = { generation: requestGeneration, controller, promise, keepAlive };
    inFlight = request;
    return promise;
  };

  const scheduleRefresh = () => {
    if (visibleConsumers === 0 || debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refresh(true);
    }, eventDebounceMs);
  };

  const invalidate = ({ schedule = true }: { schedule?: boolean } = {}) => {
    generation += 1;
    abortInFlight();
    update({ loading: false, stale: true });
    if (schedule) scheduleRefresh();
  };

  const revalidateIfStale = () => refresh(false);

  const onInboxChanged = (event: Event) => {
    if (inboxChangedEvents((event as CustomEvent<unknown>).detail).length > 0) invalidate();
  };
  const onFocus = () => {
    if (document.visibilityState === 'visible') void revalidateIfStale();
  };

  const addVisibleConsumer = () => {
    visibleConsumers += 1;
    void revalidateIfStale();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      visibleConsumers = Math.max(0, visibleConsumers - 1);
      if (visibleConsumers > 0) return;
      clearDebounce();
      if (inFlight !== null && !inFlight.keepAlive) {
        generation += 1;
        abortInFlight();
        update({ loading: false, stale: true });
      }
    };
  };

  const applyAcknowledgement = async (request: AcknowledgeGroupFeedReq, signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    let group: GroupFeedState;
    try {
      group = await acknowledgeRequest(request, signal);
    } catch (error) {
      if (error instanceof HttpRequestError && error.status === 409 && !signal?.aborted) {
        invalidate({ schedule: false });
        await refresh(true, true);
      }
      throw error;
    }
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    if (inFlight !== null) invalidate();
    const groupIndex = snapshot.groups.findIndex((item) => item.masterKey === group.masterKey);
    const groups = [...snapshot.groups];
    if (groupIndex === -1) groups.push(group);
    else groups[groupIndex] = group;
    update({ groups });
    return group;
  };

  const acknowledge = (request: AcknowledgeGroupFeedReq, signal?: AbortSignal) => {
    const previous = acknowledgements.get(request.masterKey);
    const run = () => applyAcknowledgement(request, signal);
    const pending = previous ? previous.catch(() => {}).then(run) : run();
    acknowledgements.set(request.masterKey, pending);
    void pending
      .finally(() => {
        if (acknowledgements.get(request.masterKey) === pending) {
          acknowledgements.delete(request.masterKey);
        }
      })
      .catch(() => {});
    return pending;
  };

  return {
    subscribe(listener: () => void) {
      if (listeners.size === 0 && typeof window !== 'undefined') {
        window.addEventListener('echo-inbox-changed', onInboxChanged);
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onFocus);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || typeof window === 'undefined') return;
        window.removeEventListener('echo-inbox-changed', onInboxChanged);
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onFocus);
      };
    },
    getSnapshot: () => snapshot,
    addVisibleConsumer,
    invalidate,
    revalidateIfStale,
    ensureLoaded: () => refresh(false, true),
    refresh: () => refresh(true),
    acknowledge,
  };
}

export const groupFeedStateStore = createGroupFeedStateStore();
