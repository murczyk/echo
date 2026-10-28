import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postJson } from '../client';
import {
  rerDutyShortStateCreate,
  rerDutyShortStateGet,
  savedFilterUpsert,
  savedFiltersList,
} from '../rer-duty-saved-filters';
import type { RerDutyQueryStateWf } from '../../../../../Bindings';
import { normalizeRerDutyQueryStateWf } from '../../../../rer-duty-filter-normalizer';

vi.mock('../client', () => ({
  postJson: vi.fn(),
  postVoid: vi.fn(),
}));

const postJsonMock = vi.mocked(postJson);

const snakeCaseReq = {
  groups_selected: ['saved-selected'],
  groups_denied: ['saved-denied'],
  units_selected: ['unit-a'],
  units_denied: ['unit-b'],
  selected_unit_ids: [11],
  denied_unit_ids: [12],
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
      unitsSelected: ['unit-id:11', 'unit-a'],
      unitsDenied: ['unit-id:12', 'unit-b'],
      unitsExactMatchOnly: true,
      lastViewedMessageId: 42,
    });
    expect(filters[0].req).not.toHaveProperty('groups_selected');
  });

  it('normalizes snake_case upsert responses', async () => {
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
        unitsSelected: ['unit-id:11', 'unit-a'],
        unitsDenied: ['unit-id:12', 'unit-b'],
        selectedUnitIds: null,
        deniedUnitIds: null,
        selectedDeviceNames: null,
        deniedDeviceNames: null,
        unitsExactMatchOnly: true,
        locationsSelected: null,
        locationsDenied: null,
        includePelengLocations: null,
        lastViewedMessageId: 42,
        highlightKeywordsEnabled: null,
        highlightKeywordSetId: null,
      },
    });

    expect(filters[0].req.groupsSelected).toEqual(['saved-selected']);
    expect(filters[0].req.unitsSelected).toEqual(['unit-id:11', 'unit-a']);
    expect(filters[0].req.unitsExactMatchOnly).toBe(true);
  });

  function locationFilter(): RerDutyQueryStateWf {
    return {
      groupsSelected: null,
      groupsDenied: null,
      sendersSelected: null,
      deniedSenders: null,
      freqsSelected: null,
      freqsDenied: null,
      postsSelected: null,
      postsDenied: null,
      unitsSelected: null,
      unitsDenied: null,
      selectedUnitIds: null,
      deniedUnitIds: null,
      selectedDeviceNames: null,
      deniedDeviceNames: null,
      unitsExactMatchOnly: false,
      locationsSelected: ['КИЇВ', ''],
      locationsDenied: ['ЛЬВІВ'],
      includePelengLocations: true,
      lastViewedMessageId: null,
      highlightKeywordsEnabled: null,
      highlightKeywordSetId: null,
    };
  }

  it('serializes location fields as snake_case and normalizes them back', async () => {
    postJsonMock.mockImplementation(async (_url, body) => [
      { id: 3, name: 'Locations', req: (body as { req: unknown }).req },
    ]);

    const filters = await savedFilterUpsert({ name: 'Locations', req: locationFilter() });

    const sentReq = (postJsonMock.mock.calls[0][1] as { req: Record<string, unknown> }).req;
    expect(sentReq).toMatchObject({
      locations_selected: ['КИЇВ', ''],
      locations_denied: ['ЛЬВІВ'],
      include_peleng_locations: true,
    });
    expect(sentReq).not.toHaveProperty('locationsSelected');
    expect(filters[0].req).toMatchObject({
      locationsSelected: ['КИЇВ', ''],
      locationsDenied: ['ЛЬВІВ'],
      includePelengLocations: true,
    });
  });

  it('round-trips location fields through the Duty short state', async () => {
    postJsonMock.mockResolvedValueOnce({ id: 'short-1' });
    await rerDutyShortStateCreate({ waterfalls: [['mf-0', locationFilter()]] });
    const sentState = (postJsonMock.mock.calls[0][1] as { state: unknown }).state;
    postJsonMock.mockResolvedValueOnce({ state: sentState });

    const { state } = await rerDutyShortStateGet('short-1');

    const [, restored] = state.waterfalls?.[0] ?? [];
    expect(
      normalizeRerDutyQueryStateWf(restored as unknown as Record<string, unknown>),
    ).toMatchObject({
      locationsSelected: ['КИЇВ', ''],
      locationsDenied: ['ЛЬВІВ'],
      includePelengLocations: true,
    });
  });

  it('defaults missing location fields to null', () => {
    expect(normalizeRerDutyQueryStateWf({ groups_selected: ['g'] })).toMatchObject({
      locationsSelected: null,
      locationsDenied: null,
      includePelengLocations: null,
    });
  });
});
