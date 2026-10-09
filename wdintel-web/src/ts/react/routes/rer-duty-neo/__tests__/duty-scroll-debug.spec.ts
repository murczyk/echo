/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => {
  let recording = false;
  let recordingId: string | null = null;
  const listeners = new Set<() => void>();
  const aliases = new Map<string, string>();
  return {
    record: vi.fn(),
    alias: vi.fn((scope: string, value: string | number) => {
      const key = `${scope}:${value}`;
      if (!aliases.has(key)) aliases.set(key, `{${scope}_${aliases.size + 1}}`);
      return aliases.get(key)!;
    }),
    isRecording: vi.fn(() => recording),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    snapshot: vi.fn(() => ({ state: recording ? 'recording' : 'idle', recordingId })),
    setRecording(value: boolean, id = 'recording-1') {
      recording = value;
      recordingId = value ? id : null;
      act(() => listeners.forEach((listener) => listener()));
    },
    reset() {
      recording = false;
      recordingId = null;
      aliases.clear();
      listeners.clear();
      this.record.mockReset();
      this.alias.mockClear();
      this.isRecording.mockClear();
      this.subscribe.mockClear();
      this.snapshot.mockClear();
    },
  };
});

vi.mock('../../../../debug-recorder', () => ({
  recordDebugEvent: runtime.record,
  aliasDebugIdentifier: runtime.alias,
  isBrowserDebugRecording: runtime.isRecording,
  subscribeBrowserDebugRecorder: runtime.subscribe,
  getBrowserDebugRecorderSnapshot: runtime.snapshot,
}));

import {
  beginDutyScrollDebugActivity,
  isDutyScrollDebugEnabled,
  recordDutyScrollDebugEvent,
  recordDutyScrollDebugMetrics,
  recordDutyScrollDebugSnapshot,
  recordDutyScrollDebugTiming,
  useDutyScrollDebugEnabled,
  type DutyScrollDebugMetrics,
} from '../duty-scroll-debug';

const RAW_FEED = 'feed-ECHO_SECRET_SENTINEL-991234';

function metrics(): DutyScrollDebugMetrics {
  return {
    capturedAtMs: 10,
    scrollTop: 400,
    previousScrollTop: 350,
    scrollDelta: 50,
    scrollHeight: 2_000,
    clientHeight: 600,
    bottomDistance: 1_000,
    topLoadBufferPx: 200,
    bottomLoadBufferPx: 300,
    atBottomThresholdPx: 20,
    atTop: false,
    atBottom: false,
    physicallyAtBottom: false,
    nearBottom: true,
    liveBottomFollow: true,
    bottomSettleActive: false,
    loadOlderTriggered: true,
    loadNewerTriggered: false,
    visibleAnchorCount: 3,
    firstVisibleId: 881111,
    lastVisibleId: 882222,
    anchorId: 883333,
    anchorOffsetTop: 44,
    itemCount: 20,
    firstItemId: 884444,
    lastItemId: 885555,
    enabled: true,
    isWatchMode: false,
    overflowAnchor: 'none',
    scrollBehavior: 'auto',
  };
}

beforeEach(() => runtime.reset());
afterEach(() => document.body.replaceChildren());

describe('Duty global debug recorder adapter', () => {
  it('follows global recording in the compatibility hook', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Probe() {
      return createElement('span', null, String(useDutyScrollDebugEnabled()));
    }
    act(() => root.render(createElement(Probe)));
    expect(container.textContent).toBe('false');
    runtime.setRecording(true);
    expect(container.textContent).toBe('true');
    expect(isDutyScrollDebugEnabled()).toBe(true);
    act(() => root.unmount());
  });

  it('emits safe semantic event, metrics and timing parity', () => {
    runtime.setRecording(true);
    recordDutyScrollDebugEvent(
      RAW_FEED,
      'anchor:restore',
      'messageId=771111; itemId=772222; anchorId=773333; ECHO_SECRET_SENTINEL',
    );
    recordDutyScrollDebugMetrics(RAW_FEED, metrics());
    recordDutyScrollDebugTiming(RAW_FEED, {
      phase: 'render',
      durationMs: 18.5,
      reason: 'ECHO_SECRET_SENTINEL render reason',
    });

    expect(runtime.record).toHaveBeenCalledTimes(3);
    expect(runtime.record.mock.calls[0]?.[0]).toMatchObject({
      kind: 'duty.anchor.restore',
      source: 'duty',
      details: {
        feedId: expect.stringMatching(/^\{feed_/),
        messageId: expect.stringMatching(/^\{message_/),
        itemId: expect.stringMatching(/^\{item_/),
        anchorId: expect.stringMatching(/^\{anchor_/),
        fingerprint: expect.stringMatching(/^\{detail_/),
      },
    });
    expect(runtime.record.mock.calls[1]?.[0]).toMatchObject({
      kind: 'duty.metrics',
      source: 'duty',
      details: {
        scrollTop: 400,
        previousScrollTop: 350,
        scrollDelta: 50,
        scrollHeight: 2_000,
        clientHeight: 600,
        nearBottom: true,
        loadOlderTriggered: true,
        itemCount: 20,
        firstVisibleId: expect.stringMatching(/^\{message_/),
        anchorId: expect.stringMatching(/^\{anchor_/),
      },
    });
    expect(runtime.record.mock.calls[2]?.[0]).toMatchObject({
      kind: 'duty.render',
      source: 'duty',
      details: {
        phase: 'render',
        durationMs: 18.5,
        fingerprint: expect.stringMatching(/^\{detail_/),
      },
    });
    const output = JSON.stringify(runtime.record.mock.calls);
    expect(output).not.toContain('ECHO_SECRET_SENTINEL');
    for (const rawId of ['991234', '771111', '772222', '773333', '881111', '882222']) {
      expect(output).not.toContain(rawId);
    }
  });

  it('tracks activity counts and keeps finish idempotent', () => {
    runtime.setRecording(true);
    const finish = beginDutyScrollDebugActivity(
      RAW_FEED,
      'olderMessages',
      'messageId=776666; ECHO_SECRET_SENTINEL',
    );
    finish('accepted ECHO_SECRET_SENTINEL');
    finish('duplicate ECHO_SECRET_SENTINEL');

    expect(runtime.record).toHaveBeenCalledTimes(2);
    expect(runtime.record.mock.calls[0]?.[0]).toMatchObject({
      kind: 'duty.activity.start',
      details: {
        kind: 'older-messages',
        active: 1,
        fingerprint: expect.stringMatching(/^\{detail_/),
      },
    });
    expect(runtime.record.mock.calls[1]?.[0]).toMatchObject({
      kind: 'duty.activity.finish',
      details: {
        kind: 'older-messages',
        active: 0,
        fingerprint: expect.stringMatching(/^\{detail_/),
      },
    });
    expect(JSON.stringify(runtime.record.mock.calls)).not.toContain('ECHO_SECRET_SENTINEL');
  });

  it('records the complete safe feed and view snapshot from the previous Duty debugger', () => {
    runtime.setRecording(true);

    recordDutyScrollDebugSnapshot(
      {
        id: RAW_FEED,
        items: [
          [881111, {}],
          [882222, {}],
        ],
        pendingNewerItems: [[883333, {}]],
        unreadCount: 7,
        readIds: new Set([881111]),
        windowedUnreadItems: new Map([[884444, 1]]),
        loading: true,
        loadingOlder: false,
        hasReachedStart: true,
      },
      {
        narrowScreen: true,
        feedCount: 4,
        canRemove: true,
        maxWidth: 480,
        isWatchMode: false,
        autoScrollAllowed: true,
        initialPositioningReady: true,
        scrollTrackingEnabled: false,
        loadingNewer: true,
        arrowResultMessage: 'ECHO_SECRET_SENTINEL result',
        bottomUnreadCount: 3,
        physicallyAtBottom: false,
        tailAvailability: 'available',
        unreadCount: 7,
        unreadPrefetchNeeded: true,
        pendingNewerFlushNeeded: false,
        workspaceFabAvoidance: 'above',
        initialScrollAnchorSnapshot: {
          anchors: [{ id: 885555, index: 2, offsetTop: 24 }],
          itemOffsets: new Map([[885555, 24]]),
          itemIds: [881111, 882222],
          scrollTop: 400,
          scrollHeight: 2_000,
        },
      },
    );

    expect(runtime.record).toHaveBeenCalledTimes(2);
    expect(runtime.record.mock.calls[0]?.[0]).toMatchObject({
      kind: 'duty.feed.snapshot',
      source: 'duty',
      details: {
        feedId: expect.stringMatching(/^\{feed_/),
        itemCount: 2,
        firstItemId: expect.stringMatching(/^\{item_/),
        lastItemId: expect.stringMatching(/^\{item_/),
        pendingNewerCount: 1,
        pendingNewerTailId: expect.stringMatching(/^\{item_/),
        unreadCount: 7,
        readIdCount: 1,
        windowedUnreadCount: 1,
        loading: true,
        loadingOlder: false,
        hasReachedStart: true,
      },
    });
    expect(runtime.record.mock.calls[1]?.[0]).toMatchObject({
      kind: 'duty.view.snapshot',
      source: 'duty',
      details: {
        feedId: expect.stringMatching(/^\{feed_/),
        narrowScreen: true,
        feedCount: 4,
        canRemove: true,
        maxWidth: 480,
        isWatchMode: false,
        autoScrollAllowed: true,
        initialPositioningReady: true,
        scrollTrackingEnabled: false,
        loadingNewer: true,
        arrowResultFingerprint: expect.stringMatching(/^\{detail_/),
        bottomUnreadCount: 3,
        physicallyAtBottom: false,
        tailAvailability: 'available',
        unreadCount: 7,
        unreadPrefetchNeeded: true,
        pendingNewerFlushNeeded: false,
        workspaceFabAvoidance: 'above',
        documentVisibility: 'visible',
        initialAnchors: [
          {
            anchorId: expect.stringMatching(/^\{anchor_/),
            index: 2,
            offsetTop: 24,
          },
        ],
        initialItemIds: [expect.stringMatching(/^\{item_/), expect.stringMatching(/^\{item_/)],
        initialScrollTop: 400,
        initialScrollHeight: 2_000,
      },
    });
    const output = JSON.stringify(runtime.record.mock.calls);
    expect(output).not.toContain('ECHO_SECRET_SENTINEL');
    for (const rawId of ['991234', '881111', '882222', '883333', '884444', '885555']) {
      expect(output).not.toContain(rawId);
    }
  });

  it('deduplicates unchanged snapshots per recording and per snapshot part', () => {
    const feed = {
      id: RAW_FEED,
      items: [] as Array<[number, unknown]>,
      unreadCount: 0,
      readIds: new Set<number>(),
      windowedUnreadItems: new Map<number, number>(),
      loading: false,
      loadingOlder: false,
      hasReachedStart: false,
    };
    const view = { canRemove: true };
    runtime.setRecording(true, 'recording-1');

    recordDutyScrollDebugSnapshot(feed, view);
    recordDutyScrollDebugSnapshot(feed, view);
    expect(runtime.record).toHaveBeenCalledTimes(2);

    feed.loading = true;
    recordDutyScrollDebugSnapshot(feed, view);
    expect(runtime.record).toHaveBeenCalledTimes(3);
    expect(runtime.record.mock.calls[2]?.[0]).toMatchObject({ kind: 'duty.feed.snapshot' });

    runtime.setRecording(false);
    runtime.setRecording(true, 'recording-2');
    recordDutyScrollDebugSnapshot(feed, view);
    expect(runtime.record).toHaveBeenCalledTimes(5);
  });

  it('is a cheap no-op outside recording', () => {
    recordDutyScrollDebugEvent(RAW_FEED, 'event', 'ECHO_SECRET_SENTINEL');
    recordDutyScrollDebugMetrics(RAW_FEED, metrics());
    recordDutyScrollDebugTiming(RAW_FEED, { phase: 'commit', durationMs: 10 });
    const finish = beginDutyScrollDebugActivity(RAW_FEED, 'tailCount', 'secret');
    finish('secret');

    expect(runtime.record).not.toHaveBeenCalled();
    expect(runtime.alias).not.toHaveBeenCalled();
  });
});
