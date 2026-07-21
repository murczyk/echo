/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../Bindings';
import { minimalInboxMessage } from '../rer-duty-neo/inbox-message-mocks';
import { emptyQueryState } from './helpers';
import { useAnalysisData } from './use-analysis-data.core';

const api = vi.hoisted(() => ({
  fetchAnalysisAors: vi.fn(),
  fetchAnalysisCallsignGraph: vi.fn(),
  fetchAnalysisCallsignInfos: vi.fn(),
  fetchAnalysisCallsigns: vi.fn(),
  fetchAnalysisCount: vi.fn(),
  fetchAnalysisCorrelatedFreqs: vi.fn(),
  fetchAnalysisFreqs: vi.fn(),
  fetchAnalysisGroups: vi.fn(),
  fetchAnalysisLocations: vi.fn(),
  fetchAnalysisMapPoints: vi.fn(),
  fetchAnalysisMetadata: vi.fn(),
  fetchAnalysisNetworks: vi.fn(),
  fetchAnalysisNewCallsigns: vi.fn(),
  fetchAnalysisPosts: vi.fn(),
  fetchAnalysisReportTaskStatus: vi.fn(),
  fetchAnalysisSenders: vi.fn(),
  fetchAnalysisSummaryTable: vi.fn(),
  fetchAnalysisTags: vi.fn(),
  fetchAnalysisUnits: vi.fn(),
  fetchBgtaskStatusAndLogs: vi.fn(),
  fetchCurrentUser: vi.fn(),
  fetchFreqActivityDaily: vi.fn(),
  fetchInboxCount: vi.fn(),
  fetchInboxMessages: vi.fn(),
  fetchMessageComments: vi.fn(),
  fetchMessagesByIds: vi.fn(),
  fetchNetworksByIds: vi.fn(),
  fetchReportHistoryStatus: vi.fn(),
  getLatestSenders: vi.fn(),
  getTagsForDisplay: vi.fn(),
  inboxMessageTagsRm: vi.fn(),
}));

vi.mock('../../services/api/analysis', () => api);
vi.mock('../../services/api/units', () => ({ getUnitsList: vi.fn().mockResolvedValue([]) }));
vi.mock('../../services/api/palitra', () => ({
  listMapPalitrasV2: vi.fn().mockResolvedValue([]),
}));

type AnalysisApi = ReturnType<typeof useAnalysisData>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let current: AnalysisApi | null = null;
const onError = vi.fn();
const onUnauthorized = vi.fn(() => false);
const testQueryState = {
  ...emptyQueryState(),
  fromDateTimeStr: '2026-04-01T00:00',
  toDateTimeStr: '2026-04-02T00:00',
  tags: [7],
};
const testUser = {
  name: 'tester',
  roles: [],
  sigintZoneId: null,
  organismId: 1,
  goiConfiguredForOrganism: false,
  goiFullAccessForOrganism: false,
  goiHost: null,
  goiIntegrations: [],
};

function message(id: number, tagId: number): [number, InboxMessage] {
  return [
    id,
    minimalInboxMessage({
      tags: [tagId],
      inboxTags: [
        {
          id: tagId,
          tagId,
          confidence: 1,
          login: 'tester',
          model: null,
          organismId: 1,
        },
      ],
    }),
  ];
}

async function renderAnalysisData() {
  if (container == null) throw new Error('test container is missing');
  function Harness() {
    current = useAnalysisData({
      authUserName: 'tester',
      currentUser: testUser,
      centerTab: 'messages',
      newestFirst: true,
      onError,
      onUnauthorized,
      queryState: testQueryState,
      rightSidebarVisible: false,
      rightSidebarTab: null,
      shouldLoadNewCallsigns: false,
      deferInitialLoad: false,
      rightPanelOpen: false,
    });
    return null;
  }

  root = createRoot(container);
  await act(async () => {
    root?.render(React.createElement(Harness));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useAnalysisData tag pagination', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    current = null;
    api.fetchAnalysisAors.mockResolvedValue({ aors: [] });
    api.fetchAnalysisCallsignGraph.mockResolvedValue({ nodes: [], links: [] });
    api.fetchAnalysisCallsignInfos.mockResolvedValue([]);
    api.fetchAnalysisCallsigns.mockResolvedValue({ callsigns: [] });
    api.fetchAnalysisCount.mockResolvedValue({});
    api.fetchAnalysisCorrelatedFreqs.mockResolvedValue([]);
    api.fetchAnalysisFreqs.mockResolvedValue({ freqs: [] });
    api.fetchAnalysisGroups.mockResolvedValue({ groups: [], groupNames: [] });
    api.fetchAnalysisLocations.mockResolvedValue({ locations: [] });
    api.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });
    api.fetchAnalysisMetadata.mockResolvedValue({});
    api.fetchAnalysisNetworks.mockResolvedValue({ networks: [], networkNames: [] });
    api.fetchAnalysisNewCallsigns.mockResolvedValue({ callsigns: [] });
    api.fetchAnalysisPosts.mockResolvedValue({ posts: [] });
    api.fetchAnalysisReportTaskStatus.mockResolvedValue({});
    api.fetchAnalysisSenders.mockResolvedValue({ senders: [] });
    api.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    api.fetchAnalysisTags.mockResolvedValue({ tags: [] });
    api.fetchAnalysisUnits.mockResolvedValue({ units: [] });
    api.fetchBgtaskStatusAndLogs.mockResolvedValue({});
    api.fetchCurrentUser.mockResolvedValue(null);
    api.fetchFreqActivityDaily.mockResolvedValue({});
    api.fetchInboxCount.mockResolvedValue({ quantity: 2, firstElementTs: null });
    api.fetchMessageComments.mockResolvedValue({ data: [] });
    api.fetchMessagesByIds.mockResolvedValue([]);
    api.fetchNetworksByIds.mockResolvedValue([]);
    api.fetchReportHistoryStatus.mockResolvedValue({});
    api.getLatestSenders.mockResolvedValue({ data: {} });
    api.getTagsForDisplay.mockResolvedValue({ tagsMap: {}, tagsOrder: [] });
    api.inboxMessageTagsRm.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it('preserves an empty non-first page after a real tag mutation reload', async () => {
    api.fetchInboxMessages
      .mockResolvedValueOnce({ inboxItems: [message(1, 7)], callsigns: [], pageLimit: 20 })
      .mockResolvedValueOnce({ inboxItems: [message(21, 7)], callsigns: [], pageLimit: 20 });
    api.fetchInboxCount.mockResolvedValue({ quantity: 21, firstElementTs: null });

    await renderAnalysisData();
    await act(async () => {
      await vi.waitFor(() => expect(api.fetchInboxMessages).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(current!.messages).toHaveLength(1));
    });
    await vi.waitFor(() => {
      expect(current!.messagesTotalCount).toBe(21);
    });

    await act(async () => await current!.loadLastPage());
    expect(current!.pageIndex).toBe(1);
    const navigationRequest = api.fetchInboxMessages.mock.calls.at(-1)?.[0];
    const capturedLastPageCursor = {
      beforeIdNoninclusive: navigationRequest.beforeIdNoninclusive,
      sinceIdNoninclusive: navigationRequest.sinceIdNoninclusive,
    };
    api.fetchInboxMessages.mockClear();
    api.fetchInboxCount.mockResolvedValue({ quantity: 20, firstElementTs: null });
    api.fetchInboxMessages.mockResolvedValueOnce({
      inboxItems: [message(1, 7)],
      callsigns: [],
      pageLimit: 20,
    });

    await act(async () => {
      await current!.onToggleMessageTag(21, 7);
    });

    expect(current!.pageIndex).toBe(1);
    expect(current!.messages).toEqual([]);
    expect(current!.messages.some(([id]) => id === 1)).toBe(false);
    expect(api.fetchInboxMessages).toHaveBeenCalledTimes(1);
    expect(api.fetchInboxMessages).toHaveBeenCalledWith(
      expect.objectContaining(capturedLastPageCursor),
      expect.anything(),
    );
  });
});
