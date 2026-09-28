import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postJson } from '../client';
import { getTagsForDisplay, getTagsMapForDisplay } from '../inbox-reference-data';
import { listCurrentOrganismTags } from '../tags';

vi.mock('../client', () => ({
  deleteVoid: vi.fn(),
  getJson: vi.fn(),
  postJson: vi.fn(),
  putJson: vi.fn(),
  putVoid: vi.fn(),
}));

const postJsonMock = vi.mocked(postJson);

describe('tag API helpers', () => {
  beforeEach(() => {
    postJsonMock.mockReset();
  });

  it('loads current organism tags and normalizes owner organism fields', async () => {
    const controller = new AbortController();
    postJsonMock.mockResolvedValueOnce([
      {
        tag_id: 25,
        label: 'оброблено',
        extra: false,
        ord: 1.5,
        enabled: true,
        is_palitra: false,
        owner_organism_id: 7,
        keywords: null,
      },
    ]);

    const result = await listCurrentOrganismTags({ signal: controller.signal });

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/tags/organism/list',
      {},
      {
        signal: controller.signal,
      },
    );
    expect(result).toEqual([
      {
        tagId: 25,
        label: 'оброблено',
        extra: false,
        ord: 1.5,
        enabled: true,
        isPalitra: false,
        ownerOrganismId: 7,
        keywords: [],
      },
    ]);
  });

  it('preserves backend display order and real backend tag ids', async () => {
    postJsonMock.mockResolvedValueOnce([
      [
        99,
        {
          label: 'організм',
          extra: false,
          ord: 1,
          keywords: null,
          is_palitra: false,
          owner_organism_id: 7,
        },
      ],
      [
        2,
        {
          label: 'глобальний',
          extra: false,
          ord: 2,
          keywords: null,
          is_palitra: false,
          owner_organism_id: null,
        },
      ],
    ]);

    const result = await getTagsForDisplay();

    expect(postJsonMock).toHaveBeenCalledWith('/api/tags/tags-list', {}, undefined);
    expect(result.tagsOrder).toEqual([99, 2]);
    expect(Object.keys(result.tagsMap)).toEqual(['2', '99']);
    expect(result.tagsMap[99]).toMatchObject({ label: 'організм', ownerOrganismId: 7 });
    expect(result.tagsMap[2]).toMatchObject({ label: 'глобальний', ownerOrganismId: null });
  });

  it('keeps the legacy map helper while using backend tag ids', async () => {
    postJsonMock.mockResolvedValueOnce([
      [
        41,
        {
          label: 'first',
          extra: null,
          ord: null,
          keywords: null,
          is_palitra: false,
          owner_organism_id: null,
        },
      ],
    ]);

    const result = await getTagsMapForDisplay();

    expect(result[41]?.label).toBe('first');
    expect(result[0]).toBeUndefined();
  });
});
