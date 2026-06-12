/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postBytes, postJson } from './client';
import {
  downloadNetworkEtalonkaReport,
  downloadNetworksEtalonkaReport,
  getNetworkCallsignRelationMessages,
  getNetworksGroupsActivity,
  listNetworks,
} from './networks';

vi.mock('./client', () => ({
  postJson: vi.fn(),
  postBytes: vi.fn(),
}));

const postJsonMock = vi.mocked(postJson);
const postBytesMock = vi.mocked(postBytes);

describe('networks API etalonka report download', () => {
  beforeEach(() => {
    postJsonMock.mockReset();
    postBytesMock.mockReset();
  });

  it('preserves the standard enum tag when encoding the batch request', async () => {
    postBytesMock.mockResolvedValueOnce(new Blob(['ok']));

    await downloadNetworkEtalonkaReport({
      networkIds: [5],
      sortBy: null,
      etalonkaType: {
        AccordingToTheForm: {
          activeFreqsOnly: true,
          includeSigintSigns: true,
          includeConfirmation: false,
        },
      },
    });

    expect(postBytesMock).toHaveBeenCalledWith(
      '/api/sigint/etalonka/report-networks-batch-id',
      expect.objectContaining({
        network_ids: [5],
        sort_by: null,
        etalonka_type: {
          AccordingToTheForm: {
            active_freqs_only: true,
            include_sigint_signs: true,
            include_confirmation: false,
          },
        },
      }),
    );
  });

  it('preserves the enum tag when encoding the batch request', async () => {
    postBytesMock.mockResolvedValueOnce(new Blob(['ok']));

    await downloadNetworkEtalonkaReport({
      networkIds: [9],
      sortBy: null,
      etalonkaType: {
        ExtendedReport: {
          sinceDateInclusiveMs: 1,
          tillDateInclusiveMs: 2,
          activeFreqsOnly: false,
          includeUnitCallsigns: true,
          includeSigintSigns: false,
          includeConfirmation: true,
          includePelengsMap: false,
        },
      },
    });

    expect(postBytesMock).toHaveBeenCalledWith(
      '/api/sigint/etalonka/report-networks-batch-id',
      expect.objectContaining({
        network_ids: [9],
        sort_by: null,
        etalonka_type: {
          ExtendedReport: {
            since_date_inclusive_ms: 1,
            till_date_inclusive_ms: 2,
            active_freqs_only: false,
            include_unit_callsigns: true,
            include_sigint_signs: false,
            include_confirmation: true,
            include_pelengs_map: false,
          },
        },
      }),
    );
  });

  it('encodes the filtered report request with the classic report endpoint', async () => {
    postBytesMock.mockResolvedValueOnce(new Blob(['ok']));

    await downloadNetworksEtalonkaReport({
      req: {
        filterFreq: null,
        filterUnit: '3 АК',
        filterText: 'alpha',
        filterName: 'Alpha',
        filterLocation: 'Kyiv',
        showOnlyFurtherInverstigation: true,
        showInactive: null,
        showOnlyDeleted: null,
        statusFilter: 'ListNetworksActive',
        aorIds: [1, -1],
        ids: null,
        limit: null,
        offset: null,
        sortBy: ['NameAsc'],
      },
      etalonkaType: {
        AccordingToTheForm: {
          activeFreqsOnly: true,
          includeSigintSigns: true,
          includeConfirmation: false,
        },
      },
    });

    expect(postBytesMock).toHaveBeenCalledWith(
      '/api/sigint/etalonka/report-networks',
      expect.objectContaining({
        req: expect.objectContaining({
          filter_text: 'alpha',
          filter_unit: '3 АК',
          filter_name: 'Alpha',
          filter_location: 'Kyiv',
          show_only_further_inverstigation: true,
          status_filter: 'ListNetworksActive',
          aor_ids: [1, -1],
          sort_by: ['NameAsc'],
        }),
        etalonka_type: {
          AccordingToTheForm: {
            active_freqs_only: true,
            include_sigint_signs: true,
            include_confirmation: false,
          },
        },
      }),
    );
  });

  it('encodes the network list request in snake_case and normalizes the combined response', async () => {
    postJsonMock.mockResolvedValueOnce({
      list: [{ id: 1, name: 'Alpha', freqs: [], unit_ids: [], aor_ids: [], location: '', radio_station: null, created_at: 1, purpose: null, operation_mode: null, operation_type: null, operation_period: null, last_updated_at: 1, last_updated_by: null, active_from: null, active_to: null, post_ids: [], descriptions: [], deleted: false, status: 'NetworkActive' }],
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

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/sigint/network-list',
      expect.objectContaining({
        filter_freq: null,
        filter_unit: 'Unit 1',
        filter_text: 'alpha',
        filter_name: 'Alpha',
        filter_location: 'Kyiv',
        show_inactive: true,
        show_only_deleted: false,
        status_filter: 'ListNetworksInactive',
        aor_ids: [1, 9],
        limit: 50,
        offset: 100,
        sort_by: ['NameDesc'],
      }),
      undefined,
    );
    expect(response.list).toHaveLength(1);
    expect(response.statusCounts).toEqual({ active: 7, inactive: 1, archived: 2 });
  });

  it('encodes the default network list request with classic non-archived flags', async () => {
    postJsonMock.mockResolvedValueOnce({
      list: [],
      status_counts: { active: 0, inactive: 0, archived: 0 },
    });

    await listNetworks({
      filterFreq: null,
      filterUnit: null,
      filterText: null,
      filterName: null,
      filterLocation: null,
      showOnlyFurtherInverstigation: null,
      showInactive: true,
      showOnlyDeleted: false,
      statusFilter: null,
      aorIds: null,
      ids: null,
      limit: null,
      offset: null,
      sortBy: ['NameAsc'],
    });

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/sigint/network-list',
      expect.objectContaining({
        show_inactive: true,
        show_only_deleted: false,
        sort_by: ['NameAsc'],
      }),
      undefined,
    );
  });

  it('encodes the grouped activity request using snake_case', async () => {
    postJsonMock.mockResolvedValueOnce({});

    await getNetworksGroupsActivity({
      networkIds: [1, 2],
      tillDateNoninclusiveMs: 123,
    });

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/sigint/network-group-activity',
      expect.objectContaining({
        network_ids: [1, 2],
        till_date_noninclusive_ms: 123,
      }),
      undefined,
    );
  });

  it('encodes the relation messages request with snake_case body and passes abort signal through', async () => {
    const controller = new AbortController();
    postJsonMock.mockResolvedValueOnce({ messages: [] });

    await getNetworkCallsignRelationMessages(
      {
        networkId: 17,
        sinceDateInclusiveMs: 1,
        tillDateNoninclusiveMs: 2,
        callsign: 'ALPHA',
        source: null,
        target: null,
        freqs: ['652.111', '852.111'],
        limit: 24,
      },
      { signal: controller.signal },
    );

    expect(postJsonMock).toHaveBeenCalledWith(
      '/api/sigint/network-callsigns/relations/messages',
      expect.objectContaining({
        network_id: 17,
        since_date_inclusive_ms: 1,
        till_date_noninclusive_ms: 2,
        callsign: 'ALPHA',
        source: null,
        target: null,
        freqs: ['652.111', '852.111'],
        limit: 24,
      }),
      { signal: controller.signal },
    );
  });
});
