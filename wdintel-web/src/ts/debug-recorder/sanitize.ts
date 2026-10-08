import {
  DEBUG_IDENTIFIER_DETAIL_KEYS,
  DEBUG_MAX_ARRAY_LENGTH,
  DEBUG_MAX_OBJECT_DEPTH,
  DEBUG_MAX_OBJECT_KEYS,
  DEBUG_MAX_STRING_LENGTH,
  DEBUG_SAFE_DETAIL_KEYS,
} from './config';
import type {
  DebugAliasTable,
  DebugEvent,
  DebugEventContext,
  DebugEventInput,
  DebugSafeValue,
  DebugSanitizer,
  DebugTarget,
  PersistedDebugSession,
} from './types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DYNAMIC_PATH_PATTERN = /^(?:\d+|[0-9a-f]{16,})$/i;
const SAFE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/i;
const SAFE_TEST_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const DYNAMIC_TEST_ID_PATTERN = /(?:\d{4,}|[0-9a-f]{8}-[0-9a-f-]{20,})/i;
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/gi;
const UUID_IN_TEXT_PATTERN = /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi;
const IP_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const COORDINATE_PATTERN = /\b-?\d{1,3}\.\d{3,}\s*[,;]\s*-?\d{1,3}\.\d{3,}\b/g;
const SECRET_MARKER_PATTERN = /\bECHO_SECRET_SENTINEL\b/gi;

function normalizeToken(value: unknown, fallback = 'unknown'): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().slice(0, 80);
  return SAFE_TOKEN_PATTERN.test(normalized) ? normalized : fallback;
}

function normalizeString(value: string): { value: string; truncated: boolean } {
  const withoutSensitiveValues = value
    .replace(URL_PATTERN, '[redacted-url]')
    .replace(UUID_IN_TEXT_PATTERN, '[redacted-id]')
    .replace(IP_PATTERN, '[redacted-ip]')
    .replace(COORDINATE_PATTERN, '[redacted-coordinate]')
    .replace(SECRET_MARKER_PATTERN, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/`/g, "'")
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    value: withoutSensitiveValues.slice(0, DEBUG_MAX_STRING_LENGTH),
    truncated: withoutSensitiveValues.length > DEBUG_MAX_STRING_LENGTH,
  };
}

function isElement(value: unknown): value is Element {
  return typeof Element !== 'undefined' && value instanceof Element;
}

function copyAliases(aliases: DebugAliasTable): DebugAliasTable {
  return Object.fromEntries(
    Object.entries(aliases).map(([scope, entries]) => [scope, { ...entries }]),
  );
}

export function createDebugSanitizer(recordingId: string): DebugSanitizer {
  const aliases: DebugAliasTable = {};
  let truncatedValues = 0;

  const alias = (scopeValue: string, rawValue: string | number): string => {
    const scope = normalizeToken(scopeValue, 'id').replace(/[.:]/g, '_');
    const raw = String(rawValue);
    const scopeAliases = (aliases[scope] ??= {});
    const existing = scopeAliases[raw];
    if (existing) return existing;
    const next = `{${scope}_${Object.keys(scopeAliases).length + 1}}`;
    scopeAliases[raw] = next;
    return next;
  };

  const safeRoute = (value: string | URL): string => {
    try {
      const url = value instanceof URL ? value : new URL(value, 'https://echo.invalid');
      const safeSegments = url.pathname.split('/').map((segment) => {
        let decoded = segment;
        try {
          decoded = decodeURIComponent(segment);
        } catch {
          return '{invalid}';
        }
        if (UUID_PATTERN.test(decoded) || DYNAMIC_PATH_PATTERN.test(decoded)) {
          return alias('id', decoded);
        }
        const normalized = normalizeString(decoded).value;
        return normalized.replace(/[^a-z0-9._~{}-]/gi, '-').slice(0, 80);
      });
      return safeSegments.join('/') || '/';
    } catch {
      return '/invalid-route';
    }
  };

  const safeTarget = (
    value: DebugTarget | EventTarget | null | undefined,
  ): DebugTarget | undefined => {
    if (value == null) return undefined;
    if (isElement(value)) {
      const target: DebugTarget = { tag: value.tagName.toLowerCase() };
      const role = value.getAttribute('role');
      if (role && SAFE_TOKEN_PATTERN.test(role)) target.role = role.slice(0, 40);
      if (value instanceof HTMLInputElement) {
        target.inputType = normalizeToken(value.type, 'text');
      }
      const testId = value.getAttribute('data-testid');
      if (testId && SAFE_TEST_ID_PATTERN.test(testId) && !DYNAMIC_TEST_ID_PATTERN.test(testId)) {
        target.testId = testId;
      }
      return target;
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const tag = descriptors.tag?.value;
    if (typeof tag !== 'string') return undefined;
    const target: DebugTarget = { tag: normalizeToken(tag) };
    const role = descriptors.role?.value;
    if (typeof role === 'string') target.role = normalizeToken(role);
    const inputType = descriptors.inputType?.value;
    if (typeof inputType === 'string') target.inputType = normalizeToken(inputType);
    const testId = descriptors.testId?.value;
    if (
      typeof testId === 'string' &&
      SAFE_TEST_ID_PATTERN.test(testId) &&
      !DYNAMIC_TEST_ID_PATTERN.test(testId)
    ) {
      target.testId = testId;
    }
    return target;
  };

  const sanitizeValue = (
    value: unknown,
    key: string,
    depth: number,
    seen: WeakSet<object>,
  ): DebugSafeValue | undefined => {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
      if (DEBUG_IDENTIFIER_DETAIL_KEYS.has(key))
        return alias(key.replace(/Id$/, '') || 'id', value);
      const normalized = normalizeString(value);
      if (normalized.truncated) truncatedValues += 1;
      return normalized.value;
    }
    if (depth >= DEBUG_MAX_OBJECT_DEPTH || typeof value !== 'object') return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
      const result = value
        .slice(0, DEBUG_MAX_ARRAY_LENGTH)
        .map((item) => sanitizeValue(item, key, depth + 1, seen))
        .filter((item): item is DebugSafeValue => item !== undefined);
      seen.delete(value);
      return result;
    }

    const result: Record<string, DebugSafeValue> = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    let copied = 0;
    for (const [childKey, descriptor] of Object.entries(descriptors)) {
      if (copied >= DEBUG_MAX_OBJECT_KEYS) break;
      if (!('value' in descriptor)) continue;
      if (!DEBUG_SAFE_DETAIL_KEYS.has(childKey) && !DEBUG_IDENTIFIER_DETAIL_KEYS.has(childKey)) {
        continue;
      }
      const child = sanitizeValue(descriptor.value, childKey, depth + 1, seen);
      if (child === undefined) continue;
      result[childKey] = child;
      copied += 1;
    }
    seen.delete(value);
    return result;
  };

  const safeError = (value: unknown): Record<string, DebugSafeValue> => {
    if (typeof value !== 'object' || value === null) return { errorClass: typeof value };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const name = normalizeToken(descriptors.name?.value, 'Error');
    const result: Record<string, DebugSafeValue> = { errorClass: name };
    const code = descriptors.code?.value;
    if (typeof code === 'string' || typeof code === 'number') {
      result.code = normalizeString(String(code)).value;
    }
    const message = descriptors.message?.value;
    if (typeof message === 'string') result.message = normalizeString(message).value;
    const stack = descriptors.stack?.value;
    if (typeof stack === 'string') {
      const frames = stack
        .split('\n')
        .slice(1)
        .filter((line) => /(?:\/src\/|webpack|vite)/.test(line))
        .slice(0, 8)
        .map((line) => normalizeString(line).value);
      if (frames.length > 0) result.frames = frames;
    }
    return result;
  };

  const sanitizeInput = (input: DebugEventInput, context: DebugEventContext): DebugEvent | null => {
    const kind = normalizeToken(input.kind, 'unknown');
    if (kind === 'unknown') return null;
    const event: DebugEvent = {
      seq: Math.max(0, Math.trunc(context.seq)),
      tMs: Math.max(0, Math.round(context.tMs)),
      kind,
      source: normalizeToken(input.source, 'semantic'),
      route: safeRoute(context.route),
    };
    const target = safeTarget(input.target);
    if (target) event.target = target;
    if (input.details) {
      const details = sanitizeValue(input.details, 'details', 0, new WeakSet());
      if (details && !Array.isArray(details) && typeof details === 'object') {
        if (Object.keys(details).length > 0) event.details = details;
      }
    }
    return event;
  };

  const sanitizeSessionForExport = (session: PersistedDebugSession): PersistedDebugSession => {
    const safeEvents = session.events
      .map((event) =>
        sanitizeInput(
          {
            kind: event.kind,
            source: event.source,
            target: event.target,
            details: event.details,
          },
          { seq: event.seq, tMs: event.tMs, route: event.route },
        ),
      )
      .filter((event): event is DebugEvent => event !== null);
    const safeCounts = Object.fromEntries(
      Object.entries(session.anomalies.counts)
        .slice(0, DEBUG_MAX_OBJECT_KEYS)
        .map(([kind, count]) => [normalizeToken(kind), Math.max(0, Math.trunc(count))]),
    );
    const safeSupport = (values: string[]) =>
      values.slice(0, DEBUG_MAX_ARRAY_LENGTH).map((value) => normalizeToken(value));
    return {
      ...session,
      recordingId: normalizeToken(session.recordingId, 'recording'),
      events: safeEvents,
      aliases: {},
      truncatedValues: Math.max(session.truncatedValues, truncatedValues),
      environment: {
        ...session.environment,
        echoVersion: normalizeString(session.environment.echoVersion).value,
        deploymentMode: normalizeToken(session.environment.deploymentMode),
        browserFamily: session.environment.browserFamily,
        browserVersion: normalizeToken(session.environment.browserVersion),
        startRoute: safeRoute(session.environment.startRoute),
      },
      anomalies: {
        total: Math.max(0, Math.trunc(session.anomalies.total)),
        counts: safeCounts,
      },
      collectorSupport: {
        supported: safeSupport(session.collectorSupport.supported),
        unsupported: safeSupport(session.collectorSupport.unsupported),
        failed: safeSupport(session.collectorSupport.failed),
      },
    };
  };

  return {
    safeRoute,
    safeTarget,
    safeError,
    sanitizeInput,
    alias,
    sanitizeSessionForExport,
    getAliases: () => copyAliases(aliases),
  };
}
