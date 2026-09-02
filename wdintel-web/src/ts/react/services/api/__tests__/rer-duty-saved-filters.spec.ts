// @test-scope parser: saved-duty-filter API response normalization fixtures
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postJson } from '../client';
import { savedFilterUpsert, savedFiltersList } from '../rer-duty-saved-filters';

vi.mock('../client', () => ({
  postJson: vi.fn(),
  postVoid: vi.fn(),
}));

const postJsonMock = vi.mocked(postJson);

const snakeCaseReq = {
  groups_selected: ['saved-selected'],
  groups_denied: ['saved-denied'],
  units_selected: ['unit-a'],
  units_exact_match_only: true,
  last_viewed_message_id: 42,
};

describe('RER Duty saved-filter API', () => {
  beforeEach(() => {
    postJsonMock.mockReset();
  });

  it('normalizes snake_case list responses including non-group fields', async () => {
    postJsonMock.mockResolvedValue([{ id: 1, name: 'Saved', req: snakeCaseReq }]);

    const filters = await savedFiltersList();

    expect(filters[0].req).toMatchObject({
      groupsSelected: ['saved-selected'],
      groupsDenied: ['saved-denied'],
      unitsSelected: ['unit-a'],
      unitsExactMatchOnly: true,
      lastViewedMessageId: 42,
    });
    expect(filters[0].req).not.toHaveProperty('groups_selected');
  });

  it('normalizes snake_case upsert responses and preserves request serialization', async () => {
    postJsonMock.mockResolvedValue([{ id: 2, name: 'Saved', req: snakeCaseReq }]);

    const filters = await savedFilterUpsert({
      name: 'Saved',
      req: {
        groupsSelected: ['saved-selected'],
        groupsDenied: ['saved-denied'],
        sendersSelected: null,
        deniedSenders: null,
        freqsSelected: null,
        freqsDenied: null,
        postsSelected: null,
        postsDenied: null,
        unitsSelected: ['unit-a'],
        unitsDenied: null,
        unitsExactMatchOnly: true,
        lastViewedMessageId: 42,
        highlightKeywordsEnabled: null,
        highlightKeywordSetId: null,
      },
    });

    expect(postJsonMock).toHaveBeenCalledWith('/api/rer/duty/saved-filter-upsert', {
      name: 'Saved',
      req: {
        groups_selected: ['saved-selected'],
        groups_denied: ['saved-denied'],
        senders_selected: null,
        denied_senders: null,
        freqs_selected: null,
        freqs_denied: null,
        posts_selected: null,
        posts_denied: null,
        units_selected: ['unit-a'],
        units_denied: null,
        units_exact_match_only: true,
        last_viewed_message_id: 42,
      },
    });
    expect(filters[0].req.groupsSelected).toEqual(['saved-selected']);
    expect(filters[0].req.unitsExactMatchOnly).toBe(true);
  });
});
