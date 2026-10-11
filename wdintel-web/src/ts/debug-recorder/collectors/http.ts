import { createDebugSanitizer } from '../sanitize';
import type { DebugCollectorCleanup, DebugEventInput, DebugEventSink } from '../types';

type RequestMetadata = {
  requestId: string;
  method: string;
  route: string;
  sameOrigin: boolean;
  filterRule: string | null;
};

type XhrState = RequestMetadata & {
  startedAt: number | null;
  outcome: string;
  finalized: boolean;
  detach?: () => void;
};

type CoalescedSuccess = {
  suppressedCount: number;
  last: DebugEventInput;
};

function ownString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return typeof descriptor?.value === 'string' ? descriptor.value : null;
}

function inputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return '/unknown-request';
}

function inputMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const override = ownString(init, 'method');
  if (override) return override.toUpperCase().slice(0, 16);
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.method.toUpperCase().slice(0, 16);
  }
  return 'GET';
}

function classifyFilter(route: string): string | null {
  if (route === '/api/event-stream/long-poll') return 'event-stream-long-poll';
  if (/^\/api\/bgtask\/\{id_\d+\}\/status-and-logs$/.test(route)) {
    return 'background-task-status';
  }
  if (/^\/api\/messenger\/media\/\{id_\d+\}\/[^/]+\/status$/.test(route)) {
    return 'messenger-media-status';
  }
  return null;
}

function abortName(reason: unknown): string | null {
  if (reason instanceof DOMException && reason.name === 'AbortError') return 'AbortError';
  if (reason instanceof Error && reason.name === 'AbortError') return 'AbortError';
  return null;
}

function requestNamespace(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

export function attachHttpCollector(sink: DebugEventSink): DebugCollectorCleanup {
  const sanitizer = createDebugSanitizer('http-collector');
  const nativeFetch = window.fetch;
  const NativeXhr = window.XMLHttpRequest;
  const nativeOpen = NativeXhr?.prototype.open;
  const nativeSend = NativeXhr?.prototype.send;
  const nativeAbort = NativeXhr?.prototype.abort;
  const xhrStates = new WeakMap<XMLHttpRequest, XhrState>();
  const coalesced = new Map<string, CoalescedSuccess>();
  let wrappedFetch: typeof fetch | null = null;
  let wrappedOpen: typeof XMLHttpRequest.prototype.open | null = null;
  let wrappedSend: typeof XMLHttpRequest.prototype.send | null = null;
  let wrappedAbort: typeof XMLHttpRequest.prototype.abort | null = null;
  let nextRequestId = 1;
  const namespace = requestNamespace();
  let active = true;

  const emit = (input: DebugEventInput) => {
    if (!active) return;
    try {
      sink(input);
    } catch {
      // Diagnostics must never affect a request.
    }
  };

  const metadata = (url: string, method: string): RequestMetadata => {
    let parsed: URL;
    try {
      parsed = new URL(url, window.location.href);
    } catch {
      parsed = new URL('/invalid-request', window.location.href);
    }
    const route = sanitizer.safeRoute(parsed);
    return {
      requestId: `http-${namespace}-${nextRequestId++}`,
      method,
      route,
      sameOrigin: parsed.origin === window.location.origin,
      filterRule: classifyFilter(route),
    };
  };

  const startedInput = (request: RequestMetadata): DebugEventInput => ({
    kind: 'http.started',
    source: 'collector',
    route: request.route,
    details: {
      requestId: request.requestId,
      method: request.method,
      sameOrigin: request.sameOrigin,
      ...(request.filterRule ? { kind: request.filterRule } : {}),
    },
  });

  const flushCoalesced = (rule: string) => {
    const pending = coalesced.get(rule);
    if (!pending) return;
    if (pending.suppressedCount === 0) {
      coalesced.delete(rule);
      return;
    }
    emit({
      ...pending.last,
      details: { ...pending.last.details, phase: 'last' },
    });
    if (pending.suppressedCount > 1) {
      emit({
        kind: 'http.coalesced',
        source: 'collector',
        route: pending.last.route,
        details: {
          kind: rule,
          phase: 'summary',
          suppressedCount: pending.suppressedCount - 1,
        },
      });
    }
    coalesced.delete(rule);
  };

  const completed = (request: RequestMetadata, input: DebugEventInput, success: boolean) => {
    if (!request.filterRule || !success) {
      if (request.filterRule) flushCoalesced(request.filterRule);
      emit(input);
      return;
    }
    const pending = coalesced.get(request.filterRule);
    if (!pending) {
      coalesced.set(request.filterRule, { suppressedCount: 0, last: input });
      emit(input);
      return;
    }
    pending.suppressedCount += 1;
    pending.last = input;
  };

  if (typeof nativeFetch === 'function') {
    wrappedFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const request = metadata(inputUrl(input), inputMethod(input, init));
      const startedAt = performance.now();
      emit(startedInput(request));
      let result: ReturnType<typeof fetch>;
      try {
        result = Reflect.apply(nativeFetch, this, [input, init]);
      } catch (error) {
        const abortReason = abortName(error);
        completed(
          request,
          {
            kind: 'http.completed',
            source: 'collector',
            route: request.route,
            details: {
              requestId: request.requestId,
              method: request.method,
              sameOrigin: request.sameOrigin,
              durationMs: performance.now() - startedAt,
              outcome: abortReason ? 'aborted' : 'network-error',
              ...(abortReason ? { abortReason } : {}),
            },
          },
          false,
        );
        throw error;
      }
      return result.then(
        (response) => {
          completed(
            request,
            {
              kind: 'http.completed',
              source: 'collector',
              route: request.route,
              details: {
                requestId: request.requestId,
                method: request.method,
                sameOrigin: request.sameOrigin,
                durationMs: performance.now() - startedAt,
                outcome: response.ok ? 'success' : 'http-error',
                status: response.status,
                ...(request.filterRule ? { kind: request.filterRule } : {}),
              },
            },
            response.ok,
          );
          return response;
        },
        (error: unknown) => {
          const abortReason = abortName(error);
          completed(
            request,
            {
              kind: 'http.completed',
              source: 'collector',
              route: request.route,
              details: {
                requestId: request.requestId,
                method: request.method,
                sameOrigin: request.sameOrigin,
                durationMs: performance.now() - startedAt,
                outcome: abortReason ? 'aborted' : 'network-error',
                ...(abortReason ? { abortReason } : {}),
                ...(request.filterRule ? { kind: request.filterRule } : {}),
              },
            },
            false,
          );
          throw error;
        },
      );
    };
    window.fetch = wrappedFetch;
  }

  const beginXhr = (xhr: XMLHttpRequest, state: XhrState) => {
    if (state.startedAt !== null) return;
    state.startedAt = performance.now();
    emit(startedInput(state));
    const finalize = () => {
      if (state.finalized) return;
      state.finalized = true;
      state.detach?.();
      const status = Number.isFinite(xhr.status) ? xhr.status : 0;
      const outcome =
        state.outcome === 'pending'
          ? status >= 200 && status < 400
            ? 'success'
            : 'http-error'
          : state.outcome;
      completed(
        state,
        {
          kind: 'http.completed',
          source: 'collector',
          route: state.route,
          details: {
            requestId: state.requestId,
            method: state.method,
            sameOrigin: state.sameOrigin,
            durationMs: performance.now() - (state.startedAt ?? performance.now()),
            outcome,
            status,
            ...(outcome === 'aborted' ? { abortReason: 'abort' } : {}),
            ...(state.filterRule ? { kind: state.filterRule } : {}),
          },
        },
        outcome === 'success',
      );
    };
    const onAbort = () => {
      state.outcome = 'aborted';
      finalize();
    };
    const onError = () => {
      state.outcome = 'network-error';
      finalize();
    };
    const onTimeout = () => {
      state.outcome = 'timeout';
      finalize();
    };
    xhr.addEventListener('abort', onAbort);
    xhr.addEventListener('error', onError);
    xhr.addEventListener('timeout', onTimeout);
    xhr.addEventListener('loadend', finalize);
    state.detach = () => {
      xhr.removeEventListener('abort', onAbort);
      xhr.removeEventListener('error', onError);
      xhr.removeEventListener('timeout', onTimeout);
      xhr.removeEventListener('loadend', finalize);
    };
  };

  if (NativeXhr && nativeOpen && nativeSend && nativeAbort) {
    wrappedOpen = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      const request = metadata(String(url), method.toUpperCase().slice(0, 16));
      xhrStates.set(this, { ...request, startedAt: null, outcome: 'pending', finalized: false });
      return Reflect.apply(nativeOpen, this, [method, url, ...rest] as Parameters<
        typeof nativeOpen
      >);
    } as typeof XMLHttpRequest.prototype.open;
    NativeXhr.prototype.open = wrappedOpen;

    wrappedSend = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const state = xhrStates.get(this);
      if (state) beginXhr(this, state);
      try {
        return Reflect.apply(nativeSend, this, [body]);
      } catch (error) {
        if (state && !state.finalized) {
          state.outcome = abortName(error) ? 'aborted' : 'network-error';
          this.dispatchEvent(new Event('error'));
        }
        throw error;
      }
    };
    NativeXhr.prototype.send = wrappedSend;

    wrappedAbort = function (this: XMLHttpRequest) {
      const state = xhrStates.get(this);
      if (state) {
        state.outcome = 'aborted';
        beginXhr(this, state);
      }
      return Reflect.apply(nativeAbort, this, []);
    };
    NativeXhr.prototype.abort = wrappedAbort;
  }

  return () => {
    if (!active) return;
    for (const rule of [...coalesced.keys()]) flushCoalesced(rule);
    active = false;
    if (wrappedFetch && window.fetch === wrappedFetch && typeof nativeFetch === 'function') {
      window.fetch = nativeFetch;
    }
    if (NativeXhr && nativeOpen && NativeXhr.prototype.open === wrappedOpen) {
      NativeXhr.prototype.open = nativeOpen;
    }
    if (NativeXhr && nativeSend && NativeXhr.prototype.send === wrappedSend) {
      NativeXhr.prototype.send = nativeSend;
    }
    if (NativeXhr && nativeAbort && NativeXhr.prototype.abort === wrappedAbort) {
      NativeXhr.prototype.abort = nativeAbort;
    }
  };
}
