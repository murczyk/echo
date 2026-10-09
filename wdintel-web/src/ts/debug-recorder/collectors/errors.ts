import { createDebugSanitizer } from '../sanitize';
import type {
  DebugCollectorCleanup,
  DebugEventInput,
  DebugEventSink,
  DebugSafeValue,
} from '../types';

function fingerprint(value: string, salt: string): string {
  let hash = 2166136261;
  const saltedValue = `${salt}\u0000${value}`;
  for (let index = 0; index < saltedValue.length; index += 1) {
    hash ^= saltedValue.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `error-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function fingerprintSalt(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

function fingerprintSource(value: unknown, details: Record<string, DebugSafeValue>): string {
  if (typeof value === 'string') return value;
  if (!(value instanceof Error)) return JSON.stringify(details);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const message = descriptors.message?.value;
  const code = descriptors.code?.value;
  return JSON.stringify([
    details.errorClass,
    typeof code === 'string' || typeof code === 'number' ? code : null,
    typeof message === 'string' ? message : null,
  ]);
}

export function attachErrorCollector(sink: DebugEventSink): DebugCollectorCleanup {
  const sanitizer = createDebugSanitizer('error-collector');
  const salt = fingerprintSalt();
  const nativeWarn = console.warn;
  const nativeError = console.error;
  let active = true;

  const emit = (input: DebugEventInput) => {
    if (!active) return;
    try {
      sink(input);
    } catch {
      // Diagnostics must never affect application error handling.
    }
  };

  const safeDetails = (value: unknown): Record<string, DebugSafeValue> => {
    if (value instanceof Error) return sanitizer.safeError(value);
    if (typeof value === 'object' && value !== null) return { errorClass: 'Object' };
    if (typeof value === 'string') {
      return sanitizer.safeError(new Error(value));
    }
    return { errorClass: typeof value };
  };

  const withFingerprint = (value: unknown) => {
    const details = safeDetails(value);
    return { ...details, fingerprint: fingerprint(fingerprintSource(value, details), salt) };
  };

  const onError = (event: Event) => {
    if (event.target instanceof Element && event.target !== document.documentElement) {
      emit({
        kind: 'error.resource',
        source: 'collector',
        target: sanitizer.safeTarget(event.target),
        details: withFingerprint(new Error('resource-load-error')),
      });
      return;
    }
    const error = event instanceof ErrorEvent ? event.error : undefined;
    emit({
      kind: 'error.window',
      source: 'collector',
      details: withFingerprint(error ?? new Error('window-error')),
    });
  };

  const onUnhandledRejection = (event: Event) => {
    const reason =
      typeof PromiseRejectionEvent !== 'undefined' && event instanceof PromiseRejectionEvent
        ? event.reason
        : Object.getOwnPropertyDescriptor(event, 'reason')?.value;
    emit({
      kind: 'error.unhandled-rejection',
      source: 'collector',
      details: withFingerprint(reason),
    });
  };

  const onSecurityPolicyViolation = (event: Event) => {
    const directive =
      typeof SecurityPolicyViolationEvent !== 'undefined' &&
      event instanceof SecurityPolicyViolationEvent
        ? event.effectiveDirective
        : Object.getOwnPropertyDescriptor(event, 'effectiveDirective')?.value;
    emit({
      kind: 'error.csp',
      source: 'collector',
      details: {
        errorClass: 'SecurityPolicyViolation',
        code: typeof directive === 'string' ? directive : 'unknown-directive',
        fingerprint: fingerprint(
          typeof directive === 'string' ? directive : 'unknown-directive',
          salt,
        ),
      },
    });
  };

  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  window.addEventListener('securitypolicyviolation', onSecurityPolicyViolation);

  const wrapConsole = (kind: 'console.warn' | 'console.error', native: typeof console.warn) =>
    function (this: unknown, ...args: unknown[]) {
      Reflect.apply(native, this, args);
      try {
        emit({ kind, source: 'collector', details: withFingerprint(args[0]) });
      } catch {
        // Console calls must stay behaviorally transparent.
      }
    };

  const wrappedWarn = wrapConsole('console.warn', nativeWarn);
  const wrappedError = wrapConsole('console.error', nativeError);
  console.warn = wrappedWarn;
  console.error = wrappedError;

  return () => {
    if (!active) return;
    active = false;
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    window.removeEventListener('securitypolicyviolation', onSecurityPolicyViolation);
    if (console.warn === wrappedWarn) console.warn = nativeWarn;
    if (console.error === wrappedError) console.error = nativeError;
  };
}
