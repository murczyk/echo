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
});
