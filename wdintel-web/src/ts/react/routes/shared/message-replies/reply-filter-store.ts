import type { InboxMessagesReq } from '../../../../../Bindings';
import { fetchMessagesByIdsMatchingFilters } from '../../../services/api/analysis';

const FILTER_BATCH_LIMIT = 100;
const FILTER_CACHE_LIMIT = 1024;
type Pending = { resolve: (matches: boolean) => void; reject: (error: unknown) => void };
type Cached = { result: Promise<boolean>; pending: boolean };

export class ReplyFilterStore {
  private cache = new Map<string, Map<number, Cached>>();
  private pending = new Map<string, Map<number, Pending[]>>();
  private controller = new AbortController();
  private listeners = new Set<() => void>();
  private references = new Map<number, number>();
  private version = 0;
  private scheduled = false;

  constructor(
    private requests: Readonly<Record<string, Partial<InboxMessagesReq>>>,
    private onError: (error: unknown) => void,
  ) {}

  subscribe = (listener: () => void, ids: number[] = []) => {
    this.listeners.add(listener);
    ids.forEach((id) => this.references.set(id, (this.references.get(id) ?? 0) + 1));
    return () => {
      this.listeners.delete(listener);
      ids.forEach((id) => {
        const remaining = (this.references.get(id) ?? 1) - 1;
        if (remaining) this.references.set(id, remaining);
        else this.references.delete(id);
      });
    };
  };
  getVersion = () => this.version;

  check = async (scope: string, ids: number[]) => {
    if (!this.requests[scope]) return new Map<number, boolean>();
    const cache = this.cache.get(scope) ?? new Map<number, Cached>();
    this.cache.set(scope, cache);
    const pending = this.pending.get(scope) ?? new Map<number, Pending[]>();
    const results = ids.map((id) => {
      let cached = cache.get(id);
      if (!cached) {
        const result = new Promise<boolean>((resolve, reject) => {
          pending.set(id, [...(pending.get(id) ?? []), { resolve, reject }]);
        });
        cached = { result, pending: true };
        cache.set(id, cached);
        const entry = cached;
        void result.then(
          () => {
            entry.pending = false;
            for (const [cachedId, value] of cache) {
              if (cache.size <= FILTER_CACHE_LIMIT) break;
              if (!value.pending) cache.delete(cachedId);
            }
          },
          () => {
            if (cache.get(id) === entry) cache.delete(id);
          },
        );
      }
      return cached.result.then((matches) => [id, matches] as const);
    });
    if (pending.size) this.pending.set(scope, pending);
    if (!this.scheduled && this.pending.size) {
      this.scheduled = true;
      queueMicrotask(() => void this.flush());
    }
    return new Map(await Promise.all(results));
  };

  invalidate = (ids: number[]) => {
    const changed = ids.some((id) => this.references.has(id));
    this.cache.forEach((cache) => ids.forEach((id) => cache.delete(id)));
    if (!changed) return;
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  };

  dispose = () => {
    this.controller.abort();
    this.pending.forEach((pending) =>
      pending.forEach((waiters) =>
        waiters.forEach(({ reject }) => reject(this.controller.signal.reason)),
      ),
    );
    this.pending.clear();
  };

  private flush = async () => {
    this.scheduled = false;
    const scopes = this.pending;
    this.pending = new Map();
    await Promise.all(
      Array.from(scopes, async ([scope, pending]) => {
        const ids = Array.from(pending.keys());
        for (let offset = 0; offset < ids.length; offset += FILTER_BATCH_LIMIT) {
          const batch = ids.slice(offset, offset + FILTER_BATCH_LIMIT);
          try {
            const messages = await fetchMessagesByIdsMatchingFilters(batch, this.requests[scope], {
              signal: this.controller.signal,
            });
            this.controller.signal.throwIfAborted();
            const matches = new Set(messages.map(([id]) => id));
            batch.forEach((id) =>
              pending.get(id)!.forEach(({ resolve }) => resolve(matches.has(id))),
            );
          } catch (error) {
            batch.forEach((id) => {
              pending.get(id)!.forEach(({ reject }) => reject(error));
            });
            if (!this.controller.signal.aborted) this.onError(error);
          }
        }
      }),
    );
  };
}
