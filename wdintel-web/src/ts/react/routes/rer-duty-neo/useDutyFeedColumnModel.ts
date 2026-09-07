import type { InboxMessage, User } from '../../../../Bindings';
import type { MessageTextPreviewLineLimit } from '../../services/api/user-settings';
import type { FeedColumnModel } from './types';
import { useDutyFeedColumnActions, type RerDutyFeedsBundle } from './useDutyFeedColumnActions';
import {
  feedIndicatorUnreadCount,
  feedNeedsUnreadPrefetch,
  type MessageFeedState,
  type TagsLayoutVariant,
} from './utils';

export type DutyFeedColumnModelDeps = {
  feeds: RerDutyFeedsBundle;
  narrowScreen: boolean;
  authUserName: string | null;
  currentUser: User | null;
  tagsLayout: TagsLayoutVariant;
  collapseMediaPreviews: boolean;
  mediaSummaryEnabled: boolean;
  messageTextPreviewLines: MessageTextPreviewLineLimit;
  openReportEditor: (reportId: number) => void;
  openMessageEditor: (target: { id: number; message: InboxMessage }) => void;
  openReportComposer: (source: { id: number; message: InboxMessage }) => void;
};

function dutyFeedColumnMaxWidth(feedCount: number, narrow: boolean): string {
  if (narrow) return '100%';
  if (feedCount <= 1) return '960px';
  return '100%';
}

function buildFeedColumnView(
  feed: MessageFeedState,
  deps: DutyFeedColumnModelDeps,
): FeedColumnModel['view'] {
  const {
    messageFeeds,
    dutyDisableAutoScroll,
    initialPositioningReady,
    watchModeByFeedId,
    loadingNewerFeedIds,
    arrowResultByFeedId,
    confirmedTailPreviewByFeedId,
    nearBottomByFeedIdRef,
    physicallyAtBottomByFeedIdRef,
    tailAvailabilityByFeedId,
  } = deps.feeds;
  return {
    narrowScreen: deps.narrowScreen,
    feedCount: messageFeeds.length,
    canRemove: messageFeeds.length > 1,
    maxWidth: dutyFeedColumnMaxWidth(messageFeeds.length, deps.narrowScreen),
    isWatchMode: !dutyDisableAutoScroll && (watchModeByFeedId[feed.id] ?? true),
    autoScrollAllowed: !dutyDisableAutoScroll,
    initialPositioningReady,
    loadingNewer: loadingNewerFeedIds.has(feed.id),
    arrowResultMessage: arrowResultByFeedId[feed.id] ?? null,
    bottomUnreadCount: feedIndicatorUnreadCount(feed, confirmedTailPreviewByFeedId[feed.id], {
      // Near-bottom: keep matching tail preview (real beyond-tail pending); only drop residual stock.
      includeBeyondTailResidual: nearBottomByFeedIdRef.current[feed.id] !== true,
    }),
    physicallyAtBottom:
      feed.items.length === 0 ? true : (physicallyAtBottomByFeedIdRef.current[feed.id] ?? false),
    tailAvailability: tailAvailabilityByFeedId[feed.id] ?? 'unknown',
    unreadPrefetchNeeded: feedNeedsUnreadPrefetch(feed),
    // OFF blocks following, not anchor-preserving manual reading through buffered arrivals.
    pendingNewerFlushNeeded: (feed.pendingNewerItems?.length ?? 0) > 0,
  };
}

function buildFeedFilterPanel(
  feed: MessageFeedState,
  deps: DutyFeedColumnModelDeps,
): FeedColumnModel['filterPanel'] {
  const {
    groupsList,
    groupInfos,
    profiles,
    senderOptions,
    freqs,
    postsList,
    unitsMap,
    persistentUnitFilterValues,
    reloadFreqsLoading,
    groupCatalogLoading,
    groupCatalogError,
    savedFilters,
    selectedSavedIdByFeedId,
    saveFilterNameByFeedId,
    setSelectedSavedIdByFeedId,
    setSaveFilterNameByFeedId,
    setMessageFeeds,
    applyFilter,
    loadFeedInitialMessages,
    reloadLatestFrequencies,
    reloadGroupCatalog,
    handleSaveFilter,
    handleUpdateSelectedSavedFilter,
    handleRenameSelectedSavedFilter,
    handleDeleteSelectedSavedFilter,
    handleApplySavedFilter,
  } = deps.feeds;

  return {
    feedId: feed.id,
    filterState: {
      groupsSelected: feed.filter.groupsSelected ?? [],
      deniedGroups: feed.filter.groupsDenied ?? [],
      sendersSelected: feed.filter.sendersSelected ?? [],
      deniedSenders: feed.filter.deniedSenders ?? [],
      freqsSelected: feed.filter.freqsSelected ?? [],
      freqsDenied: feed.filter.freqsDenied ?? [],
      postsSelected: feed.filter.postsSelected ?? [],
      postsDenied: feed.filter.postsDenied ?? [],
      unitsSelected: feed.filter.unitsSelected ?? [],
      unitsDenied: feed.filter.unitsDenied ?? [],
    },
    sources: {
      groupsList,
      groupInfos,
      profiles,
      senderOptions,
      freqs,
      postsList,
      unitsList: Object.values(unitsMap),
      persistentUnitFilterValues,
    },
    toggles: {
      adjacentFreqsRange: feed.adjacentFreqsRange,
      highlightSignalsEnabled: feed.highlightSignalsEnabled,
      onlyMyUnitTagsEnabled: feed.onlyMyUnitTagsEnabled,
      unitsExactMatchOnly: feed.filter.unitsExactMatchOnly ?? undefined,
      reloadFreqsLoading,
      groupCatalogLoading,
      groupCatalogError,
    },
    savedFilters: {
      savedFilters,
      selectedSavedId: selectedSavedIdByFeedId[feed.id] ?? null,
      saveFilterName: saveFilterNameByFeedId[feed.id] ?? '',
    },
    actions: {
      onGroupsChange: (v: string[]) =>
        applyFilter(feed.id, { ...feed.filter, groupsSelected: v.length ? v : null }),
      onDeniedGroupsChange: (v: string[]) =>
        applyFilter(feed.id, { ...feed.filter, groupsDenied: v.length ? v : null }),
      onGroupsModeTransfer: ({ includeValues, excludeValues }) =>
        applyFilter(feed.id, {
          ...feed.filter,
          groupsSelected: includeValues.length ? includeValues : null,
          groupsDenied: excludeValues.length ? excludeValues : null,
        }),
      onSendersChange: (v: string[]) =>
        applyFilter(feed.id, { ...feed.filter, sendersSelected: v.length ? v : null }),
      onDeniedSendersChange: (v: string[]) =>
        applyFilter(feed.id, { ...feed.filter, deniedSenders: v.length ? v : null }),
      onSendersModeTransfer: ({ includeValues, excludeValues }) =>
        applyFilter(feed.id, {
          ...feed.filter,
          sendersSelected: includeValues.length ? includeValues : null,
          deniedSenders: excludeValues.length ? excludeValues : null,
        }),
      onFreqsChange: (v: string[]) =>
        applyFilter(feed.id, { ...feed.filter, freqsSelected: v.length ? v : null }),
      onFreqsDeniedChange: (v: string[]) =>
        applyFilter(feed.id, { ...feed.filter, freqsDenied: v.length ? v : null }),
      onFreqsModeTransfer: ({ includeValues, excludeValues }) =>
        applyFilter(feed.id, {
          ...feed.filter,
          freqsSelected: includeValues.length ? includeValues : null,
          freqsDenied: excludeValues.length ? excludeValues : null,
        }),
      onPostsChange: (v: string[]) =>
        applyFilter(feed.id, { ...feed.filter, postsSelected: v.length ? v : null }),
      onPostsDeniedChange: (v: string[]) =>
        applyFilter(feed.id, { ...feed.filter, postsDenied: v.length ? v : null }),
      onPostsModeTransfer: ({ includeValues, excludeValues }) =>
        applyFilter(feed.id, {
          ...feed.filter,
          postsSelected: includeValues.length ? includeValues : null,
          postsDenied: excludeValues.length ? excludeValues : null,
        }),
      onUnitsChange: (v: string[]) =>
        applyFilter(feed.id, { ...feed.filter, unitsSelected: v.length ? v : null }),
      onUnitsDeniedChange: (v: string[]) =>
        applyFilter(feed.id, { ...feed.filter, unitsDenied: v.length ? v : null }),
      onUnitsModeTransfer: ({ includeValues, excludeValues }) =>
        applyFilter(feed.id, {
          ...feed.filter,
          unitsSelected: includeValues.length ? includeValues : null,
          unitsDenied: excludeValues.length ? excludeValues : null,
        }),
      onUnitsExactMatchOnlyChange: (v: boolean) =>
        applyFilter(feed.id, { ...feed.filter, unitsExactMatchOnly: v }),
      onAdjacentFreqsRangeChange: (v: number) =>
        setMessageFeeds((prev) =>
          prev.map((f) => (f.id === feed.id ? { ...f, adjacentFreqsRange: v } : f)),
        ),
      onHighlightSignalsChange: (v: boolean) => {
        setMessageFeeds((prev) =>
          prev.map((f) => (f.id === feed.id ? { ...f, highlightSignalsEnabled: v } : f)),
        );
        loadFeedInitialMessages(feed.id, { highlightSignalsEnabled: v });
      },
      onOnlyMyUnitTagsChange: (v: boolean) => {
        setMessageFeeds((prev) =>
          prev.map((f) => (f.id === feed.id ? { ...f, onlyMyUnitTagsEnabled: v } : f)),
        );
      },
      onReloadFreqs: reloadLatestFrequencies,
      onReloadGroupCatalog: reloadGroupCatalog,
      onSavedFilterSelect: (id) =>
        setSelectedSavedIdByFeedId((prev) => ({ ...prev, [feed.id]: id === '' ? null : id })),
      onSaveFilterNameChange: (value) =>
        setSaveFilterNameByFeedId((prev) => ({ ...prev, [feed.id]: value })),
      onSaveFilter: handleSaveFilter,
      onUpdateSelectedSavedFilter: handleUpdateSelectedSavedFilter,
      onRenameSelectedSavedFilter: handleRenameSelectedSavedFilter,
      onDeleteSelectedSavedFilter: handleDeleteSelectedSavedFilter,
      onApplySavedFilter: (saved) => handleApplySavedFilter(feed.id, saved),
    },
  };
}

function buildFeedMessageCard(
  feed: MessageFeedState,
  deps: DutyFeedColumnModelDeps,
): FeedColumnModel['messageCard'] {
  const {
    copiedFeedbackId,
    networkDisplayMap,
    networkMap,
    unitsMap,
    callsignInfoMap,
    groupInfos,
    profiles,
    featureStrictNetworks,
    tagsMap,
    tagsOrder,
    botTagAction,
    onCancelBotTagAction,
    onMarkBotTagWrong,
    handleOpenPointsOnMap,
    onAddPointHighlightBlacklist,
  } = deps.feeds;
  return {
    authUserName: deps.authUserName,
    tagContributionsOrganismId: feed.onlyMyUnitTagsEnabled
      ? (deps.currentUser?.organismId ?? undefined)
      : undefined,
    copiedFeedbackId,
    networkDisplayMap,
    networkMap,
    unitsMap,
    callsignInfoMap,
    groupInfos,
    profiles,
    featureStrictNetworks,
    tagsLayout: deps.tagsLayout,
    collapseMediaPreviews: deps.collapseMediaPreviews,
    mediaSummaryEnabled: deps.mediaSummaryEnabled,
    messageTextPreviewLines: deps.messageTextPreviewLines,
    tagsMap,
    tagsOrder,
    botTagAction,
    onCancelBotTagAction,
    onMarkBotTagWrong,
    onOpenPointsOnMap: handleOpenPointsOnMap,
    onAddPointHighlightBlacklist,
  };
}

/** Assembles the per-column view model consumed by the Duty workspace. */
export function useDutyFeedColumnModel(
  deps: DutyFeedColumnModelDeps,
): (feed: MessageFeedState) => FeedColumnModel {
  const getStableFeedActions = useDutyFeedColumnActions({
    feeds: deps.feeds,
    openReportEditor: deps.openReportEditor,
    openMessageEditor: deps.openMessageEditor,
    openReportComposer: deps.openReportComposer,
  });

  return (feed: MessageFeedState) => ({
    feed,
    view: buildFeedColumnView(feed, deps),
    filterPanel: buildFeedFilterPanel(feed, deps),
    keywordsPanel: {
      keywordSets: deps.feeds.keywordSets,
      onFilterChange: deps.feeds.applyFilter,
      onKeywordSetsReload: deps.feeds.reloadKeywordSets,
    },
    messageCard: buildFeedMessageCard(feed, deps),
    actions: getStableFeedActions(feed),
  });
}
