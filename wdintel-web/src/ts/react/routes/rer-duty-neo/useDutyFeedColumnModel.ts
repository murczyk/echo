import type { InboxMessage, User } from '../../../../Bindings';
import type { MessageTextPreviewLineLimit } from '../../services/api/user-settings';
import type { FeedColumnModel } from './types';
import type { MessageCardEtalonDisplayModel } from '../shared/message-card/message-card.utils';
import type { GroupScope } from '../shared/group-navigation';
import type { MessageFeedFocus } from '../shared/message-feed';
import { groupFilterScope } from '../shared/group-navigation';
import { useDutyUnreadBoundaries } from './useDutyUnreadBoundaries';
import { useDutyFeedColumnActions, type RerDutyFeedsBundle } from './useDutyFeedColumnActions';
import {
  clearActiveFeedFilter,
  feedIndicatorUnreadCount,
  feedNeedsUnreadPrefetch,
  hasActiveFeedFilter,
  type MessageFeedState,
  stableStringify,
  type TagsLayoutVariant,
} from './utils';
import { DUTY_SINGLE_FEED_MAX_WIDTH_PX } from './duty-layout';

export type DutyFeedColumnModelDeps = {
  feeds: RerDutyFeedsBundle;
  searchColumnFor?: (feed: MessageFeedState) => FeedColumnModel['search'];
  editorSourceFeedId: string | null;
  editorHighlightedMessageId: number | null;
  linkedMessageFocus?: { feedId: string; filterSignature: string; focus: MessageFeedFocus } | null;
  narrowScreen: boolean;
  authUserName: string | null;
  currentUser: User | null;
  canUseMessageDevices: boolean;
  tagsLayout: TagsLayoutVariant;
  hideBotTags: boolean;
  hideNetworks: boolean;
  dutySelectedGroupsEnabled: boolean;
  collapseMediaPreviews: boolean;
  mediaSummaryEnabled: boolean;
  messageTextPreviewLines: MessageTextPreviewLineLimit;
  importantOnlyMyOrganism: boolean;
  openReportEditor: (feedId: string, reportId: number, sourceMessageId: number) => void;
  openMessageEditor: (
    feedId: string,
    target: { id: number; message: InboxMessage },
    focusTarget?: HTMLElement,
  ) => void;
  openReportComposer: (
    feedId: string,
    source: {
      id: number;
      message: InboxMessage;
      senderName?: string | null;
      etalonDisplayModel: MessageCardEtalonDisplayModel;
    },
    focusTarget: HTMLElement,
  ) => void;
  selectGroupScope: (feedId: string, scope: GroupScope) => void;
};

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
    isExplicitNavigationLoading,
    arrowResultByFeedId,
    confirmedTailPreviewByFeedId,
    nearBottomByFeedIdRef,
    physicallyAtBottomByFeedIdRef,
    tailAvailabilityByFeedId,
  } = deps.feeds;
  return {
    enableDutySearch: deps.feeds.enableDutySearch,
    narrowScreen: deps.narrowScreen,
    linkedMessageFocus:
      deps.linkedMessageFocus?.feedId === feed.id &&
      deps.linkedMessageFocus.filterSignature === stableStringify(feed.filter)
        ? deps.linkedMessageFocus.focus
        : null,
    editorHighlightedMessageId:
      deps.editorSourceFeedId === feed.id ? deps.editorHighlightedMessageId : null,
    feedCount: messageFeeds.length,
    canRemove: messageFeeds.length > 1,
    maxWidth: messageFeeds.length === 1 ? DUTY_SINGLE_FEED_MAX_WIDTH_PX : '100%',
    isWatchMode: !dutyDisableAutoScroll && (watchModeByFeedId[feed.id] ?? true),
    autoScrollAllowed: !dutyDisableAutoScroll,
    initialPositioningReady,
    loadingNewer: loadingNewerFeedIds.has(feed.id),
    explicitNavigationLoading: isExplicitNavigationLoading(feed.id),
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

function buildLocationFilterActions(
  feed: MessageFeedState,
  feeds: RerDutyFeedsBundle,
): Pick<
  FeedColumnModel['filterPanel']['actions'],
  | 'onLocationsChange'
  | 'onLocationsDeniedChange'
  | 'onLocationsModeTransfer'
  | 'onIncludePelengLocationsChange'
  | 'onLoadLocations'
> {
  const { applyFilter, loadLocations } = feeds;
  return {
    onLocationsChange: (v: string[]) =>
      applyFilter(feed.id, { ...feed.filter, locationsSelected: v.length ? v : null }),
    onLocationsDeniedChange: (v: string[]) =>
      applyFilter(feed.id, { ...feed.filter, locationsDenied: v.length ? v : null }),
    onLocationsModeTransfer: ({ includeValues, excludeValues }) =>
      applyFilter(feed.id, {
        ...feed.filter,
        locationsSelected: includeValues.length ? includeValues : null,
        locationsDenied: excludeValues.length ? excludeValues : null,
      }),
    onIncludePelengLocationsChange: (v: boolean) =>
      applyFilter(feed.id, { ...feed.filter, includePelengLocations: v }),
    onLoadLocations: loadLocations,
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
    locationsList,
    locationsLoading,
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
    search: deps.feeds.enableDutySearch
      ? {
          queryState: { search: feed.filter.search ?? '', searchMode: feed.filter.searchMode },
          updateQueryState: (updates) => applyFilter(feed.id, { ...feed.filter, ...updates }),
        }
      : undefined,
    hideGroupSelection: Boolean(feed.groupScopeMasterKey),
    hasActiveFilter:
      hasActiveFeedFilter({
        ...feed.filter,
        ...(feed.groupScopeMasterKey ? { groupsSelected: null, groupsDenied: null } : {}),
        search: deps.feeds.enableDutySearch ? feed.filter.search : null,
      }) ||
      feed.adjacentFreqsRange !== 0 ||
      feed.highlightSignalsEnabled ||
      feed.onlyMyUnitTagsEnabled,
    filterState: {
      search: feed.filter.search,
      searchMode: feed.filter.searchMode,
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
      selectedDeviceNames: feed.filter.selectedDeviceNames ?? [],
      deniedDeviceNames: feed.filter.deniedDeviceNames ?? [],
      locationsSelected: feed.filter.locationsSelected ?? [],
      locationsDenied: feed.filter.locationsDenied ?? [],
      includePelengLocations: feed.filter.includePelengLocations,
    },
    sources: {
      groupsList,
      groupInfos,
      profiles,
      senderOptions,
      freqs,
      postsList,
      locationsList,
      unitsList: Object.values(unitsMap),
      unitStatsReq: deps.feeds.buildReqForFeed(feed, { loadLatest: true }),
      unitStatsRefreshIntervalMs: deps.feeds.pollIntervalMs,
      unitHierarchy: deps.feeds.unitHierarchy,
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
      locationsLoading,
    },
    devices: deps.canUseMessageDevices
      ? {
          onSelectedChange: (v: string[]) =>
            applyFilter(feed.id, { ...feed.filter, selectedDeviceNames: v.length ? v : null }),
          onDeniedChange: (v: string[]) =>
            applyFilter(feed.id, { ...feed.filter, deniedDeviceNames: v.length ? v : null }),
          onModeTransfer: ({ includeValues, excludeValues }) =>
            applyFilter(feed.id, {
              ...feed.filter,
              selectedDeviceNames: includeValues.length ? includeValues : null,
              deniedDeviceNames: excludeValues.length ? excludeValues : null,
            }),
        }
      : undefined,
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
      onUnitStatsError: deps.feeds.setError,
      onUnitsExactMatchOnlyChange: (v: boolean) =>
        applyFilter(feed.id, { ...feed.filter, unitsExactMatchOnly: v }),
      ...buildLocationFilterActions(feed, deps.feeds),
      onAdjacentFreqsRangeChange: (v: number) => {
        if (v === feed.adjacentFreqsRange) return;
        if (
          (feed.filter.freqsSelected?.length ?? 0) > 0 ||
          (feed.filter.freqsDenied?.length ?? 0) > 0
        ) {
          applyFilter(feed.id, feed.filter, true);
        }
        setMessageFeeds((prev) =>
          prev.map((f) => (f.id === feed.id ? { ...f, adjacentFreqsRange: v } : f)),
        );
      },
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
      onDiscardCurrentFilter: () => {
        setSelectedSavedIdByFeedId((prev) => ({ ...prev, [feed.id]: null }));
        setSaveFilterNameByFeedId((prev) => ({ ...prev, [feed.id]: '' }));
        const clearedFilter = {
          ...clearActiveFeedFilter(feed.filter),
          ...(feed.groupScopeMasterKey
            ? {
                groupsSelected: feed.filter.groupsSelected,
                groupsDenied: feed.filter.groupsDenied,
              }
            : {}),
        };
        if (feed.highlightSignalsEnabled) {
          applyFilter(feed.id, clearedFilter, true);
        } else {
          applyFilter(feed.id, clearedFilter);
        }
        setMessageFeeds((prev) =>
          prev.map((item) =>
            item.id === feed.id
              ? {
                  ...item,
                  adjacentFreqsRange: 0,
                  highlightSignalsEnabled: false,
                  onlyMyUnitTagsEnabled: false,
                  unitsIncludeChildren: true,
                }
              : item,
          ),
        );
      },
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
    hideBotTags: deps.hideBotTags,
    hideNetworks: deps.hideNetworks,
    collapseMediaPreviews: deps.collapseMediaPreviews,
    mediaSummaryEnabled: deps.mediaSummaryEnabled,
    messageTextPreviewLines: deps.messageTextPreviewLines,
    importantOnlyMyOrganism: deps.importantOnlyMyOrganism,
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
export function useDutyFeedColumnModel(deps: DutyFeedColumnModelDeps) {
  const { boundaries: unreadBoundaries, dismissUnreadBoundary } = useDutyUnreadBoundaries(
    deps.feeds.messageFeeds,
  );
  const getStableFeedActions = useDutyFeedColumnActions({
    feeds: deps.feeds,
    openReportEditor: deps.openReportEditor,
    openMessageEditor: deps.openMessageEditor,
    openReportComposer: deps.openReportComposer,
  });

  const buildFeedColumnModel = (feed: MessageFeedState): FeedColumnModel => ({
    feed,
    view: {
      ...buildFeedColumnView(feed, deps),
      unreadBoundaryMessageId: unreadBoundaries.get(feed.id)?.messageId ?? null,
    },
    filterPanel: buildFeedFilterPanel(feed, deps),
    search: deps.searchColumnFor?.(feed),
    groupNavigation: {
      scope: groupFilterScope(feed.filter.groupsSelected ?? []),
      showSelectedGroups: deps.dutySelectedGroupsEnabled,
      groupName: feed.groupScopeMasterKey
        ? (deps.feeds.groupInfos[feed.groupScopeMasterKey]?.name ?? feed.groupScopeMasterKey)
        : 'Всі групи',
      onSelect: (scope) => deps.selectGroupScope(feed.id, scope),
      onError: (error) =>
        deps.feeds.setError(error instanceof Error ? error.message : String(error)),
    },
    keywordsPanel: {
      keywordSets: deps.feeds.keywordSets,
      onFilterChange: deps.feeds.applyFilter,
      onKeywordSetsReload: deps.feeds.reloadKeywordSets,
    },
    messageCard: buildFeedMessageCard(feed, deps),
    actions: getStableFeedActions(feed),
  });
  return { buildFeedColumnModel, dismissUnreadBoundary };
}
