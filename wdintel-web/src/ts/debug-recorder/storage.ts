import {
  DEBUG_MAX_BYTES,
  DEBUG_MAX_EVENTS,
  DEBUG_READY_TTL_MS,
  DEBUG_SCHEMA_VERSION,
  DEBUG_STORAGE_KEY,
} from './config';
import type { DebugEvent, PersistedDebugSession } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isValidEvent(value: unknown): value is DebugEvent {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.seq) &&
    isNonNegativeInteger(value.tMs) &&
    typeof value.kind === 'string' &&
    typeof value.source === 'string' &&
    typeof value.route === 'string'
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidEnvironment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.echoVersion === 'string' &&
    typeof value.deploymentMode === 'string' &&
    typeof value.browserFamily === 'string' &&
    typeof value.browserVersion === 'string' &&
    isFiniteNumber(value.viewportWidth) &&
    isFiniteNumber(value.viewportHeight) &&
    isFiniteNumber(value.devicePixelRatio) &&
    typeof value.startRoute === 'string'
  );
}

function isValidSession(value: unknown, nowMs: number): value is PersistedDebugSession {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== DEBUG_SCHEMA_VERSION) return false;
  if (value.state !== 'recording' && value.state !== 'ready') return false;
  if (typeof value.recordingId !== 'string' || typeof value.aliasSalt !== 'string') return false;
  if (!isFiniteNumber(value.startedAt) || !isFiniteNumber(value.deadlineAt)) return false;
  if (value.deadlineAt <= value.startedAt) return false;
  if (!Array.isArray(value.events) || value.events.length > DEBUG_MAX_EVENTS) return false;
  if (!value.events.every(isValidEvent)) return false;
  if (!isNonNegativeInteger(value.nextSeq)) return false;
  const maximumSequence = value.events.reduce((maximum, event) => Math.max(maximum, event.seq), 0);
  if (value.nextSeq <= maximumSequence) return false;
  if (!isNonNegativeInteger(value.serializedBytes) || value.serializedBytes > DEBUG_MAX_BYTES) {
    return false;
  }
  for (const field of ['droppedEvents', 'rejectedEvents', 'truncatedValues'] as const) {
    if (!isNonNegativeInteger(value[field])) return false;
  }
  if (typeof value.persistenceFailed !== 'boolean') return false;
  if (!isRecord(value.aliases) || !isValidEnvironment(value.environment)) return false;
  if (!isRecord(value.anomalies) || !isNonNegativeInteger(value.anomalies.total)) return false;
  if (!isRecord(value.anomalies.counts)) return false;
  if (!isRecord(value.collectorSupport)) return false;
  if (
    !isStringArray(value.collectorSupport.supported) ||
    !isStringArray(value.collectorSupport.unsupported) ||
    !isStringArray(value.collectorSupport.failed)
  ) {
    return false;
  }
  if (value.state === 'ready') {
    if (!isFiniteNumber(value.readyAt)) return false;
    if (nowMs > value.readyAt + DEBUG_READY_TTL_MS) return false;
  } else if (nowMs > value.deadlineAt + DEBUG_READY_TTL_MS) {
    return false;
  }
  return true;
}

function removeInvalid(storage: Storage): null {
  clearDebugSession(storage);
  return null;
}

export function loadDebugSession(storage: Storage, nowMs: number): PersistedDebugSession | null {
  let raw: string | null;
  try {
    raw = storage.getItem(DEBUG_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  if (new TextEncoder().encode(raw).byteLength > DEBUG_MAX_BYTES) return removeInvalid(storage);
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidSession(parsed, nowMs) ? parsed : removeInvalid(storage);
  } catch {
    return removeInvalid(storage);
  }
}

export function saveDebugSession(storage: Storage, session: PersistedDebugSession): boolean {
  try {
    const serialized = JSON.stringify(session);
    if (new TextEncoder().encode(serialized).byteLength > DEBUG_MAX_BYTES) return false;
    storage.setItem(DEBUG_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

export function clearDebugSession(storage: Storage): void {
  try {
    storage.removeItem(DEBUG_STORAGE_KEY);
  } catch {
    // Storage can be disabled in private or hardened browser contexts.
  }
}
