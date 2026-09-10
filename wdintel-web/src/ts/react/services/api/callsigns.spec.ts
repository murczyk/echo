/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadCallsignsCsv, downloadCallsignsXlsx, listCallsigns } from './callsigns';

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

  it('serializes region and district filters for list and exports', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          new Response(
            url.endsWith('/callsigns')
              ? JSON.stringify({ callsigns: [], show_load_more: false })
              : '',
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      filterUnitArmyRegion: 'R1',
      filterUnitMilitaryDistrict: 'D1',
      filterUnitBrigade: 'BR',
      filterUnitTeamOrCrew: 'T',
    } as Parameters<typeof listCallsigns>[0];

    await listCallsigns(request);
    await downloadCallsignsCsv(request);
    await downloadCallsignsXlsx(request);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, options] of fetchMock.mock.calls) {
      expect(JSON.parse(String(options?.body))).toMatchObject({
        filter_unit_army_region: 'R1',
        filter_unit_military_district: 'D1',
        filter_unit_brigade: 'BR',
        filter_unit_team_or_crew: 'T',
      });
    }
  });
});
