/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDeviceNetwork,
  DEFAULT_LIST_UNITS_REQ,
  deleteUnitAttachment,
  getCreateUnitDuplicateCandidates,
  getUnitsPage,
  getUnitDetails,
  getUnitIdsWithVisibleAttachments,
  getUnitsList,
  importOrbitUnit,
  searchOrbitUnits,
  updateUnitAttachment,
  uploadUnitAttachment,
} from '../units';

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

  // @test-scope parser: normalizes snake-case unit-list responses for React consumers.
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
  });

  // @test-scope parser: normalizes paginated unit response metadata.
  it('normalizes paginated unit response metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        show_load_more: true,
        total_count: 120_000,
        status_counts: { active: 0, inactive: 120_000 },
        units: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getUnitsPage(DEFAULT_LIST_UNITS_REQ)).resolves.toEqual({
      showLoadMore: true,
      totalCount: 120_000,
      statusCounts: { active: 0, inactive: 120_000 },
      units: [],
    });
  });

  // @test-scope parser: normalizes visible attachment ID responses.
  it('loads unit IDs with attachments visible to the current user', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ unit_ids: [7, 11] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getUnitIdsWithVisibleAttachments([7, 11])).resolves.toEqual([7, 11]);
  });

  // @test-scope parser: normalizes device-network response objects.
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
  });

  // @test-scope parser: normalizes ORBIT duplicate-candidate response fields.
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
        presentInOrbit: null,
        duplicateUnitIds: [],
      }),
    ).resolves.toMatchObject([
      {
        id: 7,
        orbitUnitIds: ['orbit-id'],
        orbitUnitGenerativeNames: ['106 пдд / МВО'],
      },
    ]);
  });

  // @test-scope parser: normalizes unit-detail attachments with nullable AOR metadata.
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

  // @test-scope parser: normalizes ORBIT search and import response objects.
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
  });

  // @test-scope parser: normalizes attachment update and delete responses.
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
  });

  // @test-scope parser: normalizes uploaded attachment response fields.
  it('normalizes uploaded attachment response fields', async () => {
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
  });
});
