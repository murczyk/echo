/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpRequestError, getJson, tryRunAndReturnNullExceptUnauthorized } from './client';

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

describe('tryRunAndReturnNullExceptUnauthorized', () => {
  it('returns null for non-401 errors', async () => {
    const result = await tryRunAndReturnNullExceptUnauthorized(async () => {
      throw new HttpRequestError(500, 'server error');
    });

    expect(result).toBeNull();
  });

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
