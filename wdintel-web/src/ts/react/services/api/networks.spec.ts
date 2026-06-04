/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { postBytes, postJson } from './client';
import { downloadNetworkEtalonkaReport, getNetworkCallsignRelationMessages } from './networks';

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
