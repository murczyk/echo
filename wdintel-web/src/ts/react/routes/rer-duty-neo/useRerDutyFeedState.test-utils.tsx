/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, vi } from 'vitest';

import type { InboxMessage, InboxMessagesRsp } from '../../../../Bindings';
import { minimalInboxMessage } from './inbox-message-mocks';
import { useRerDutyFeedState } from './useRerDutyFeedState';

const dutyApiMocks = vi.hoisted(() => ({
  fetchInboxMessages: vi.fn(),
  fetchInboxCount: vi.fn(),
  rerDutyShortStateCreate: vi.fn(),
  rerDutyShortStateGet: vi.fn(),
  fetchServerInfo: vi.fn(),
  systemSettingsCurrent: vi.fn(),
  notifyDutyNewMessages: vi.fn(),
  registerDutyNotificationPreview: vi.fn(),
  beginDutyNotificationPollCycle: vi.fn(),
  endDutyNotificationPollCycle: vi.fn(),
  cancelDutyNotificationPollCycle: vi.fn(),
  recordLastSuccessfulDutyCountCheck: vi.fn(),
  removeLastSuccessfulDutyCountCheck: vi.fn(),
}));

export function getDutyApiMocks() {
  return dutyApiMocks;
}

vi.mock('../../services/api/inbox', () => ({
  fetchInboxMessages: dutyApiMocks.fetchInboxMessages,
  fetchInboxCount: dutyApiMocks.fetchInboxCount,
  rerDutyShortStateCreate: dutyApiMocks.rerDutyShortStateCreate,
  rerDutyShortStateGet: dutyApiMocks.rerDutyShortStateGet,
}));

vi.mock('../../services/api/system-settings', () => ({
  currentSystemSettings: dutyApiMocks.systemSettingsCurrent,
}));

vi.mock('./notifications', () => ({
  DutyNotificationPreviewResultKind: {
    Ready: 'ready',
    Unavailable: 'unavailable',
    Stale: 'stale',
  },
  notifyDutyNewMessages: dutyApiMocks.notifyDutyNewMessages,
  registerDutyNotificationPreview: dutyApiMocks.registerDutyNotificationPreview,
  beginDutyNotificationPollCycle: dutyApiMocks.beginDutyNotificationPollCycle,
  endDutyNotificationPollCycle: dutyApiMocks.endDutyNotificationPollCycle,
  cancelDutyNotificationPollCycle: dutyApiMocks.cancelDutyNotificationPollCycle,
  recordLastSuccessfulDutyCountCheck: dutyApiMocks.recordLastSuccessfulDutyCountCheck,
  removeLastSuccessfulDutyCountCheck: dutyApiMocks.removeLastSuccessfulDutyCountCheck,
}));

vi.mock('../../services/api/networks', () => ({
  getNetworksByIds: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../services/api/units', () => ({
  getUnitsList: vi.fn(() => Promise.resolve([])),
  getUnitsByIds: vi.fn(() => Promise.resolve([])),
}));

export type DutyFeedStateApi = ReturnType<typeof useRerDutyFeedState>;
export type DutyFeedStateApiRef = React.MutableRefObject<DutyFeedStateApi | null>;

export function inboxRsp(
  items: Array<[number, InboxMessage]>,
  pollCursorId: number | null = items.at(-1)?.[0] ?? 1,
): InboxMessagesRsp {
  return {
    inboxItems: items,
    pollCursorId,
    callsigns: [],
    signalProfiles: {},
    signalGroups: [],
    freqPelengsSummary: null,
    pageLimit: 20,
  };
}

export function rangeRsp(from: number, to: number): InboxMessagesRsp {
  return inboxRsp(
    Array.from({ length: to - from + 1 }, (_, index) => {
      const id = from + index;
      return [id, minimalInboxMessage({ timestamp: id * 100 })];
    }),
  );
}

export function DutyFeedStateHarness(props: {
  apiRef: DutyFeedStateApiRef;
  disableAutoScroll?: boolean;
  freqs?: string[];
}) {
  const api = useRerDutyFeedState({
    freqs: props.freqs ?? [],
    setProfiles: vi.fn(),
    setGroupInfos: vi.fn(),
    testEnabled: false,
    testSinceMs: 0,
    testLimit: 1,
    pollIntervalSec: 1,
    disableAutoScroll: props.disableAutoScroll ?? false,
  });
  props.apiRef.current = new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        let result: unknown;
        act(() => {
          result = value(...args);
        });
        return result;
      };
    },
  });
  return null;
}

export async function settleReactCommits(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export function createDutyFeedStateFixture() {
  let container: HTMLElement | null = null;
  let root: Root | null = null;
  let rafCallbacks: FrameRequestCallback[] = [];
  const deferredRequests = new Map<string, { settled: boolean }>();

  function deferred<T>(name = `deferred request ${deferredRequests.size + 1}`): Deferred<T> {
    if (deferredRequests.has(name)) throw new Error(`Duplicate deferred request: ${name}`);
    const request = { settled: false };
    deferredRequests.set(name, request);
    let settle!: (value: T | PromiseLike<T>) => void;
    let fail!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    return {
      promise,
      resolve(value) {
        if (!request.settled) {
          request.settled = true;
          act(() => settle(value));
        }
      },
      reject(reason) {
        if (!request.settled) {
          request.settled = true;
          act(() => fail(reason));
        }
      },
    };
  }

  function runNextRaf() {
    rafCallbacks.shift()?.(0);
  }

  async function mountLoadedFeed(disableAutoScroll = false) {
    const apiRef: DutyFeedStateApiRef = { current: null };
    await act(async () => {
      root!.render(<DutyFeedStateHarness apiRef={apiRef} disableAutoScroll={disableAutoScroll} />);
      await settleReactCommits();
    });
    const scrollToEnd = vi.fn();
    apiRef.current!.columnRefsRef.current['mf-0'] = { scrollToEnd };
    return { apiRef, scrollToEnd };
  }

  async function startPoll() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }

  function expectTailCountRequest(tailId: number | null) {
    expect(
      dutyApiMocks.fetchInboxCount.mock.calls.some(
        ([request]) => request?.sinceIdNoninclusive === tailId,
      ),
    ).toBe(true);
  }

  function setup() {
    vi.useFakeTimers();
    rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.clearAllMocks();
    dutyApiMocks.fetchInboxMessages.mockReset();
    dutyApiMocks.fetchInboxCount.mockReset();
    dutyApiMocks.notifyDutyNewMessages.mockReset();
    dutyApiMocks.registerDutyNotificationPreview.mockReset();
    dutyApiMocks.beginDutyNotificationPollCycle.mockReset();
    dutyApiMocks.endDutyNotificationPollCycle.mockReset();
    dutyApiMocks.cancelDutyNotificationPollCycle.mockReset();
    dutyApiMocks.beginDutyNotificationPollCycle.mockImplementation(() => ({}));
    deferredRequests.clear();
    window.history.replaceState({}, '', '/');
    dutyApiMocks.fetchInboxCount.mockResolvedValue({ quantity: 0, firstElementTs: null });
    dutyApiMocks.fetchInboxMessages.mockResolvedValue(
      inboxRsp([[1, minimalInboxMessage({ timestamp: 100 })]]),
    );
    dutyApiMocks.systemSettingsCurrent.mockResolvedValue({
      id: 1,
      rerAnalysisUnitsExactMatchOnlyDefault: false,
      rerDutyTestEnabled: false,
      rerDutyInsertHistoricalInterceptions: false,
      rerDutyTestSinceMs: 0,
      rerDutyTestLimit: 1,
      rerDutyPollIntervalSec: 1,
      rerShortUrlEnabled: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    return { container, root };
  }

  function cleanup() {
    act(() => {
      root?.unmount();
    });
    const unsettled = [...deferredRequests]
      .filter(([, request]) => !request.settled)
      .map(([name]) => name);
    deferredRequests.clear();
    rafCallbacks = [];
    container?.remove();
    container = null;
    root = null;
    document.body.replaceChildren();
    expect(unsettled, `Unsettled deferred request(s): ${unsettled.join(', ')}`).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  }

  return {
    get container() {
      if (container == null) throw new Error('Duty test fixture has not been set up');
      return container;
    },
    get root() {
      if (root == null) throw new Error('Duty test fixture has not been set up');
      return root;
    },
    cleanup,
    deferred,
    expectTailCountRequest,
    mountLoadedFeed,
    runNextRaf,
    get queuedRafCount() {
      return rafCallbacks.length;
    },
    setup,
    startPoll,
  };
}
