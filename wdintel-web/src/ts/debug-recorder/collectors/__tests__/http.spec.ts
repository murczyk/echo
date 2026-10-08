/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachHttpCollector } from '../http';
import type { DebugEventInput } from '../../types';

const SECRET = 'ECHO_SECRET_SENTINEL';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HTTP collector', () => {
  it('preserves fetch behavior and records only structural request metadata', async () => {
    const response = new Response('stream-secret', { status: 201 });
    const body = response.body;
    const receiver = { name: 'receiver' };
    const calls: Array<{ receiver: unknown; args: unknown[] }> = [];
    const nativeFetch = window.fetch;
    const original = function (this: unknown, ...args: unknown[]) {
      calls.push({ receiver: this, args });
      return Promise.resolve(response);
    } as typeof fetch;
    window.fetch = original;
    const events: DebugEventInput[] = [];
    const cleanup = attachHttpCollector((input) => events.push(input));
    const request = new Request(`https://example.com/api/messages/42?token=${SECRET}#${SECRET}`, {
      method: 'POST',
      headers: { Authorization: SECRET },
      body: SECRET,
    });
    const init = Object.defineProperties(
      { method: 'PATCH' },
      {
        headers: {
          get: () => {
            throw new Error('headers read');
          },
        },
        body: {
          get: () => {
            throw new Error('body read');
          },
        },
      },
    );

    const result = await Reflect.apply(window.fetch, receiver, [request, init]);

    expect(result).toBe(response);
    expect(result.body).toBe(body);
    expect(calls).toEqual([{ receiver, args: [request, init] }]);
    expect(events.map((event) => event.kind)).toEqual(['http.started', 'http.completed']);
    expect(events[0]).toMatchObject({
      route: '/api/messages/{id_1}',
      details: { method: 'PATCH', sameOrigin: false },
    });
    expect(events[1]).toMatchObject({
      route: '/api/messages/{id_1}',
      details: { method: 'PATCH', outcome: 'success', status: 201 },
    });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain('example.com');
    expect(JSON.stringify(events)).not.toContain('token=');

    cleanup();
    expect(window.fetch).toBe(original);
    window.fetch = nativeFetch;
  });

  it('preserves rejection identity and classifies aborts without consuming request data', async () => {
    const rejection = new DOMException('secret abort', 'AbortError');
    const nativeFetch = window.fetch;
    const original = vi.fn(() => Promise.reject(rejection)) as unknown as typeof fetch;
    window.fetch = original;
    const events: DebugEventInput[] = [];
    const cleanup = attachHttpCollector((input) => events.push(input));

    await expect(
      window.fetch(`/api/save?secret=${SECRET}`, { signal: new AbortController().signal }),
    ).rejects.toBe(rejection);
    expect(events.at(-1)).toMatchObject({
      kind: 'http.completed',
      route: '/api/save',
      details: { outcome: 'aborted', abortReason: 'AbortError' },
    });

    cleanup();
    window.fetch = nativeFetch;
  });

  it('preserves XHR callbacks, status, response and abort while restoring exact methods', () => {
    class FakeXhr extends EventTarget {
      status = 204;
      method = '';
      url = '';
      sentBody: unknown;

      get response(): never {
        throw new Error('response read');
      }

      open(method: string, url: string): void {
        this.method = method;
        this.url = url;
      }

      send(body?: Document | XMLHttpRequestBodyInit | null): void {
        this.sentBody = body;
        this.dispatchEvent(new Event('loadend'));
      }

      abort(): void {
        this.dispatchEvent(new Event('abort'));
        this.dispatchEvent(new Event('loadend'));
      }
    }

    const NativeXhr = window.XMLHttpRequest;
    window.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const originalOpen = FakeXhr.prototype.open;
    const originalSend = FakeXhr.prototype.send;
    const originalAbort = FakeXhr.prototype.abort;
    const events: DebugEventInput[] = [];
    const cleanup = attachHttpCollector((input) => events.push(input));
    const xhr = new XMLHttpRequest() as unknown as FakeXhr;
    const onLoadEnd = vi.fn();
    xhr.addEventListener('loadend', onLoadEnd);

    xhr.open('PUT', `/api/messages/42?token=${SECRET}#fragment`);
    xhr.send(SECRET);

    expect(onLoadEnd).toHaveBeenCalledOnce();
    expect(xhr.status).toBe(204);
    expect(xhr.sentBody).toBe(SECRET);
    expect(events.map((event) => event.kind)).toEqual(['http.started', 'http.completed']);
    expect(JSON.stringify(events)).not.toContain(SECRET);

    const aborted = new XMLHttpRequest() as unknown as FakeXhr;
    aborted.open('GET', '/api/abort');
    aborted.abort();
    expect(events.at(-1)).toMatchObject({
      kind: 'http.completed',
      details: { outcome: 'aborted' },
    });

    cleanup();
    expect(FakeXhr.prototype.open).toBe(originalOpen);
    expect(FakeXhr.prototype.send).toBe(originalSend);
    expect(FakeXhr.prototype.abort).toBe(originalAbort);
    window.XMLHttpRequest = NativeXhr;
  });

  it('coalesces named high-volume successes and survives repeated attach cycles', async () => {
    const nativeFetch = window.fetch;
    const response = new Response(null, { status: 200 });
    const original = vi.fn(() => Promise.resolve(response)) as unknown as typeof fetch;
    window.fetch = original;

    const events: DebugEventInput[] = [];
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const cleanup = attachHttpCollector((input) => events.push(input));
      await window.fetch('/api/event-stream/long-poll');
      await window.fetch('/api/event-stream/long-poll');
      await window.fetch('/api/event-stream/long-poll');
      cleanup();
      expect(window.fetch).toBe(original);
    }

    expect(events.filter((event) => event.kind === 'http.completed')).toHaveLength(4);
    expect(events.filter((event) => event.kind === 'http.coalesced')).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'http.coalesced')[0]).toMatchObject({
      details: { kind: 'event-stream-long-poll', suppressedCount: 1 },
    });
    window.fetch = nativeFetch;
  });
});
