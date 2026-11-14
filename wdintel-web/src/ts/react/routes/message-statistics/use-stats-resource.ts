import { useEffect, useRef, useState } from 'react';
import type { DailyMessageStatsFacetRsp, DailyMessageStatsSendersRsp } from '../../../../Bindings';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { STATS_REFRESH_MS } from './state';

type Response = DailyMessageStatsFacetRsp | DailyMessageStatsSendersRsp;
const CACHE_TTL_MS = 5_000;
const CACHE_CAPACITY = 32;

export class StatsResourceCache {
  private entries = new Map<string, { response: Response; expires: number }>();
  get<T extends Response>(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expires <= performance.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.response as T;
  }
  put(key: string, response: Response) {
    const remaining = Math.max(0, CACHE_TTL_MS - Math.max(0, Date.now() - response.generatedAtMs));
    this.entries.delete(key);
    if (this.entries.size >= CACHE_CAPACITY) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { response, expires: performance.now() + remaining });
  }
  clear() {
    this.entries.clear();
  }
}

type Resource<T> = { key: string | null; data: T | null; loading: boolean; error: string | null };

export function useStatsResource<T extends Response>({
  cache,
  resourceKey,
  active,
  load,
  accept,
  onDenied,
}: {
  cache: StatsResourceCache;
  resourceKey: string | null;
  active: boolean;
  load: (signal: AbortSignal) => Promise<T>;
  accept: (response: T) => boolean;
  onDenied: (error: unknown) => void;
}) {
  const [state, setState] = useState<Resource<T>>({
    key: null,
    data: null,
    loading: false,
    error: null,
  });
  const [revision, setRevision] = useState(0);
  const callbacks = useRef({ load, accept, onDenied });
  callbacks.current = { load, accept, onDenied };
  const loadedAt = useRef(0);
  const pending = useRef(false);
  const force = useRef(false);
  const { notify } = usePowerSnackbar();
  useEffect(() => {
    if (!active || !resourceKey) {
      setState({ key: resourceKey, data: null, loading: false, error: null });
      return;
    }
    const cached = force.current ? null : cache.get<T>(resourceKey);
    force.current = false;
    if (cached && callbacks.current.accept(cached)) {
      setState({ key: resourceKey, data: cached, loading: false, error: null });
      loadedAt.current = Date.now();
      return;
    }
    const controller = new AbortController();
    pending.current = true;
    setState({ key: resourceKey, data: null, loading: true, error: null });
    callbacks.current
      .load(controller.signal)
      .then((response) => {
        if (controller.signal.aborted || !callbacks.current.accept(response)) return;
        cache.put(resourceKey, response);
        loadedAt.current = Date.now();
        setState({ key: resourceKey, data: response, loading: false, error: null });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbortError(reason)) return;
        if (reason instanceof HttpRequestError && [401, 403].includes(reason.status))
          callbacks.current.onDenied(reason);
        const message = reason instanceof Error ? reason.message : 'Не вдалося завантажити фільтр.';
        setState({ key: resourceKey, data: null, loading: false, error: message });
        notify({ severity: 'error', message });
      })
      .finally(() => {
        if (!controller.signal.aborted) pending.current = false;
      });
    return () => {
      controller.abort();
      pending.current = false;
    };
  }, [active, resourceKey, revision, cache, notify]);
  useEffect(() => {
    if (!active || !resourceKey) return;
    const refresh = () => {
      if (
        document.visibilityState === 'visible' &&
        !pending.current &&
        Date.now() - loadedAt.current >= STATS_REFRESH_MS
      ) {
        force.current = true;
        setRevision((value) => value + 1);
      }
    };
    const timer = window.setInterval(refresh, STATS_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [active, resourceKey]);
  const current = state.key === resourceKey ? state : null;
  const data =
    active && resourceKey
      ? (current?.data ?? (!current?.loading && !current?.error ? cache.get<T>(resourceKey) : null))
      : null;
  return {
    data,
    loading: active && !!resourceKey && !data && !current?.error,
    error: current?.error ?? null,
    retry: () => {
      force.current = true;
      setRevision((value) => value + 1);
    },
  };
}
