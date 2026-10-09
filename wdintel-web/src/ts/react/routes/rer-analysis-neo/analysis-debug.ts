import { useSyncExternalStore } from 'react';

import {
  aliasDebugIdentifier,
  getBrowserDebugRecorderSnapshot,
  isBrowserDebugRecording,
  recordDebugEvent,
  subscribeBrowserDebugRecorder,
} from '../../../debug-recorder';
import type { AnalysisCenterTab, AnalysisQueryState, AnalysisSidebarTab } from './types';

export type AnalysisDebugFilterSummary = {
  activeFilterCount: number;
  selectedFilterValueCount: number;
  hasSearch: boolean;
};

export type AnalysisDebugPageSnapshotInput = AnalysisDebugFilterSummary & {
  centerTab: AnalysisCenterTab;
  centerTabPending: boolean;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  rightSidebarTab: AnalysisSidebarTab | null;
  messagesLoading: boolean;
  messagesPaging: boolean;
  messagesTotalLoading: boolean;
  messagesTotalCount: number | null;
  messagesOverallCount: number | null;
  messageIds: readonly number[];
  pageIndex: number;
  visiblePageIndex: number;
  newestFirst: boolean;
  hasLoadedInitialMessages: boolean;
  noMoreToLoad: boolean;
  directMessageActive: boolean;
  directMessageLoading: boolean;
  messageViewportPreserving: boolean;
  filtersLoading: boolean;
  countsLoading: boolean;
  summaryLoading: boolean;
  hasError: boolean;
  hasValidationError: boolean;
  editorOpen: boolean;
  skeletonVisible: boolean;
};

export type AnalysisDebugScrollSnapshotInput = {
  pageIndex: number;
  paginationLoading: boolean;
  noMoreToLoad: boolean;
  directMessageActive: boolean;
  directMessageFocusActive: boolean;
  viewportAnchorActive: boolean;
  targetAnchorPreserved: boolean;
  bottomAnchorSpacerPx: number;
};

const snapshotFingerprints = new Map<string, string>();
let activeRecordingId: string | null = null;

function currentRecordingId(): string | null {
  if (!isBrowserDebugRecording()) return null;
  const snapshot = getBrowserDebugRecorderSnapshot();
  if (snapshot.state !== 'recording' || !snapshot.recordingId) return null;
  if (activeRecordingId !== snapshot.recordingId) {
    snapshotFingerprints.clear();
    activeRecordingId = snapshot.recordingId;
  }
  return snapshot.recordingId;
}

function safeAlias(scope: string, value: string | number | null): string | undefined {
  if (value === null) return undefined;
  const alias = aliasDebugIdentifier(scope, value);
  return alias && /^\{[a-z0-9_-]+\}$/i.test(alias) ? alias : undefined;
}

function recordSnapshot(kind: string, details: Record<string, unknown>): void {
  const recordingId = currentRecordingId();
  if (recordingId === null) return;
  const fingerprint = JSON.stringify(details);
  const key = `${recordingId}:${kind}`;
  if (snapshotFingerprints.get(key) === fingerprint) return;
  snapshotFingerprints.set(key, fingerprint);
  recordDebugEvent({ kind, source: 'analysis', details });
}

export function summarizeAnalysisDebugFilters(
  queryState: AnalysisQueryState,
): AnalysisDebugFilterSummary {
  const selectedCounts = [
    queryState.aorsSelected,
    queryState.groupsSelected,
    queryState.sendersSelected,
    queryState.freqsSelected,
    queryState.callsignsSelected,
    queryState.unitsSelected,
    queryState.locationsSelected,
    queryState.postsSelected,
    queryState.networksSelected,
    queryState.metadataCc,
    queryState.metadataSender,
    queryState.metadataReceiver,
    queryState.metadataHash,
    queryState.tags,
    queryState.deviceNamesSelected,
  ].map((selection) => (Array.isArray(selection) ? selection.length : 0));
  const booleanFilters = [
    queryState.withoutNetwork,
    queryState.orWithExtendedForm,
    queryState.orBookmarked,
    queryState.orImportant,
    queryState.orWithCoords,
    queryState.orWithoutCoords,
    queryState.onlyWithMetadata,
    queryState.withoutMetadata,
    queryState.includePelengLocations === false,
    queryState.withoutModelTags,
    queryState.reportTagsOnlyThisUnit === true,
    queryState.includeOnlyNewFreqs,
    queryState.onlyWithMedia,
    queryState.onlyWithNetwork,
    (queryState.adjacentFreqsRange ?? 0) > 0,
  ];
  const hasSearch = (queryState.search ?? '').trim().length > 0;
  return {
    activeFilterCount:
      selectedCounts.filter((count) => count > 0).length +
      booleanFilters.filter(Boolean).length +
      Number(hasSearch),
    selectedFilterValueCount: selectedCounts.reduce((total, count) => total + count, 0),
    hasSearch,
  };
}

export function useAnalysisDebugEnabled(): boolean {
  return useSyncExternalStore(
    subscribeBrowserDebugRecorder,
    isBrowserDebugRecording,
    isBrowserDebugRecording,
  );
}

export function recordAnalysisDebugPageSnapshot(input: AnalysisDebugPageSnapshotInput): void {
  if (currentRecordingId() === null) return;
  recordSnapshot('analysis.page.snapshot', {
    centerTab: input.centerTab,
    centerTabPending: input.centerTabPending,
    leftPanelOpen: input.leftPanelOpen,
    rightPanelOpen: input.rightPanelOpen,
    rightSidebarTab: input.rightSidebarTab,
    messagesLoading: input.messagesLoading,
    messagesPaging: input.messagesPaging,
    messagesTotalLoading: input.messagesTotalLoading,
    messagesTotalCount: input.messagesTotalCount,
    messagesOverallCount: input.messagesOverallCount,
    messageCount: input.messageIds.length,
    firstItemId: safeAlias('message', input.messageIds[0] ?? null),
    lastItemId: safeAlias('message', input.messageIds.at(-1) ?? null),
    pageIndex: input.pageIndex,
    visiblePageIndex: input.visiblePageIndex,
    newestFirst: input.newestFirst,
    hasLoadedInitialMessages: input.hasLoadedInitialMessages,
    noMoreToLoad: input.noMoreToLoad,
    directMessageActive: input.directMessageActive,
    directMessageLoading: input.directMessageLoading,
    messageViewportPreserving: input.messageViewportPreserving,
    filtersLoading: input.filtersLoading,
    countsLoading: input.countsLoading,
    summaryLoading: input.summaryLoading,
    activeFilterCount: input.activeFilterCount,
    selectedFilterValueCount: input.selectedFilterValueCount,
    hasSearch: input.hasSearch,
    hasError: input.hasError,
    hasValidationError: input.hasValidationError,
    editorOpen: input.editorOpen,
    skeletonVisible: input.skeletonVisible,
  });
}

export function recordAnalysisDebugScrollSnapshot(
  container: HTMLElement,
  input: AnalysisDebugScrollSnapshotInput,
): void {
  if (currentRecordingId() === null) return;
  const containerRect = container.getBoundingClientRect();
  const viewportTop = containerRect.top + container.clientTop;
  const viewportBottom = viewportTop + container.clientHeight;
  const messageElements = [...container.querySelectorAll<HTMLElement>('[data-message-id]')];
  const visibleMessageIds = messageElements
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > viewportTop && rect.top < viewportBottom;
    })
    .map((element) => Number(element.dataset.messageId))
    .filter(Number.isFinite);
  recordSnapshot('analysis.scroll.snapshot', {
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    bottomDistance: Math.max(
      0,
      container.scrollHeight - container.scrollTop - container.clientHeight,
    ),
    itemCount: messageElements.length,
    visibleCount: visibleMessageIds.length,
    firstVisibleId: safeAlias('message', visibleMessageIds[0] ?? null),
    lastVisibleId: safeAlias('message', visibleMessageIds.at(-1) ?? null),
    pageIndex: input.pageIndex,
    paginationLoading: input.paginationLoading,
    noMoreToLoad: input.noMoreToLoad,
    directMessageActive: input.directMessageActive,
    directMessageFocusActive: input.directMessageFocusActive,
    viewportAnchorActive: input.viewportAnchorActive,
    targetAnchorPreserved: input.targetAnchorPreserved,
    bottomAnchorSpacerPx: input.bottomAnchorSpacerPx,
  });
}
