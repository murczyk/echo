/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadCallsignsCsv, listNetworkCallsignStats } from '../callsigns';

describe('callsigns API', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/sigint/callsigns?filter=alpha#panel');
  });
  it('redirects binary downloads on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })),
    );

    await expect(
      downloadCallsignsCsv({} as Parameters<typeof downloadCallsignsCsv>[0]),
    ).rejects.toMatchObject({
      name: 'HttpRequestError',
      status: 401,
      message: 'unauthorized',
    });

    expect(window.location.href).toContain(
      '/login?redirect=%2Fsigint%2Fcallsigns%3Ffilter%3Dalpha%23panel',
    );
  });

  it('never joins an in-flight stats request', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ network_callsigns: [] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const req = {
      networkId: 42,
      sortBy: null,
      period: 'Last21Days',
      includeActivityInfo: true,
    } as const;

    await Promise.all([listNetworkCallsignStats(req), listNetworkCallsignStats(req)]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
