/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachErrorCollector } from '../errors';
import type { DebugEventInput } from '../../types';

const SECRET = 'ECHO_SECRET_SENTINEL';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('browser error collector', () => {
  it('records bounded window, resource, rejection, worker-visible and CSP errors', () => {
    const events: DebugEventInput[] = [];
    const cleanup = attachErrorCollector((input) => events.push(input));
    const error = new Error(`failed ${SECRET}`);
    error.stack = `Error: failed\n    at render (/app/src/view.ts:10:2)\n    at extension (chrome-extension://${SECRET}/src/x.js:1:1)`;

    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
    window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('worker failed') }));

    const image = document.createElement('img');
    document.body.append(image);
    image.dispatchEvent(new Event('error', { bubbles: true }));

    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new RangeError('rejected') });
    window.dispatchEvent(rejection);

    const csp = new Event('securitypolicyviolation');
    Object.defineProperties(csp, {
      effectiveDirective: { value: 'script-src' },
      blockedURI: {
        get: () => {
          throw new Error('blocked URI read');
        },
      },
    });
    window.dispatchEvent(csp);

    expect(events.map((event) => event.kind)).toEqual([
      'error.window',
      'error.window',
      'error.resource',
      'error.unhandled-rejection',
      'error.csp',
    ]);
    expect(events[0]?.details).toMatchObject({ errorClass: 'Error' });
    expect(events[2]?.target).toMatchObject({ tag: 'img' });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain('chrome-extension');

    cleanup();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('after cleanup') }));
    expect(events).toHaveLength(5);
  });

  it('preserves console receiver and arguments without inspecting arbitrary objects', () => {
    const originalWarn = console.warn;
    const originalError = console.error;
    const warnCalls: Array<{ receiver: unknown; args: unknown[] }> = [];
    const errorCalls: Array<{ receiver: unknown; args: unknown[] }> = [];
    console.warn = function (this: unknown, ...args: unknown[]) {
      warnCalls.push({ receiver: this, args });
    };
    console.error = function (this: unknown, ...args: unknown[]) {
      errorCalls.push({ receiver: this, args });
    };
    const wrappedOriginalWarn = console.warn;
    const wrappedOriginalError = console.error;
    const events: DebugEventInput[] = [];
    const cleanup = attachErrorCollector((input) => events.push(input));
    const opaque = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        throw new Error('getter read');
      },
    });
    const receiver = { console: true };

    Reflect.apply(console.warn, receiver, [opaque, SECRET]);
    Reflect.apply(console.error, receiver, [new TypeError(`bad ${SECRET}`), opaque]);

    expect(warnCalls).toEqual([{ receiver, args: [opaque, SECRET] }]);
    expect(errorCalls).toEqual([{ receiver, args: [expect.any(TypeError), opaque] }]);
    expect(events.map((event) => event.kind)).toEqual(['console.warn', 'console.error']);
    expect(events[0]?.details).toMatchObject({ errorClass: 'Object' });
    expect(events[1]?.details).toMatchObject({ errorClass: 'TypeError' });
    expect(events[0]?.details?.fingerprint).toEqual(expect.any(String));
    expect(JSON.stringify(events)).not.toContain(SECRET);

    cleanup();
    expect(console.warn).toBe(wrappedOriginalWarn);
    expect(console.error).toBe(wrappedOriginalError);
    console.warn = originalWarn;
    console.error = originalError;
  });

  it('fingerprints repeated failures without retaining free-form error text', () => {
    const originalError = console.error;
    console.error = () => {};
    const events: DebugEventInput[] = [];
    const cleanup = attachErrorCollector((input) => events.push(input));
    const operationalText = 'ALPHA-7 reported 149.500 with secret-token';

    console.error(operationalText);
    console.error(operationalText);
    console.error('BRAVO-2 reported 151.250 with another-token');

    expect(events).toHaveLength(3);
    expect(events[0]?.details?.message).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain('ALPHA-7');
    expect(JSON.stringify(events)).not.toContain('149.500');
    expect(JSON.stringify(events)).not.toContain('secret-token');
    expect(events[0]?.details?.fingerprint).toBe(events[1]?.details?.fingerprint);
    expect(events[0]?.details?.fingerprint).not.toBe(events[2]?.details?.fingerprint);

    cleanup();
    console.error = originalError;
  });

  it('restores exact console functions after repeated attach cycles', () => {
    const originalWarn = console.warn;
    const originalError = console.error;
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const events: DebugEventInput[] = [];
      const cleanup = attachErrorCollector((input) => events.push(input));
      console.warn('one warning');
      cleanup();
      expect(events).toHaveLength(1);
      expect(console.warn).toBe(originalWarn);
      expect(console.error).toBe(originalError);
    }
  });
});
