/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
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
  inboxMessageTagsModelError: vi.fn(),
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
  search: 'server-filtered',
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

function messageWithBotTag(id: number, tagId: number): [number, InboxMessage] {
  const [, inboxMessage] = message(id, tagId);
  return [
    id,
    {
      ...inboxMessage,
      inboxTags: [
        ...(inboxMessage.inboxTags ?? []),
        {
          id: tagId + 1000,
          tagId,
          confidence: 0.92,
          login: null,
          model: 'bot',
          organismId: null,
        },
      ],
    },
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
    root?.render(createElement(Harness));
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
    api.inboxMessageTagsModelError.mockResolvedValue(undefined);
    api.inboxMessageTagsRm.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it('does not reload the current page after a real tag mutation', async () => {
    api.fetchInboxMessages
      .mockResolvedValueOnce({ inboxItems: [message(1, 7)], callsigns: [], pageLimit: 20 })
      .mockResolvedValueOnce({ inboxItems: [message(2, 7)], callsigns: [], pageLimit: 20 });

    await renderAnalysisData();
    await act(async () => {
      await vi.waitFor(() => expect(api.fetchInboxMessages).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(current!.messages).toHaveLength(1));
    });
    await act(async () => await current!.loadNextPage());
    expect(current!.pageIndex).toBe(1);
    api.fetchInboxMessages.mockClear();

    await act(async () => {
      await current!.onToggleMessageTag(2, 7);
    });
    const eventOrigin = api.inboxMessageTagsRm.mock.calls[0]?.[1]?.eventOrigin;
    expect(eventOrigin).toEqual(expect.any(String));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { events: [{ messageId: 2, origin: eventOrigin }] },
        }),
      );
      await Promise.resolve();
    });

    expect(current!.pageIndex).toBe(1);
    expect(current!.messages).toHaveLength(1);
    expect(current!.messages[0]?.[0]).toBe(2);
    expect(current!.messages[0]?.[1].tags).toEqual([]);
    expect(api.fetchInboxMessages).not.toHaveBeenCalled();
  });

  it('reconciles by message id when the event arrives before a lost mutation response', async () => {
    api.fetchInboxMessages
      .mockResolvedValueOnce({ inboxItems: [message(1, 7)], callsigns: [], pageLimit: 20 })
      .mockResolvedValueOnce({ inboxItems: [message(2, 7)], callsigns: [], pageLimit: 20 });
    api.fetchMessagesByIds.mockResolvedValueOnce([
      [2, { ...message(2, 7)[1], tags: [], inboxTags: [] }],
    ]);
    let rejectMutation: ((error: Error) => void) | undefined;
    let eventOrigin: string | undefined;
    api.inboxMessageTagsRm.mockImplementationOnce((_req, options) => {
      eventOrigin = options?.eventOrigin;
      return new Promise<void>((_resolve, reject) => {
        rejectMutation = reject;
      });
    });

    await renderAnalysisData();
    await act(async () => {
      await vi.waitFor(() => expect(api.fetchInboxMessages).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(current!.messages).toHaveLength(1));
    });
    await act(async () => await current!.loadNextPage());
    api.fetchInboxMessages.mockClear();

    let mutationPromise: Promise<void> | undefined;
    await act(async () => {
      mutationPromise = current!.onToggleMessageTag(2, 7);
      await Promise.resolve();
    });
    expect(eventOrigin).toEqual(expect.any(String));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { events: [{ messageId: 2, origin: eventOrigin }] },
        }),
      );
      rejectMutation?.(new Error('response lost'));
      await mutationPromise;
    });

    expect(current!.pageIndex).toBe(1);
    expect(current!.messages).toEqual([]);
    expect(api.fetchMessagesByIds).toHaveBeenCalledWith(
      [2],
      expect.objectContaining({ search: 'server-filtered' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(api.fetchInboxMessages).not.toHaveBeenCalled();
  });

  it('suppresses an event that arrives before a successful mutation response', async () => {
    api.fetchInboxMessages
      .mockResolvedValueOnce({ inboxItems: [message(1, 7)], callsigns: [], pageLimit: 20 })
      .mockResolvedValueOnce({ inboxItems: [message(2, 7)], callsigns: [], pageLimit: 20 });
    let resolveMutation: (() => void) | undefined;
    let eventOrigin: string | undefined;
    api.inboxMessageTagsRm.mockImplementationOnce((_req, options) => {
      eventOrigin = options?.eventOrigin;
      return new Promise<void>((resolve) => {
        resolveMutation = resolve;
      });
    });

    await renderAnalysisData();
    await act(async () => {
      await vi.waitFor(() => expect(api.fetchInboxMessages).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(current!.messages).toHaveLength(1));
    });
    await act(async () => await current!.loadNextPage());
    api.fetchInboxMessages.mockClear();

    let mutationPromise: Promise<void> | undefined;
    await act(async () => {
      mutationPromise = current!.onToggleMessageTag(2, 7);
      await Promise.resolve();
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { events: [{ messageId: 2, origin: eventOrigin }] },
        }),
      );
      resolveMutation?.();
      await mutationPromise;
    });

    expect(current!.pageIndex).toBe(1);
    expect(current!.messages[0]?.[1].tags).toEqual([]);
    expect(api.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(api.fetchInboxMessages).not.toHaveBeenCalled();
  });

  it('reconciles a failed mutation when its matching event arrives later', async () => {
    api.fetchInboxMessages
      .mockResolvedValueOnce({ inboxItems: [message(1, 7)], callsigns: [], pageLimit: 20 })
      .mockResolvedValueOnce({ inboxItems: [message(2, 7)], callsigns: [], pageLimit: 20 });
    api.fetchMessagesByIds.mockResolvedValueOnce([
      [2, { ...message(2, 7)[1], tags: [], inboxTags: [] }],
    ]);
    api.inboxMessageTagsRm.mockRejectedValueOnce(new Error('response lost'));

    await renderAnalysisData();
    await act(async () => {
      await vi.waitFor(() => expect(api.fetchInboxMessages).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(current!.messages).toHaveLength(1));
    });
    await act(async () => await current!.loadNextPage());
    api.fetchInboxMessages.mockClear();
    await act(async () => await current!.onToggleMessageTag(2, 7));
    const eventOrigin = api.inboxMessageTagsRm.mock.calls[0]?.[1]?.eventOrigin;

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { events: [{ messageId: 2, origin: eventOrigin }] },
        }),
      );
      await vi.waitFor(() => expect(api.fetchMessagesByIds).toHaveBeenCalledOnce());
    });

    expect(current!.pageIndex).toBe(1);
    expect(current!.messages).toEqual([]);
    expect(api.fetchInboxMessages).not.toHaveBeenCalled();
  });

  it('keeps page 2 when the model-error response arrives before its event', async () => {
    api.fetchInboxMessages
      .mockResolvedValueOnce({ inboxItems: [message(1, 7)], callsigns: [], pageLimit: 20 })
      .mockResolvedValueOnce({
        inboxItems: [messageWithBotTag(2, 7)],
        callsigns: [],
        pageLimit: 20,
      });

    await renderAnalysisData();
    await act(async () => {
      await vi.waitFor(() => expect(api.fetchInboxMessages).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(current!.messages).toHaveLength(1));
    });
    await act(async () => await current!.loadNextPage());
    await act(async () => await current!.onToggleMessageTag(2, 7));
    api.fetchInboxMessages.mockClear();

    await act(async () => await current!.onMarkBotTagWrong(2, 7));
    const eventOrigin = api.inboxMessageTagsModelError.mock.calls[0]?.[1]?.eventOrigin;
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { events: [{ messageId: 2, origin: eventOrigin }] },
        }),
      );
      await Promise.resolve();
    });

    expect(current!.pageIndex).toBe(1);
    expect(current!.messages[0]?.[1].inboxTags).toEqual([]);
    expect(api.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(api.fetchInboxMessages).not.toHaveBeenCalled();

    api.fetchInboxMessages.mockResolvedValueOnce({
      inboxItems: [message(1, 7)],
      callsigns: [],
      pageLimit: 20,
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { events: [{ messageId: 2, origin: 'foreign-tab.origin' }] },
        }),
      );
      await vi.waitFor(() => expect(api.fetchInboxMessages).toHaveBeenCalled());
    });
  });

  it('keeps page 2 when the model-error event arrives before its response', async () => {
    api.fetchInboxMessages
      .mockResolvedValueOnce({ inboxItems: [message(1, 7)], callsigns: [], pageLimit: 20 })
      .mockResolvedValueOnce({
        inboxItems: [messageWithBotTag(2, 7)],
        callsigns: [],
        pageLimit: 20,
      });
    let resolveMutation: (() => void) | undefined;
    let eventOrigin: string | undefined;
    api.inboxMessageTagsModelError.mockImplementationOnce((_req, options) => {
      eventOrigin = options?.eventOrigin;
      return new Promise<void>((resolve) => {
        resolveMutation = resolve;
      });
    });

    await renderAnalysisData();
    await act(async () => {
      await vi.waitFor(() => expect(api.fetchInboxMessages).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(current!.messages).toHaveLength(1));
    });
    await act(async () => await current!.loadNextPage());
    await act(async () => await current!.onToggleMessageTag(2, 7));
    api.fetchInboxMessages.mockClear();

    let mutationPromise: Promise<void> | undefined;
    await act(async () => {
      mutationPromise = current!.onMarkBotTagWrong(2, 7);
      await Promise.resolve();
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { events: [{ messageId: 2, origin: eventOrigin }] },
        }),
      );
      resolveMutation?.();
      await mutationPromise;
    });

    expect(current!.pageIndex).toBe(1);
    expect(current!.messages[0]?.[1].inboxTags).toEqual([]);
    expect(api.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(api.fetchInboxMessages).not.toHaveBeenCalled();
  });

  it.each(['event-before-failure', 'failure-before-event'] as const)(
    'target-reconciles a lost model-error response in %s order',
    async (order) => {
      api.fetchInboxMessages
        .mockResolvedValueOnce({ inboxItems: [message(1, 7)], callsigns: [], pageLimit: 20 })
        .mockResolvedValueOnce({
          inboxItems: [messageWithBotTag(2, 7)],
          callsigns: [],
          pageLimit: 20,
        });
      api.fetchMessagesByIds.mockResolvedValueOnce([
        [2, { ...message(2, 7)[1], tags: [], inboxTags: [] }],
      ]);
      let rejectMutation: ((error: Error) => void) | undefined;
      if (order === 'event-before-failure') {
        api.inboxMessageTagsModelError.mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectMutation = reject;
            }),
        );
      } else {
        api.inboxMessageTagsModelError.mockRejectedValueOnce(new Error('response lost'));
      }

      await renderAnalysisData();
      await act(async () => {
        await vi.waitFor(() => expect(api.fetchInboxMessages).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(current!.messages).toHaveLength(1));
      });
      await act(async () => await current!.loadNextPage());
      await act(async () => await current!.onToggleMessageTag(2, 7));
      api.fetchInboxMessages.mockClear();

      let mutationPromise: Promise<void> | undefined;
      if (order === 'event-before-failure') {
        await act(async () => {
          mutationPromise = current!.onMarkBotTagWrong(2, 7);
          await Promise.resolve();
        });
      } else {
        await act(async () => await current!.onMarkBotTagWrong(2, 7));
      }
      const eventOrigin = api.inboxMessageTagsModelError.mock.calls[0]?.[1]?.eventOrigin;

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('echo-inbox-changed', {
            detail: { events: [{ messageId: 2, origin: eventOrigin }] },
          }),
        );
        rejectMutation?.(new Error('response lost'));
        await mutationPromise;
        await vi.waitFor(() => expect(api.fetchMessagesByIds).toHaveBeenCalledOnce());
      });

      expect(current!.pageIndex).toBe(1);
      expect(current!.messages).toEqual([]);
      expect(api.fetchInboxMessages).not.toHaveBeenCalled();
    },
  );

  it('ignores an unrelated event on page 2 but reloads for the visible page message', async () => {
    api.fetchInboxMessages
      .mockResolvedValueOnce({ inboxItems: [message(1, 7)], callsigns: [], pageLimit: 20 })
      .mockResolvedValueOnce({ inboxItems: [message(2, 7)], callsigns: [], pageLimit: 20 });

    await renderAnalysisData();
    await act(async () => {
      await vi.waitFor(() => expect(api.fetchInboxMessages).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(current!.messages).toHaveLength(1));
    });
    await act(async () => await current!.loadNextPage());
    expect(current!.pageIndex).toBe(1);
    api.fetchInboxMessages.mockClear();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { events: [{ messageId: 999, origin: 'foreign-tab.origin' }] },
        }),
      );
      await Promise.resolve();
    });

    expect(current!.pageIndex).toBe(1);
    expect(api.fetchInboxMessages).not.toHaveBeenCalled();
    expect(api.fetchMessagesByIds).not.toHaveBeenCalled();

    api.fetchInboxMessages.mockResolvedValueOnce({
      inboxItems: [message(1, 7)],
      callsigns: [],
      pageLimit: 20,
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { events: [{ messageId: 2, origin: 'foreign-tab.origin' }] },
        }),
      );
      await vi.waitFor(() => expect(api.fetchInboxMessages).toHaveBeenCalledOnce());
    });
  });
});
