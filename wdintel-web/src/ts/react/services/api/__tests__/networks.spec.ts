/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postJson } from '../client';
import {
  addFreqToNetworkV2,
  getNetworkFreqCallsigns,
  getNetworkFreqCallsignsBatch,
  getNetworksGroupsActivitySummary,
  listNetworks,
  updateNetworkFreqV2,
} from '../networks';

vi.mock('../client', () => ({
  postJson: vi.fn(),
}));

const postJsonMock = vi.mocked(postJson);

// @test-scope parser: network-list response compatibility fixture
it('normalizes the combined network-list response', async () => {
  postJsonMock.mockResolvedValueOnce({
    list: [
      {
        id: 1,
        name: 'Alpha',
        freqs: [],
        unit_ids: [],
        aor_ids: [],
        location: '',
        radio_station: null,
        created_at: 1,
        purpose: null,
        operation_mode: null,
        operation_type: null,
        operation_period: null,
        last_updated_at: 1,
        last_updated_by: null,
        active_from: null,
        active_to: null,
        post_ids: [],
        descriptions: [],
        deleted: false,
        status: 'NetworkActive',
      },
    ],
    status_counts: { active: 7, inactive: 1, archived: 2 },
  });

  const response = await listNetworks({
    filterFreq: null,
    filterUnit: 'Unit 1',
    filterText: 'alpha',
    filterName: 'Alpha',
    filterLocation: 'Kyiv',
    showOnlyFurtherInverstigation: null,
    showInactive: true,
    showOnlyDeleted: false,
    statusFilter: 'ListNetworksInactive',
    aorIds: [1, 9],
    ids: null,
    limit: 50,
    offset: 100,
    sortBy: ['NameDesc'],
  });

  expect(response.list).toHaveLength(1);
  expect(response.statusCounts).toEqual({ active: 7, inactive: 1, archived: 2 });
});

// @test-scope parser: network activity-summary response normalization fixture.
it('returns precise activity alongside the grouped chart from one request', async () => {
  postJsonMock.mockResolvedValueOnce({
    activity: { 1: { 123: { alpha: 2 } } },
    last_activity_at: { 1: 456 },
  });

  const response = await getNetworksGroupsActivitySummary({
    networkIds: [1],
    tillDateNoninclusiveMs: 789,
    period: null,
  });

  expect(response).toEqual({
    activity: { 1: { 123: { alpha: 2 } } },
    lastActivityAt: { 1: 456 },
  });
});

// @test-scope parser: network-frequency callsign-map response compatibility fixture
it('normalizes string keys to numeric IDs in the batch callsigns response', async () => {
  postJsonMock.mockResolvedValueOnce({
    callsigns_by_network_freq_id: {
      '7': ['ALPHA'],
      '9': [],
    },
  });

  const callsignsById = await getNetworkFreqCallsignsBatch([7, 9], 'Last21Days');

  expect(callsignsById.get(7)).toEqual(['ALPHA']);
  expect(callsignsById.get(9)).toEqual([]);
});

describe('networks API v2 frequency mutations', () => {
  beforeEach(() => {
    postJsonMock.mockReset();
  });

  // @test-scope parser: nested Neo frequency-mutation response payload
  it('normalizes the nested Neo add-frequency response payload', async () => {
    postJsonMock.mockResolvedValueOnce({
      network: {
        id: 1,
        freqs: [],
        unit_ids: [],
        aor_ids: [],
        name: 'Net',
        location: '',
        radio_station: null,
        created_at: 1,
        purpose: null,
        operation_mode: null,
        operation_type: null,
        operation_period: null,
        last_updated_at: 1,
        last_updated_by: null,
        active_from: null,
        active_to: null,
        post_ids: [],
        descriptions: [],
        deleted: false,
        status: 'NetworkActive',
      },
      freq: {
        network_freq_id: 9,
        freq: '123.4000',
        modulation_id: null,
        modulation: null,
        encryption_key_ids: [],
        encryption_keys: [],
        message_count: 0,
        callsigns: null,
        last_datetime: null,
        last_datetime_in_aor: null,
        created_at: 1,
        is_active: true,
        active_from: 1,
        active_to: null,
        kind: 'VHF',
      },
    });

    await addFreqToNetworkV2({
      networkId: 1,
      freqRec: {
        freq: '123.4000',
        kind: 'VHF',
        modulationId: null,
        encryptionKeyIds: [],
        description: null,
        activeFrom: null,
        activeTo: null,
      },
    });

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/sigint/network/v2/add-freq',
      expect.objectContaining({
        network_id: 1,
        freq_rec: expect.objectContaining({
          freq: '123.4000',
        }),
      }),
      undefined,
    );
  });

  // @test-scope parser: nested Neo frequency-mutation response payload
  it('normalizes the nested Neo update-frequency response payload', async () => {
    postJsonMock.mockResolvedValueOnce({
      network: {
        id: 1,
        freqs: [],
        unit_ids: [],
        aor_ids: [],
        name: 'Net',
        location: '',
        radio_station: null,
        created_at: 1,
        purpose: null,
        operation_mode: null,
        operation_type: null,
        operation_period: null,
        last_updated_at: 1,
        last_updated_by: null,
        active_from: null,
        active_to: null,
        post_ids: [],
        descriptions: [],
        deleted: false,
        status: 'NetworkActive',
      },
      freq: {
        network_freq_id: 9,
        freq: '123.4000',
        modulation_id: 1,
        modulation: 'VHF',
        encryption_key_ids: [7],
        encryption_keys: ['AES256'],
        message_count: 12,
        callsigns: ['ALPHA'],
        last_datetime: 1,
        last_datetime_in_aor: 2,
        created_at: 1,
        is_active: true,
        active_from: 1,
        active_to: null,
        kind: 'VHF',
      },
    });

    await updateNetworkFreqV2({
      networkId: 1,
      networkFreqId: 9,
      freq: '123.4000',
      kind: 'VHF',
      modulationId: 1,
      encryptionKeyIds: [7],
      activeFrom: 1,
      activeTo: null,
    });

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/sigint/network/v2/update-freq',
      expect.objectContaining({
        network_id: 1,
        network_freq_id: 9,
        freq: '123.4000',
      }),
      undefined,
    );
  });

  // @test-scope parser: single network-frequency callsign response compatibility fixture
  it('normalizes the single frequency callsign response', async () => {
    postJsonMock.mockResolvedValueOnce({
      network_freq_id: 7,
      callsigns: ['ALPHA'],
    });

    await expect(getNetworkFreqCallsigns(7, 'Last7Days')).resolves.toEqual(['ALPHA']);

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/sigint/network-freq-callsigns',
      expect.objectContaining({
        network_freq_id: 7,
        period: 'Last7Days',
      }),
    );
  });
});
