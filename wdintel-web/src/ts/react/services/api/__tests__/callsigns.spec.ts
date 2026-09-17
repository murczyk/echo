/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadCallsignsCsv } from '../callsigns';

describe('callsigns API', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/sigint/callsigns?filter=alpha#panel');
  });

  // @test-scope safeguard: prevents unauthorized binary downloads from leaving users on a protected route
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
});
