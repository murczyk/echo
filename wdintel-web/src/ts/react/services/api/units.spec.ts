/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getUnitIdsWithVisibleAttachments, getUnitsList, uploadUnitAttachment } from './units';

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

  it('normalizes unit response fields to camel case', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
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
      ),
    );

    await expect(getUnitsList()).resolves.toMatchObject([
      {
        id: 7,
        createdAt: 1234,
        createdByLoginId: 'login-id',
        hasOrbit: true,
      },
    ]);
  });

  it('loads unit IDs with attachments visible to the current user', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ unit_ids: [7, 11] })));

    await expect(getUnitIdsWithVisibleAttachments()).resolves.toEqual([7, 11]);
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
