/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnalysisQueryState } from '../types';

const runtime = vi.hoisted(() => {
  let recording = false;
  let recordingId: string | null = null;
  const aliases = new Map<string, string>();
  return {
    record: vi.fn(),
    alias: vi.fn((scope: string, value: string | number) => {
      const key = `${scope}:${value}`;
      if (!aliases.has(key)) aliases.set(key, `{${scope}_${aliases.size + 1}}`);
      return aliases.get(key)!;
    }),
    isRecording: vi.fn(() => recording),
    subscribe: vi.fn(() => () => {}),
    snapshot: vi.fn(() => ({ state: recording ? 'recording' : 'idle', recordingId })),
    setRecording(value: boolean, id = 'recording-1') {
      recording = value;
      recordingId = value ? id : null;
    },
    reset() {
      recording = false;
      recordingId = null;
      aliases.clear();
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
  recordAnalysisDebugPageSnapshot,
  recordAnalysisDebugScrollSnapshot,
  summarizeAnalysisDebugFilters,
} from '../analysis-debug';

beforeEach(() => runtime.reset());

describe('Analysis global debug recorder adapter', () => {
  it('summarizes active filters without exposing their values', () => {
    const summary = summarizeAnalysisDebugFilters({
      groupsSelected: ['ECHO_SECRET_SENTINEL'],
      tags: [991234],
      search: 'ECHO_SECRET_SENTINEL',
      onlyWithMedia: true,
    } as AnalysisQueryState);

    expect(summary).toEqual({
      activeFilterCount: 4,
      selectedFilterValueCount: 2,
      hasSearch: true,
    });
    expect(JSON.stringify(summary)).not.toContain('ECHO_SECRET_SENTINEL');
    expect(JSON.stringify(summary)).not.toContain('991234');
  });

  it('records and deduplicates a safe page snapshot while recording', () => {
    runtime.setRecording(true);
    const snapshot = {
      centerTab: 'messages' as const,
      centerTabPending: false,
      leftPanelOpen: true,
      rightPanelOpen: false,
      rightSidebarTab: null,
      messagesLoading: false,
      messagesPaging: true,
      messagesTotalLoading: false,
      messagesTotalCount: 240,
      messagesOverallCount: 300,
      messageIds: [771111, 772222],
      pageIndex: 2,
      visiblePageIndex: 3,
      newestFirst: true,
      hasLoadedInitialMessages: true,
      noMoreToLoad: false,
      directMessageActive: true,
      directMessageLoading: false,
      messageViewportPreserving: true,
      filtersLoading: false,
      countsLoading: false,
      summaryLoading: false,
      activeFilterCount: 4,
      selectedFilterValueCount: 2,
      hasSearch: true,
      hasError: false,
      hasValidationError: false,
      editorOpen: false,
      skeletonVisible: false,
    };

    recordAnalysisDebugPageSnapshot(snapshot);
    recordAnalysisDebugPageSnapshot(snapshot);

    expect(runtime.record).toHaveBeenCalledTimes(1);
    expect(runtime.record.mock.calls[0]?.[0]).toMatchObject({
      kind: 'analysis.page.snapshot',
      source: 'analysis',
      details: {
        centerTab: 'messages',
        messageCount: 2,
        firstItemId: expect.stringMatching(/^\{message_/),
        lastItemId: expect.stringMatching(/^\{message_/),
        pageIndex: 2,
        visiblePageIndex: 3,
        messagesPaging: true,
        activeFilterCount: 4,
        selectedFilterValueCount: 2,
        hasSearch: true,
      },
    });
    const output = JSON.stringify(runtime.record.mock.calls);
    expect(output).not.toContain('771111');
    expect(output).not.toContain('772222');
  });

  it('records visible message aliases and scroll preservation state', () => {
    runtime.setRecording(true);
    const container = document.createElement('div');
    Object.defineProperties(container, {
      clientHeight: { value: 600 },
      scrollHeight: { value: 2_000 },
      scrollTop: { value: 400 },
    });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    for (const [messageId, top, bottom] of [
      [881111, -100, 0],
      [882222, 0, 300],
      [883333, 300, 700],
    ] as const) {
      const element = document.createElement('div');
      element.dataset.messageId = String(messageId);
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
        bottom,
        height: bottom - top,
        left: 0,
        right: 800,
        top,
        width: 800,
        x: 0,
        y: top,
        toJSON: () => ({}),
      });
      container.append(element);
    }

    recordAnalysisDebugScrollSnapshot(container, {
      pageIndex: 2,
      paginationLoading: true,
      noMoreToLoad: false,
      directMessageActive: true,
      directMessageFocusActive: false,
      viewportAnchorActive: true,
      targetAnchorPreserved: false,
      bottomAnchorSpacerPx: 80,
    });

    expect(runtime.record.mock.calls[0]?.[0]).toMatchObject({
      kind: 'analysis.scroll.snapshot',
      source: 'analysis',
      details: {
        scrollTop: 400,
        scrollHeight: 2_000,
        clientHeight: 600,
        bottomDistance: 1_000,
        itemCount: 3,
        visibleCount: 2,
        firstVisibleId: expect.stringMatching(/^\{message_/),
        lastVisibleId: expect.stringMatching(/^\{message_/),
        viewportAnchorActive: true,
        bottomAnchorSpacerPx: 80,
      },
    });
    const output = JSON.stringify(runtime.record.mock.calls);
    expect(output).not.toContain('882222');
    expect(output).not.toContain('883333');
  });

  it('does nothing outside an active recording', () => {
    recordAnalysisDebugPageSnapshot({
      centerTab: 'messages',
      centerTabPending: false,
      leftPanelOpen: true,
      rightPanelOpen: false,
      rightSidebarTab: null,
      messagesLoading: false,
      messagesPaging: false,
      messagesTotalLoading: false,
      messagesTotalCount: null,
      messagesOverallCount: null,
      messageIds: [],
      pageIndex: 0,
      visiblePageIndex: 0,
      newestFirst: true,
      hasLoadedInitialMessages: false,
      noMoreToLoad: false,
      directMessageActive: false,
      directMessageLoading: false,
      messageViewportPreserving: false,
      filtersLoading: false,
      countsLoading: false,
      summaryLoading: false,
      activeFilterCount: 0,
      selectedFilterValueCount: 0,
      hasSearch: false,
      hasError: false,
      hasValidationError: false,
      editorOpen: false,
      skeletonVisible: false,
    });

    expect(runtime.record).not.toHaveBeenCalled();
    expect(runtime.alias).not.toHaveBeenCalled();
  });
});
