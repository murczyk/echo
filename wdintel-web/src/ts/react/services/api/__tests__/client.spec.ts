/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpRequestError, getJson, tryRunAndReturnNullExceptUnauthorized } from '../client';

describe('api client 401 handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });
  it('redirects 401 responses to login with the current relative url', async () => {
    window.history.replaceState({}, '', '/reports?page=2#summary');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })),
    );

    await expect(getJson('/api/reports')).rejects.toMatchObject({
      name: 'HttpRequestError',
      status: 401,
      message: 'unauthorized',
    });

    expect(window.location.href).toContain('/login?redirect=%2Freports%3Fpage%3D2%23summary');
  });
  it('does not redirect when already on login', async () => {
    window.history.replaceState({}, '', '/login?foo=1#summary');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })),
    );

    await expect(getJson('/api/reports')).rejects.toBeInstanceOf(HttpRequestError);

    expect(window.location.href).toBe(`${window.location.origin}/login?foo=1#summary`);
  });
  it('throws non-401 responses without redirecting', async () => {
    window.history.replaceState({}, '', '/reports?page=2#summary');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('server error', { status: 500 })),
    );

    await expect(getJson('/api/reports')).rejects.toMatchObject({
      name: 'HttpRequestError',
      status: 500,
      message: 'server error',
    });

    expect(window.location.href).toBe(`${window.location.origin}/reports?page=2#summary`);
  });
});
describe('HTTP error messages', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('replaces an HTML gateway response with a concise status message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<!doctype html><html><body>nginx 502 Bad Gateway</body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      ),
    );

    await expect(getJson('/api/reports')).rejects.toMatchObject({
      status: 502,
      message: 'Помилка сервера (502).',
    });
  });

  it.each([undefined, 'application/json'])(
    'recognizes HTML without a correct content type',
    async (contentType) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('  <HTML><body>nginx failure</body></HTML>', {
            status: 502,
            headers: contentType ? { 'content-type': contentType } : undefined,
          }),
        ),
      );

      await expect(getJson('/api/reports')).rejects.toMatchObject({
        status: 502,
        message: 'Помилка сервера (502).',
      });
    },
  );

  it('preserves supported JSON messages and ordinary plain-text HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ detail: 'Деталі помилки' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify('Текстова JSON помилка'), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(new Response('[upstream] Request rejected', { status: 500 }))
        .mockResolvedValueOnce(new Response('"name" must be unique', { status: 500 })),
    );

    await expect(getJson('/api/reports')).rejects.toMatchObject({ message: 'Деталі помилки' });
    await expect(getJson('/api/reports')).rejects.toMatchObject({
      message: 'Текстова JSON помилка',
    });
    await expect(getJson('/api/reports')).rejects.toMatchObject({
      message: '[upstream] Request rejected',
    });
    await expect(getJson('/api/reports')).rejects.toMatchObject({
      message: '"name" must be unique',
    });
  });

  it.each(['{not valid json', ''])(
    'keeps the HTTP status for malformed or empty JSON errors',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(body, {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );

      await expect(getJson('/api/reports')).rejects.toMatchObject({
        status: 503,
        message: 'Помилка сервера (503).',
      });
    },
  );
});

describe('tryRunAndReturnNullExceptUnauthorized', () => {
  it('rethrows unauthorized errors', async () => {
    await expect(
      tryRunAndReturnNullExceptUnauthorized(async () => {
        throw new HttpRequestError(401, 'unauthorized');
      }),
    ).rejects.toMatchObject({
      status: 401,
      message: 'unauthorized',
    });
  });
});
