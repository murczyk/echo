/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addPalitraHighlightBlacklistEntry,
  analyzePalitraKmz,
  deletePalitraHighlightBlacklistEntry,
  fetchPalitraReferenceData,
  getPalitraHighlightBlacklist,
  listPalitras,
  resolvePalitraNames,
} from '../palitra';

describe('palitra API 401 handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/rer/palitras?folder=demo#tools');
  });

  // @test-scope safeguard: prevents an unauthorized palette upload from retaining protected route access
  it('redirects multipart uploads on 401', async () => {
    const file = new File(['kmz'], 'sample.kmz', { type: 'application/vnd.google-earth.kmz' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })),
    );

    await expect(analyzePalitraKmz(file)).rejects.toMatchObject({
      name: 'HttpRequestError',
      status: 401,
      message: 'unauthorized',
    });

    expect(window.location.href).toContain(
      '/login?redirect=%2Frer%2Fpalitras%3Ffolder%3Ddemo%23tools',
    );
  });
});

describe('palitra reference loading', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/rer/palitras?folder=demo#tools');
  });

  // @test-scope safeguard: prevents an ordinary reference-data failure from being handled as an authorization loss
  it('returns null for non-401 reference errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('server error', { status: 500 })),
    );

    await expect(fetchPalitraReferenceData({ roles: [] } as never)).resolves.toMatchObject({
      myScope: null,
      logins: null,
      organismLogins: null,
      organisms: null,
      aors: null,
    });
  });

  // @test-scope safeguard: prevents Rer users from receiving editable login reference data
  it('does not load editable login references for Rer users', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);

        return new Response('{}', { status: 200 });
      }),
    );

    await expect(
      fetchPalitraReferenceData({ roles: ['Rer', 'UnitsEditor'] } as never),
    ).resolves.toMatchObject({
      organismLogins: null,
      logins: null,
      organisms: null,
      aors: null,
    });

    expect(requestedUrls).not.toContain('/api/organism/list-logins');
    expect(requestedUrls).not.toContain('/api/logins');
  });

  // @test-scope safeguard: prevents non-admin users from receiving editable palette reference data
  it('does not load editable palitra references for non-admin users', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requestedUrls.push(String(input));
        return new Response('{}', { status: 200 });
      }),
    );

    await fetchPalitraReferenceData({ roles: ['Basic'] } as never);
    await fetchPalitraReferenceData({ roles: ['UnitsEditor'] } as never);
    await fetchPalitraReferenceData({ roles: ['Rer'] } as never);

    expect(requestedUrls).not.toContain('/api/organism/list-logins');
    expect(requestedUrls).not.toContain('/api/logins');
  });
});

describe('palitra list normalization', () => {
  // @test-scope parser: palette list legacy blacklist-count normalization fixture
  it('accepts the generated blacklist count and defaults older responses to zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ id: 7, name: 'Палітра', highlight_blacklist_count: '3' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(listPalitras()).resolves.toEqual([
      expect.objectContaining({ id: 7, highlightBlacklistCount: 3 }),
    ]);
  });
});

describe('palitra highlight blacklist', () => {
  beforeEach(() => vi.restoreAllMocks());

  // @test-scope parser: palette blacklist response normalization and duplicate-elision fixture
  it('normalizes and deduplicates blacklist entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: '4',
              palitra_id: '42',
              label: ' Точка ',
              created_by_login_id: 'a',
              created_by_login: 'b',
            },
            {
              id: 5,
              palitra_id: 42,
              label: 'точка',
              created_by_login_id: 'c',
              created_by_login: 'd',
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    await expect(getPalitraHighlightBlacklist(42)).resolves.toEqual([
      {
        id: 4,
        palitraId: 42,
        label: 'Точка',
        createdByLoginId: 'a',
        createdByLogin: 'b',
      },
    ]);
  });

  // @test-scope safeguard: prevents blacklist mutations from targeting the wrong palette or source message
  it('uses the atomic add and delete endpoints', async () => {
    const requested: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requested.push({
          url: String(input),
          method: init?.method ?? 'GET',
          body: init?.body as string,
        });
        return new Response(
          JSON.stringify({
            id: 8,
            palitra_id: 42,
            label: 'Точка',
            created_by_login_id: 'a',
            created_by_login: 'b',
          }),
          { status: 200 },
        );
      }),
    );

    await addPalitraHighlightBlacklistEntry(42, 'Точка', 99);
    await deletePalitraHighlightBlacklistEntry(42, 8);

    expect(requested).toEqual([
      {
        url: '/api/palitra/42/highlight-blacklist',
        method: 'POST',
        body: JSON.stringify({ label: 'Точка', source_message_id: 99 }),
      },
      {
        url: '/api/palitra/42/highlight-blacklist/8',
        method: 'DELETE',
        body: undefined,
      },
    ]);
  });

  // @test-scope parser: palette blacklist generated response compatibility fixture
  it('accepts the generated camel-case blacklist response shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 8,
            palitraId: 42,
            label: 'Точка',
            createdByLoginId: 'a',
            createdByLogin: 'b',
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(addPalitraHighlightBlacklistEntry(42, 'Точка', 99)).resolves.toEqual({
      id: 8,
      palitraId: 42,
      label: 'Точка',
      createdByLoginId: 'a',
      createdByLogin: 'b',
    });
  });
});

describe('palitra name resolution', () => {
  beforeEach(() => vi.restoreAllMocks());

  // @test-scope parser: palette name lookup response normalization fixture
  it('preserves valid response items', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ id: 7, name: ' Палітра сім ' }]), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolvePalitraNames([7, 7, 12])).resolves.toEqual([
      { id: 7, name: 'Палітра сім' },
    ]);
  });

  // @test-scope parser: palette name lookup empty and malformed response fixture
  it('rejects malformed response items', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ id: '7', name: 'bad' }]), { status: 200 }),
    );
    await expect(resolvePalitraNames([7])).rejects.toThrow('некоректну назву');
  });
});
