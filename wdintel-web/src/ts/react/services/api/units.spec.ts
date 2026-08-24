/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Unit } from '../../../../Bindings';

import {
  createDeviceNetwork,
  DEFAULT_LIST_UNITS_REQ,
  deleteUnitAttachment,
  getCreateUnitDuplicateCandidates,
  getAllUnitsList,
  getUnitsPage,
  getUnitDetails,
  getUnitIdsWithVisibleAttachments,
  getUnitNameReviews,
  getUnitStatusCounts,
  getUnitsList,
  importOrbitUnit,
  mergeUnitsById,
  searchUnitsStrictThenRelaxed,
  searchOrbitUnits,
  updateUnitAttachment,
  uploadUnitAttachment,
} from './units';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('units API', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('merges explicitly resolved units without duplicating active units', () => {
    const active = { id: 1, name: 'Active' } as Unit;
    const inactive = { id: 2, name: 'Inactive', active: false } as Unit;

    expect(mergeUnitsById([active], [active, inactive])).toEqual([active, inactive]);
  });

  it('returns strict unit matches before deduplicated relaxed matches', async () => {
    const strict = { id: 1, name: 'Strict' } as Unit;
    const relaxed = { id: 2, name: 'Relaxed' } as Unit;
    const fetchMock = vi.fn().mockImplementation((_: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      return Promise.resolve(
        jsonResponse({
          units: request.search_mode === 'Strict' ? [strict] : [strict, relaxed],
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      searchUnitsStrictThenRelaxed({
        ...DEFAULT_LIST_UNITS_REQ,
        filterText: 'unit',
      }),
    ).resolves.toEqual([strict, relaxed]);
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)).search_mode),
    ).toEqual(['Strict', 'Relaxed']);
  });

  it('searches SIGINT unit names in both strict and relaxed modes', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse({ units: [] })));
    vi.stubGlobal('fetch', fetchMock);

    await searchUnitsStrictThenRelaxed({
      ...DEFAULT_LIST_UNITS_REQ,
      sortBy: 'UnitNameLengthAsc',
      filterName: '20 army',
    });

    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)))).toMatchObject([
      {
        sort_by: 'UnitNameLengthAsc',
        filter_text: null,
        filter_name: '20 army',
        search_mode: 'Strict',
      },
      {
        sort_by: 'UnitNameLengthAsc',
        filter_text: null,
        filter_name: '20 army',
        search_mode: 'Relaxed',
      },
    ]);
  });

  it('normalizes unit response fields to camel case', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        show_load_more: false,
        units: [
          {
            id: 7,
            company: '',
            battalion: '2 батальйон',
            regiment: '',
            division: '',
            army: '',
            comment: '',
            name: '2 батальйон',
            active: true,
            created_at: 1234,
            created_by_login_id: 'login-id',
            has_orbit: true,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getUnitsList()).resolves.toMatchObject([
      {
        id: 7,
        createdAt: 1234,
        createdByLoginId: 'login-id',
        hasOrbit: true,
      },
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      sort_by: null,
      after_unit_id: null,
      before_unit_id: null,
      include_inactive: false,
      limit: null,
      offset: null,
    });
  });

  it('requests a bounded server-side page with filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        show_load_more: true,
        total_count: 120_000,
        status_counts: { active: 0, inactive: 120_000 },
        units: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getUnitsPage({
        ...DEFAULT_LIST_UNITS_REQ,
        sortBy: 'UnitNameAsc',
        includeInactive: true,
        filterActive: false,
        filterText: '55 омсбр',
        searchMode: 'Strict',
        limit: 20,
        offset: 40,
      }),
    ).resolves.toEqual({
      showLoadMore: true,
      totalCount: 120_000,
      statusCounts: { active: 0, inactive: 120_000 },
      units: [],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      sort_by: 'UnitNameAsc',
      include_inactive: true,
      filter_active: false,
      filter_text: '55 омсбр',
      search_mode: 'Strict',
      limit: 20,
      offset: 40,
    });
  });

  it('requests unit-name reviews after the supplied cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        units: [],
        next_cursor: { updated_at_micros: 1_700_000_000_000_000, sigint_unit_id: 8 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getUnitNameReviews({
        after: { updatedAtMicros: 1_600_000_000_000_000, sigintUnitId: 7 },
      }),
    ).resolves.toEqual({
      units: [],
      nextCursor: { updatedAtMicros: 1_700_000_000_000_000, sigintUnitId: 8 },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      after: { updated_at_micros: 1_600_000_000_000_000, sigint_unit_id: 7 },
    });
  });

  it('can request inactive units explicitly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ units: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await getUnitsList({ includeInactive: true });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      include_inactive: true,
    });
  });

  it('loads every unit page for complete inactive rows and counts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          show_load_more: true,
          units: [{ id: 7, name: 'Active', active: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          show_load_more: false,
          units: [{ id: 11, name: 'Inactive', active: false }],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAllUnitsList({ includeInactive: true })).resolves.toMatchObject([
      { id: 7, active: true },
      { id: 11, active: false },
    ]);
    expect(
      fetchMock.mock.calls.map(([, options]) => JSON.parse(String(options?.body))),
    ).toMatchObject([
      { after_unit_id: null, include_inactive: true },
      { after_unit_id: 7, include_inactive: true },
    ]);
  });

  it('loads exact active and inactive unit counts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ active: 10, inactive: 120_000 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getUnitStatusCounts()).resolves.toEqual({ active: 10, inactive: 120_000 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sigint/units/status-counts');
  });

  it('loads unit IDs with attachments visible to the current user', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ unit_ids: [7, 11] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getUnitIdsWithVisibleAttachments([7, 11])).resolves.toEqual([7, 11]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual([7, 11]);
  });

  it('creates a device network for an existing unit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ network_id: 23 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createDeviceNetwork({
        unitId: 7,
        locations: ['Роботине'],
        unitMask: ['2 шр'],
      }),
    ).resolves.toEqual({ networkId: 23 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sigint/unit/create-device-network');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      unit_id: 7,
      locations: ['Роботине'],
      unit_mask: ['2 шр'],
    });
  });

  it('loads ORBIT-linked duplicate candidates before unit creation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        units: [
          {
            id: 7,
            name: '2 батальйон',
            active: true,
            orbit_unit_ids: ['orbit-id'],
            orbit_unit_generative_names: ['106 пдд / МВО'],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getCreateUnitDuplicateCandidates({
        company: '',
        battalion: '2 батальйон',
        regiment: '',
        division: '',
        army: '',
        militaryDistrict: '',
        armyRegion: '',
        active: true,
        isDeduplicateCandidate: null,
        comment: '',
        orbitNote: null,
        duplicateUnitIds: [],
      }),
    ).resolves.toMatchObject([
      {
        id: 7,
        orbitUnitIds: ['orbit-id'],
        orbitUnitGenerativeNames: ['106 пдд / МВО'],
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sigint/unit/create-duplicate-candidates');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      battalion: '2 батальйон',
      duplicate_unit_ids: [],
    });
  });

  it('loads unit details without AOR metadata for non-admins', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          unit: { id: 7 },
          attachments: [{ id: 19, unit_id: 7, aors: null }],
        }),
      ),
    );

    await expect(getUnitDetails(7)).resolves.toMatchObject({
      unit: { id: 7 },
      attachments: [{ id: 19, unitId: 7, aors: null }],
    });
  });

  it('searches and imports Orbit units', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          units: [
            {
              unit_id: 'orbit-id',
              full_name: '55 мбр',
              generative_unit_name_full: '55 мбр / 20 ЗВА',
              operational_unit_name_full: '55 мбр / 3 АК',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ unit: { id: 7, name: '55 мбр', has_orbit: true }, network_id: null }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchOrbitUnits({ search: '55 мбр' })).resolves.toMatchObject([
      { unitId: 'orbit-id', fullName: '55 мбр' },
    ]);
    await expect(importOrbitUnit({ orbitUnitId: 'orbit-id' })).resolves.toMatchObject({
      unit: { id: 7, name: '55 мбр', hasOrbit: true },
      networkId: null,
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/sigint/unit/orbit-search',
      '/api/sigint/unit/orbit-import',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ search: '55 мбр' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      orbit_unit_id: 'orbit-id',
    });
  });

  it('updates and deletes attachment metadata', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 19,
          unit_id: 7,
          short_description: 'Новий короткий опис',
          full_description: 'Новий повний опис',
          aors: [{ id: 2, name: 'Смуга 2' }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ attachment_id: 19 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      updateUnitAttachment({
        attachmentId: 19,
        shortDescription: 'Новий короткий опис',
        fullDescription: 'Новий повний опис',
        aorIds: [2],
      }),
    ).resolves.toMatchObject({ id: 19, unitId: 7, aors: [{ id: 2, name: 'Смуга 2' }] });
    await expect(deleteUnitAttachment(19)).resolves.toBe(19);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      attachment_id: 19,
      short_description: 'Новий короткий опис',
      full_description: 'Новий повний опис',
      aor_ids: [2],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ attachment_id: 19 });
  });

  it('uploads a unit attachment as multipart data and normalizes the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 19,
        unit_id: 7,
        file_name: 'map.kmz',
        content_type: 'application/vnd.google-earth.kmz',
        size_bytes: 4,
        short_description: 'Карта',
        full_description: 'Оновлена карта',
        aors: [{ id: 2, name: 'AOR 2' }],
        created_at: 1234,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['data'], 'map.kmz', {
      type: 'application/vnd.google-earth.kmz',
    });

    await expect(
      uploadUnitAttachment({
        unitId: 7,
        shortDescription: 'Карта',
        fullDescription: 'Оновлена карта',
        aorIds: [2],
        file,
      }),
    ).resolves.toMatchObject({
      id: 19,
      unitId: 7,
      fileName: 'map.kmz',
      sizeBytes: 4,
      shortDescription: 'Карта',
      fullDescription: 'Оновлена карта',
      createdAt: 1234,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/sigint/unit/attachment/upload');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).getAll('file')).toEqual([file]);
    expect((init.body as FormData).get('aor_ids')).toBe('[2]');
  });
});
