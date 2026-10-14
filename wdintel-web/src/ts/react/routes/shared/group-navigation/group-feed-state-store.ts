import type { AcknowledgeGroupFeedReq, GroupFeedState } from '../../../../../Bindings';
import {
  acknowledgeGroupFeedTail,
  fetchGroupFeedStates,
} from '../../../services/api/group-feed-state';

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
  let inFlight: {
    generation: number;
    controller: AbortController;
    promise: Promise<void>;
  } | null = null;

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

  const refresh = async (force = false): Promise<void> => {
    if (visibleConsumers === 0) return;
    if (inFlight !== null) return inFlight.promise;
    const expired = lastFetchedAt === 0 || now() - lastFetchedAt >= ttlMs;
    if (!force && !snapshot.stale && !expired) return;

    clearDebounce();
    const requestGeneration = ++generation;
    const controller = new AbortController();
    update({ loading: true, error: null });
    const promise = fetchStates(controller.signal)
      .then((groups) => {
        if (requestGeneration !== generation || visibleConsumers === 0) return;
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
    inFlight = { generation: requestGeneration, controller, promise };
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
      if (inFlight !== null) {
        generation += 1;
        abortInFlight();
        update({ loading: false, stale: true });
      }
    };
  };

  const acknowledge = async (request: AcknowledgeGroupFeedReq, signal?: AbortSignal) => {
    const group = await acknowledgeRequest(request, signal);
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    const groupIndex = snapshot.groups.findIndex((item) => item.masterKey === group.masterKey);
    const groups = [...snapshot.groups];
    if (groupIndex === -1) groups.push(group);
    else groups[groupIndex] = group;
    update({ groups });
    return group;
  };

  const dispose = () => {
    visibleConsumers = 0;
    generation += 1;
    clearDebounce();
    abortInFlight();
    listeners.clear();
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    addVisibleConsumer,
    invalidate,
    revalidateIfStale,
    refresh: () => refresh(true),
    acknowledge,
    dispose,
  };
}

export const groupFeedStateStore = createGroupFeedStateStore();
