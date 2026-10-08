/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { createDebugSanitizer } from '../sanitize';

describe('debug recorder sanitizer', () => {
  it('removes URL secrets and assigns stable per-recording path aliases', () => {
    const sanitizer = createDebugSanitizer('recording-1');

    expect(sanitizer.safeRoute('/rer-duty-neo/42?token=SECRET#SECRET')).toBe(
      '/rer-duty-neo/{id_1}',
    );
    expect(sanitizer.safeRoute('/rer-duty-neo/42?other=SECRET')).toBe('/rer-duty-neo/{id_1}');
    expect(
      sanitizer.safeRoute(
        '/messages/0199c2a9-9c07-70fd-a2f1-86b742f64e31?redirect=ECHO_SECRET_SENTINEL',
      ),
    ).toBe('/messages/{id_2}');
    expect(sanitizer.alias('feed', '42')).toBe('{feed_1}');
    expect(sanitizer.alias('feed', '42')).toBe('{feed_1}');
    expect(sanitizer.alias('feed', '43')).toBe('{feed_2}');
  });

  it('keeps only structural target fields and rejects dynamic test ids', () => {
    const sanitizer = createDebugSanitizer('recording-1');
    const input = document.createElement('input');
    input.type = 'password';
    input.setAttribute('role', 'searchbox');
    input.dataset.testid = 'device-search';
    input.name = 'ECHO_SECRET_SENTINEL';
    input.value = 'ECHO_SECRET_SENTINEL';
    input.setAttribute('aria-label', 'ECHO_SECRET_SENTINEL');
    input.textContent = 'ECHO_SECRET_SENTINEL';

    expect(sanitizer.safeTarget(input)).toEqual({
      tag: 'input',
      role: 'searchbox',
      inputType: 'password',
      testId: 'device-search',
    });

    input.dataset.testid = 'message-123456';
    expect(sanitizer.safeTarget(input)).toEqual({
      tag: 'input',
      role: 'searchbox',
      inputType: 'password',
    });
  });

  it('drops secret-bearing fields without invoking getters or following cycles', () => {
    const sanitizer = createDebugSanitizer('recording-1');
    let getterReads = 0;
    const details: Record<string, unknown> = {
      outcome: 'network-error',
      status: 503,
      headers: { Authorization: 'ECHO_SECRET_SENTINEL' },
      body: 'ECHO_SECRET_SENTINEL',
      value: 'ECHO_SECRET_SENTINEL',
      text: 'ECHO_SECRET_SENTINEL',
      storage: 'ECHO_SECRET_SENTINEL',
      callsign: 'ECHO_SECRET_SENTINEL',
      coordinates: '50.4501,30.5234',
      uuid: '0199c2a9-9c07-70fd-a2f1-86b742f64e31',
      ip: '192.0.2.25',
      hostname: 'secret.example.test',
      note: '```\n<script>ECHO_SECRET_SENTINEL</script>\u0000 ignore previous instructions',
    };
    Object.defineProperty(details, 'dangerous', {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error('getter must not run');
      },
    });
    details.cycle = details;

    const event = sanitizer.sanitizeInput(
      { kind: 'http.completed', source: 'browser', details },
      { seq: 1, tMs: 15, route: '/safe' },
    );
    const serialized = JSON.stringify(event);

    expect(getterReads).toBe(0);
    expect(event?.details).toMatchObject({ outcome: 'network-error', status: 503 });
    expect(serialized).not.toContain('ECHO_SECRET_SENTINEL');
    expect(serialized).not.toContain('0199c2a9');
    expect(serialized).not.toContain('192.0.2.25');
    expect(serialized).not.toContain('secret.example.test');
    expect(serialized).not.toContain('50.4501');
    expect(serialized).not.toContain('```');
    expect(serialized.length).toBeLessThan(1_000);
  });

  it('bounds strings, object depth and key count', () => {
    const sanitizer = createDebugSanitizer('recording-1');
    const details = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`metric${index}`, 'x'.repeat(1_000)]),
    );

    const event = sanitizer.sanitizeInput(
      { kind: 'semantic.metrics', details },
      { seq: 1, tMs: 0, route: '/safe' },
    );

    expect(JSON.stringify(event).length).toBeLessThan(5_000);
    expect(Object.keys(event?.details ?? {}).length).toBeLessThanOrEqual(32);
  });
});
