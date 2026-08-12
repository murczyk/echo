/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addPalitraHighlightBlacklistEntry,
  analyzePalitraKmz,
  deletePalitraHighlightBlacklistEntry,
  downloadPalitras,
  fetchPalitraReferenceData,
  getPalitraHighlightBlacklist,
  listPalitras,
  resolvePalitraNames,
} from './palitra';

describe('palitra API 401 handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/rer/palitras?folder=demo#tools');
  });

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

describe('palitra downloads', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the Delta split endpoint when requested', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requestedUrls.push(String(input));
        return new Response(new Blob(['zip']), { status: 200 });
      }),
    );

    await downloadPalitras([42], { splitForDelta: true });

    expect(requestedUrls).toEqual(['/api/palitra/download-delta-split']);
  });
});

describe('palitra highlight blacklist', () => {
  beforeEach(() => vi.restoreAllMocks());

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

    await addPalitraHighlightBlacklistEntry(42, 'Точка');
    await deletePalitraHighlightBlacklistEntry(42, 8);

    expect(requested).toEqual([
      {
        url: '/api/palitra/42/highlight-blacklist',
        method: 'POST',
        body: JSON.stringify({ label: 'Точка' }),
      },
      {
        url: '/api/palitra/42/highlight-blacklist/8',
        method: 'DELETE',
        body: undefined,
      },
    ]);
  });

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

    await expect(addPalitraHighlightBlacklistEntry(42, 'Точка')).resolves.toEqual({
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

  it('deduplicates IDs and preserves valid response items', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([{ id: 7, name: ' Палітра сім ' }]), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolvePalitraNames([7, 7, 12])).resolves.toEqual([
      { id: 7, name: 'Палітра сім' },
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ palitra_ids: [7, 12] });
  });

  it('does not request empty IDs and rejects malformed items', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(resolvePalitraNames([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ id: '7', name: 'bad' }]), { status: 200 }),
    );
    await expect(resolvePalitraNames([7])).rejects.toThrow('некоректну назву');
  });
});
