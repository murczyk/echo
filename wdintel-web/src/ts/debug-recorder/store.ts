import {
  DEBUG_MAX_BYTES,
  DEBUG_MAX_EVENTS,
  DEBUG_PERSIST_DEBOUNCE_MS,
  DEBUG_READY_TTL_MS,
  DEBUG_RECORDING_MS,
  DEBUG_SCHEMA_VERSION,
} from './config';
import {
  buildDebugMarkdown,
  collectDebugEnvironment,
  downloadDebugMarkdown,
} from './export-markdown';
import { createDebugSanitizer } from './sanitize';
import { clearDebugSession, loadDebugSession, saveDebugSession } from './storage';
import type {
  DebugBuildMetadata,
  DebugEnvironment,
  DebugEventInput,
  DebugRecorderSnapshot,
  DebugSanitizer,
  PersistedDebugSession,
} from './types';

export type DebugRecorderDependencies = {
  storage?: Storage | null;
  now?: () => number;
  createRecordingId?: () => string;
  createAliasSalt?: () => string;
  collectEnvironment?: (metadata: DebugBuildMetadata) => DebugEnvironment;
  getRoute?: () => string;
  buildMarkdown?: (session: PersistedDebugSession) => string;
  downloadMarkdown?: (markdown: string, startedAt: number) => boolean;
};

export type BrowserDebugRecorder = {
  configure: (metadata: DebugBuildMetadata) => void;
  start: () => void;
  finish: () => void;
  download: () => boolean;
  record: (input: DebugEventInput) => void;
  flush: () => void;
  aliasIdentifier: (scope: string, value: string | number) => string | null;
  clear: () => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => DebugRecorderSnapshot;
};

function browserStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function randomToken(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function serializedByteLength(session: PersistedDebugSession): number {
  session.serializedBytes = 0;
  let size = new TextEncoder().encode(JSON.stringify(session)).byteLength;
  session.serializedBytes = size;
  size = new TextEncoder().encode(JSON.stringify(session)).byteLength;
  session.serializedBytes = size;
  return size;
}

export function createBrowserDebugRecorder(
  dependencies: DebugRecorderDependencies = {},
): BrowserDebugRecorder {
  const storage = dependencies.storage === undefined ? browserStorage() : dependencies.storage;
  const now = dependencies.now ?? Date.now;
  const createRecordingId = dependencies.createRecordingId ?? randomToken;
  const createAliasSalt = dependencies.createAliasSalt ?? randomToken;
  const environmentCollector = dependencies.collectEnvironment ?? collectDebugEnvironment;
  const getRoute = dependencies.getRoute ?? (() => globalThis.location?.href ?? '/');
  const markdownBuilder = dependencies.buildMarkdown ?? buildDebugMarkdown;
  const markdownDownloader = dependencies.downloadMarkdown ?? downloadDebugMarkdown;
  const listeners = new Set<() => void>();

  let metadata: DebugBuildMetadata = { echoVersion: 'unknown', deploymentMode: 'unknown' };
  let session: PersistedDebugSession | null = null;
  let sanitizer: DebugSanitizer | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let readyExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  let persistenceTimer: ReturnType<typeof setTimeout> | null = null;
  let downloadError = false;

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Recorder subscribers cannot be allowed to affect product behavior.
      }
    }
  };

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer !== null) clearTimeout(timer);
  };

  const clearTimers = () => {
    clearTimer(deadlineTimer);
    clearTimer(readyExpiryTimer);
    clearTimer(persistenceTimer);
    deadlineTimer = null;
    readyExpiryTimer = null;
    persistenceTimer = null;
  };

  const enforceEventCount = () => {
    if (!session || session.events.length <= DEBUG_MAX_EVENTS) return;
    const overflow = session.events.length - DEBUG_MAX_EVENTS;
    session.events.splice(0, overflow);
    session.droppedEvents += overflow;
  };

  const updateSizeAndEvict = () => {
    if (!session) return;
    enforceEventCount();
    if (serializedByteLength(session) <= DEBUG_MAX_BYTES) return;

    const events = session.events;
    const droppedEvents = session.droppedEvents;
    let minimum = 1;
    let maximum = events.length;
    while (minimum < maximum) {
      const removed = Math.floor((minimum + maximum) / 2);
      session.events = events.slice(removed);
      session.droppedEvents = droppedEvents + removed;
      if (serializedByteLength(session) <= DEBUG_MAX_BYTES) maximum = removed;
      else minimum = removed + 1;
    }

    session.events = events.slice(minimum);
    session.droppedEvents = droppedEvents + minimum;
    serializedByteLength(session);
  };

  const flush = () => {
    clearTimer(persistenceTimer);
    persistenceTimer = null;
    if (!session || !storage) return;
    updateSizeAndEvict();
    if (saveDebugSession(storage, session)) return;
    if (!session.persistenceFailed) {
      session.persistenceFailed = true;
      updateSizeAndEvict();
      emit();
    }
  };

  const schedulePersistence = () => {
    if (!session || !storage || persistenceTimer !== null) return;
    persistenceTimer = setTimeout(flush, DEBUG_PERSIST_DEBOUNCE_MS);
  };

  const clear = () => {
    const changed = session !== null || downloadError;
    clearTimers();
    session = null;
    sanitizer = null;
    downloadError = false;
    if (storage) clearDebugSession(storage);
    if (changed) emit();
  };

  const scheduleReadyExpiry = () => {
    clearTimer(readyExpiryTimer);
    readyExpiryTimer = null;
    if (!session || session.state !== 'ready' || session.readyAt == null) return;
    const remaining = session.readyAt + DEBUG_READY_TTL_MS - now();
    if (remaining <= 0) {
      clear();
      return;
    }
    readyExpiryTimer = setTimeout(clear, remaining);
  };

  const transitionReady = (readyAt: number) => {
    if (!session || session.state !== 'recording') return;
    clearTimer(deadlineTimer);
    deadlineTimer = null;
    session.state = 'ready';
    session.readyAt = readyAt;
    flush();
    scheduleReadyExpiry();
    emit();
  };

  const scheduleDeadline = () => {
    clearTimer(deadlineTimer);
    deadlineTimer = null;
    if (!session || session.state !== 'recording') return;
    const remaining = session.deadlineAt - now();
    if (remaining <= 0) {
      transitionReady(session.deadlineAt);
      return;
    }
    deadlineTimer = setTimeout(() => {
      if (session?.state === 'recording') transitionReady(session.deadlineAt);
    }, remaining);
  };

  const restore = () => {
    if (!storage) return;
    session = loadDebugSession(storage, now());
    if (!session) return;
    sanitizer = createDebugSanitizer(session.recordingId, {
      aliasSalt: session.aliasSalt,
      aliases: session.aliases,
    });
    if (session.state === 'recording') {
      if (now() >= session.deadlineAt) transitionReady(session.deadlineAt);
      else scheduleDeadline();
    } else {
      scheduleReadyExpiry();
    }
  };

  restore();

  const start = () => {
    if (session) return;
    const startedAt = now();
    const recordingId = createRecordingId();
    const aliasSalt = createAliasSalt();
    sanitizer = createDebugSanitizer(recordingId, { aliasSalt });
    session = {
      schemaVersion: DEBUG_SCHEMA_VERSION,
      state: 'recording',
      recordingId,
      aliasSalt,
      startedAt,
      deadlineAt: startedAt + DEBUG_RECORDING_MS,
      nextSeq: 1,
      events: [],
      serializedBytes: 0,
      droppedEvents: 0,
      rejectedEvents: 0,
      truncatedValues: 0,
      persistenceFailed: false,
      aliases: {},
      environment: environmentCollector(metadata),
      anomalies: { total: 0, counts: {} },
      collectorSupport: { supported: [], unsupported: [], failed: [] },
    };
    downloadError = false;
    updateSizeAndEvict();
    flush();
    scheduleDeadline();
    emit();
  };

  const record = (input: DebugEventInput) => {
    if (!session || session.state !== 'recording' || !sanitizer) return;
    const atMs = now();
    if (atMs >= session.deadlineAt) {
      transitionReady(session.deadlineAt);
      return;
    }
    const event = sanitizer.sanitizeInput(input, {
      seq: session.nextSeq,
      tMs: atMs - session.startedAt,
      route: getRoute(),
    });
    if (!event) {
      session.rejectedEvents += 1;
      schedulePersistence();
      emit();
      return;
    }
    session.nextSeq += 1;
    session.events.push(event);
    session.aliases = sanitizer.getAliases();
    enforceEventCount();
    schedulePersistence();
    emit();
  };

  const getSnapshot = (): DebugRecorderSnapshot => {
    if (!session) {
      return {
        state: 'idle',
        recordingId: null,
        startedAt: null,
        deadlineAt: null,
        elapsedMs: 0,
        eventCount: 0,
        droppedEvents: 0,
        anomalyCount: 0,
        persistenceFailed: false,
        downloadError: false,
      };
    }
    const finishedAt = session.readyAt ?? Math.min(now(), session.deadlineAt);
    return {
      state: session.state,
      recordingId: session.recordingId,
      startedAt: session.startedAt,
      deadlineAt: session.deadlineAt,
      elapsedMs: Math.max(0, finishedAt - session.startedAt),
      eventCount: session.events.length,
      droppedEvents: session.droppedEvents,
      anomalyCount: session.anomalies.total,
      persistenceFailed: session.persistenceFailed,
      downloadError,
    };
  };

  return {
    configure: (nextMetadata) => {
      metadata = { ...nextMetadata };
    },
    start,
    finish: () => transitionReady(now()),
    download: () => {
      if (!session || session.state !== 'ready') return false;
      try {
        const downloaded = markdownDownloader(markdownBuilder(session), session.startedAt);
        if (!downloaded) {
          downloadError = true;
          emit();
          return false;
        }
        clear();
        return true;
      } catch {
        downloadError = true;
        emit();
        return false;
      }
    },
    record,
    flush,
    aliasIdentifier: (scope, value) => {
      if (!session || !sanitizer) return null;
      const result = sanitizer.alias(scope, value);
      session.aliases = sanitizer.getAliases();
      schedulePersistence();
      return result;
    },
    clear,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot,
  };
}
