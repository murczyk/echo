import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OrganismKeywordSetDto } from '../../../../Bindings';
import { fetchOrganismKeywordSets } from '../../services/api/organism-keyword-sets';
import { fetchAnalysisCallsignInfos } from '../../services/api/analysis';
import { fetchMessagesByIds } from '../../services/api/inbox-messages';
import { currentSystemSettings } from '../../services/api/system-settings';
import { mergeUpdatedDutyFeedMessages } from '../shared/message-card/message-card-message-updates';
import { INBOX_COUNT_POLL_INTERVAL_MS, sortMessageItemsByTime } from './utils';
import { attachDutyNotificationAudioPrimingListeners } from './notifications';
import { isNullOrUndefined, sortFrequenciesNumerically } from '../../utils/misc';
import { normalizeCallsignLookupValue } from '../../utils/callsign-normalization';
import { useRerDutyFeedState } from './useRerDutyFeedState';
import { useRerDutyFilterOptions } from './useRerDutyFilterOptions';
import { useRerDutyMessageActions } from './useRerDutyMessageActions';
import { collectUniqueCallsignsFromMessages, MAX_MESSAGE_FEEDS, stableStringify } from './utils';
import { useDutySettings } from '../../hooks/use-duty-settings';
import { useInboxChangedMessageIds } from '../shared/useInboxChangedMessageIds';
import { hasResolvedDutyCallsignInfo } from './useRerDutyCallsignInfo';
import type { DeviceAccess } from './useRerDutyPageSettings';

const CALLSIGN_LOOKUP_RETRY_BACKOFF_MS = 30_000;

export { MAX_MESSAGE_FEEDS };

export function effectiveDutyPollIntervalSec(configuredIntervalSec: number): number {
  return Math.max(
    INBOX_COUNT_POLL_INTERVAL_MS / 1000,
    Math.floor(configuredIntervalSec) || INBOX_COUNT_POLL_INTERVAL_MS / 1000,
  );
}

export function getPendingDutyCallsignLookups(params: {
  messageFeeds: Parameters<typeof collectUniqueCallsignsFromMessages>[0];
  enrichedCallsigns: ReadonlySet<string>;
  inboxCallsignInfoMap: Record<string, { res: unknown[] } | undefined>;
  loadingCallsigns: ReadonlySet<string>;
  emptyResultRetryAfterMs: ReadonlyMap<string, number>;
  nowMs: number;
}): string[] {
  const allCallsigns = collectUniqueCallsignsFromMessages(params.messageFeeds);
  return allCallsigns.filter((callsign) => {
    if (params.enrichedCallsigns.has(callsign)) return false;
    if (params.loadingCallsigns.has(callsign)) return false;
    const retryAfterMs = params.emptyResultRetryAfterMs.get(callsign) ?? 0;
    if (retryAfterMs > params.nowMs) return false;
    return true;
  });
}

export function mergeAvailableFrequencies(
  apiFreqs: readonly string[],
  messageFeeds: {
    items: [number, { freq?: string | null }][];
    filter: { freqsSelected?: string[] | null; freqsDenied?: string[] | null };
  }[],
): string[] {
  const frequencies = new Set<string>();
  const add = (value: string) => {
    const normalized = value.trim();
    if (normalized !== '') frequencies.add(normalized);
  };
  apiFreqs.forEach(add);
  messageFeeds.forEach((feed) => {
    feed.items.forEach(([, msg]) => {
      if (msg.freq) add(msg.freq);
    });
    (feed.filter.freqsSelected ?? []).forEach(add);
    (feed.filter.freqsDenied ?? []).forEach(add);
  });
  return sortFrequenciesNumerically([...frequencies]);
}

function mergePersistentUnitFilterValues(
  messageFeeds: { filter: { unitsSelected?: string[] | null; unitsDenied?: string[] | null } }[],
): string[] {
  const values = new Set<string>();
  const add = (value: string) => {
    const normalized = value.trim();
    if (normalized !== '') values.add(normalized);
  };
  messageFeeds.forEach((feed) => {
    (feed.filter.unitsSelected ?? []).forEach(add);
    (feed.filter.unitsDenied ?? []).forEach(add);
  });
  return [...values];
}

// Keeps group keys referenced by active feeds and saved filters so every Duty
// column can resolve persistent selections even when absent from the recent
// two-day catalog. This supports cross-column filter copy/paste.
export function mergeKnownGroupKeys(
  previousKeys: readonly string[],
  apiGroups: readonly string[],
  groupInfoKeys: readonly string[],
  messageFeeds: {
    items: [number, { groupMasterKey?: string | null }][];
    filter: { groupsSelected?: string[] | null; groupsDenied?: string[] | null };
  }[],
  savedFilters: Array<{ groupsSelected?: string[] | null; groupsDenied?: string[] | null }> = [],
): string[] {
  const known = new Set<string>();
  const add = (key: string) => {
    const normalized = key.trim();
    if (normalized !== '') known.add(normalized);
  };
  [...previousKeys, ...apiGroups, ...groupInfoKeys].forEach(add);
  messageFeeds.forEach((feed) =>
    feed.items.forEach(([, msg]) => {
      if (msg.groupMasterKey) add(msg.groupMasterKey);
    }),
  );
  messageFeeds.forEach((feed) => {
    (feed.filter.groupsSelected ?? []).forEach(add);
    (feed.filter.groupsDenied ?? []).forEach(add);
  });
  savedFilters.forEach((filter) => {
    (filter.groupsSelected ?? []).forEach(add);
    (filter.groupsDenied ?? []).forEach(add);
  });
  return [...known];
}

function mergePostsFromMessages(
  apiPosts: string[],
  messageFeeds: {
    items: [number, { post?: string | null }][];
    filter: { postsSelected?: string[] | null; postsDenied?: string[] | null };
  }[],
): string[] {
  const fromMsgs = new Set<string>();
  messageFeeds.forEach((feed) =>
    feed.items.forEach(([, msg]) => {
      if (msg.post && msg.post.trim() !== '') fromMsgs.add(msg.post.trim());
    }),
  );
  messageFeeds.forEach((feed) => {
    (feed.filter.postsSelected ?? []).forEach((post) => {
      if (post.trim() !== '') fromMsgs.add(post.trim());
    });
    (feed.filter.postsDenied ?? []).forEach((post) => {
      if (post.trim() !== '') fromMsgs.add(post.trim());
    });
  });
  const merged = new Set<string>([...apiPosts, ...fromMsgs]);
  return [...merged].sort((a, b) => a.localeCompare(b));
}

export function useRerDutyFeeds(
  authUserName: string | null,
  currentUserOrganismId: number | null = null,
  deviceAccess: DeviceAccess = { status: 'loading' },
) {
  const [keywordSets, setKeywordSets] = useState<OrganismKeywordSetDto[]>([]);
  const reloadKeywordSets = useCallback(async () => {
    const sets = await fetchOrganismKeywordSets();
    setKeywordSets(sets);
  }, []);
  const filterOpts = useRerDutyFilterOptions();
  const [pollIntervalSec, setPollIntervalSec] = useState(INBOX_COUNT_POLL_INTERVAL_MS / 1000);
  const dutySettings = useDutySettings();
  const messageSortByRef = useRef(dutySettings.messageSortBy);
  const lastInboxEventPollAtRef = useRef(Number.NEGATIVE_INFINITY);
  // Until the persisted preference is known (or after it fails), Duty must not make an
  // automatic positioning decision from the optimistic default.
  const dutyDisableAutoScroll =
    dutySettings.loadInProgress ||
    dutySettings.loadError !== null ||
    dutySettings.disableAutoScroll;
  const initialPositioningReady = !dutySettings.loadInProgress;
  const [callsignRetryVersion, setCallsignRetryVersion] = useState(0);
  const [knownGroupKeys, setKnownGroupKeys] = useState<string[]>([]);
  const loadingCallsignsRef = useRef<Set<string>>(new Set());
  const enrichedCallsignsRef = useRef<Set<string>>(new Set());
  const emptyResultRetryAfterMsRef = useRef<Map<string, number>>(new Map());
  const callsignRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUnmountedRef = useRef(false);
  const feedState = useRerDutyFeedState({
    freqs: filterOpts.freqs,
    setProfiles: filterOpts.setProfiles,
    setGroupInfos: filterOpts.setGroupInfos,
    pollIntervalSec: effectiveDutyPollIntervalSec(pollIntervalSec),
    disableAutoScroll: dutyDisableAutoScroll,
    deviceAccess,
    messageSortBy: dutySettings.messageSortBy === 'creation' ? 'IMSCreatedAt' : 'IMSTimestamp',
    onFeedRemoved: filterOpts.pruneSavedFilterUiState,
  });
  const setFeedError = feedState.setError;
  useEffect(() => {
    if (deviceAccess.status === 'error') setFeedError(deviceAccess.message);
  }, [deviceAccess, setFeedError]);
  useEffect(() => {
    let cancelled = false;
    fetchOrganismKeywordSets()
      .then((sets) => {
        if (cancelled) return;
        setKeywordSets(sets);
      })
      .catch((error) => {
        if (cancelled) return;
        const detail = error instanceof Error ? error.message : String(error);
        setFeedError(`Не вдалося завантажити набори ключових слів: ${detail}`);
        console.error(error);
      });
    return () => {
      cancelled = true;
    };
  }, [setFeedError]);
  useEffect(() => attachDutyNotificationAudioPrimingListeners(), []);
  useEffect(() => {
    let cancelled = false;
    currentSystemSettings()
      .then((settings) => {
        if (cancelled) return;
        setPollIntervalSec(settings.rerDutyPollIntervalSec);
      })
      .catch((error) => {
        if (cancelled) return;
        setFeedError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [setFeedError]);
  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
      if (callsignRetryTimeoutRef.current) {
        clearTimeout(callsignRetryTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (dutyDisableAutoScroll) feedState.setWatchModeByFeedId({});
  }, [dutyDisableAutoScroll, feedState.setWatchModeByFeedId]);
  useEffect(() => {
    if (dutySettings.loadError) feedState.setError(dutySettings.loadError);
  }, [dutySettings.loadError, feedState.setError]);
  useEffect(() => {
    if (messageSortByRef.current === dutySettings.messageSortBy) return;
    messageSortByRef.current = dutySettings.messageSortBy;
    feedState.reloadFeedsPreservingUnread();
  }, [dutySettings.messageSortBy, feedState.reloadFeedsPreservingUnread]);

  useInboxChangedMessageIds({
    onMessageIds: async (messageIds) => {
      const now = Date.now();
      const poll =
        now - lastInboxEventPollAtRef.current >= INBOX_COUNT_POLL_INTERVAL_MS
          ? (() => {
              lastInboxEventPollAtRef.current = now;
              return feedState.pollNow();
            })()
          : Promise.resolve();
      const refreshes = feedState.messageFeeds.flatMap((feed) => {
        const visibleMessageIds = new Set(feed.items.map(([messageId]) => messageId));
        const visibleChangedMessageIds = Array.from(
          new Set(messageIds.filter((messageId) => visibleMessageIds.has(messageId))),
        );
        if (visibleChangedMessageIds.length === 0) return [];
        const inboxReq = feedState.buildReqForFeed(feed, { loadLatest: true });
        return [
          {
            feedId: feed.id,
            messageIds: visibleChangedMessageIds,
            inboxReq,
            requestSignature: stableStringify(inboxReq),
            loadGeneration: feedState.getFeedLoadGeneration(feed.id),
          },
        ];
      });

      if (refreshes.length === 0) {
        await poll;
        return;
      }

      await Promise.all([
        poll,
        ...refreshes.map(
          async ({
            feedId,
            messageIds: visibleChangedMessageIds,
            inboxReq,
            requestSignature,
            loadGeneration,
          }) => {
            try {
              const nextMessages = await fetchMessagesByIds(visibleChangedMessageIds, inboxReq);
              feedState.setMessageFeeds((current) =>
                (() => {
                  const currentFeed = current.find((feed) => feed.id === feedId);
                  if (currentFeed == null) return current;
                  if (feedState.getFeedLoadGeneration(feedId) !== loadGeneration) return current;
                  const currentSignature = stableStringify(
                    feedState.buildReqForFeed(currentFeed, { loadLatest: true }),
                  );
                  if (currentSignature !== requestSignature) return current;
                  return mergeUpdatedDutyFeedMessages(
                    current,
                    feedId,
                    visibleChangedMessageIds,
                    nextMessages,
                  );
                })(),
              );
            } catch (loadError) {
              feedState.setError(
                loadError instanceof Error ? loadError.message : String(loadError),
              );
              console.error(loadError);
            }
          },
        ),
      ]);
    },
  });

  useEffect(() => {
    const nowMs = Date.now();
    const pendingCallsigns = getPendingDutyCallsignLookups({
      messageFeeds: feedState.messageFeeds,
      enrichedCallsigns: enrichedCallsignsRef.current,
      inboxCallsignInfoMap: feedState.inboxCallsignInfoMap,
      loadingCallsigns: loadingCallsignsRef.current,
      emptyResultRetryAfterMs: emptyResultRetryAfterMsRef.current,
      nowMs,
    });
    if (pendingCallsigns.length === 0) return;

    pendingCallsigns.forEach((callsign) => loadingCallsignsRef.current.add(callsign));
    fetchAnalysisCallsignInfos(pendingCallsigns)
      .then((items) => {
        if (isUnmountedRef.current) return;
        let retryMapChanged = false;
        const returnedByCallsign = new Map(
          items.map((item) => [normalizeCallsignLookupValue(item.callsign), item] as const),
        );
        items.forEach((item) => {
          const key = normalizeCallsignLookupValue(item.callsign);
          if (hasResolvedDutyCallsignInfo(item)) {
            enrichedCallsignsRef.current.add(key);
            retryMapChanged = emptyResultRetryAfterMsRef.current.delete(key) || retryMapChanged;
            return;
          }
          enrichedCallsignsRef.current.delete(key);
          emptyResultRetryAfterMsRef.current.set(key, nowMs + CALLSIGN_LOOKUP_RETRY_BACKOFF_MS);
          retryMapChanged = true;
        });
        pendingCallsigns.forEach((callsign) => {
          if (!returnedByCallsign.has(callsign)) {
            enrichedCallsignsRef.current.delete(callsign);
            emptyResultRetryAfterMsRef.current.set(
              callsign,
              nowMs + CALLSIGN_LOOKUP_RETRY_BACKOFF_MS,
            );
            retryMapChanged = true;
          }
        });
        if (retryMapChanged) {
          setCallsignRetryVersion((current) => current + 1);
        }
        feedState.mergeResolvedCallsigns(items);
      })
      .catch((error) => {
        if (isUnmountedRef.current) return;
        pendingCallsigns.forEach((callsign) => {
          enrichedCallsignsRef.current.delete(callsign);
          emptyResultRetryAfterMsRef.current.set(
            callsign,
            nowMs + CALLSIGN_LOOKUP_RETRY_BACKOFF_MS,
          );
        });
        setCallsignRetryVersion((current) => current + 1);
        setFeedError(`Не вдалося завантажити довідку позивних`);
        console.error(error);
      })
      .finally(() => {
        pendingCallsigns.forEach((callsign) => loadingCallsignsRef.current.delete(callsign));
      });
  }, [
    callsignRetryVersion,
    feedState.messageFeeds,
    feedState.inboxCallsignInfoMap,
    feedState.mergeResolvedCallsigns,
    setFeedError,
  ]);

  useEffect(() => {
    if (callsignRetryTimeoutRef.current) {
      clearTimeout(callsignRetryTimeoutRef.current);
      callsignRetryTimeoutRef.current = null;
    }

    const trackedCallsigns = collectUniqueCallsignsFromMessages(feedState.messageFeeds);
    if (trackedCallsigns.length === 0) return;

    const nowMs = Date.now();
    let nextRetryAtMs: number | null = null;
    trackedCallsigns.forEach((callsign) => {
      if (enrichedCallsignsRef.current.has(callsign)) return;
      if (loadingCallsignsRef.current.has(callsign)) return;
      const retryAtMs = emptyResultRetryAfterMsRef.current.get(callsign);
      if (isNullOrUndefined(retryAtMs) || retryAtMs <= nowMs) return;
      if (isNullOrUndefined(nextRetryAtMs) || retryAtMs < nextRetryAtMs) {
        nextRetryAtMs = retryAtMs;
      }
    });

    if (isNullOrUndefined(nextRetryAtMs)) return;

    callsignRetryTimeoutRef.current = setTimeout(
      () => {
        callsignRetryTimeoutRef.current = null;
        setCallsignRetryVersion((current) => current + 1);
      },
      Math.max(0, nextRetryAtMs - nowMs),
    );

    return () => {
      if (callsignRetryTimeoutRef.current) {
        clearTimeout(callsignRetryTimeoutRef.current);
        callsignRetryTimeoutRef.current = null;
      }
    };
  }, [callsignRetryVersion, feedState.messageFeeds]);

  const actions = useRerDutyMessageActions({
    messageFeeds: feedState.messageFeeds,
    setMessageFeeds: feedState.setMessageFeeds,
    setError: feedState.setError,
    applyFilter: feedState.applyFilter,
    loadFeedInitialMessages: feedState.loadFeedInitialMessages,
    loadFeedNewerMessages: feedState.loadFeedNewerMessages,
    flushPendingNewerMessages: feedState.flushPendingNewerMessages,
    showArrowResult: feedState.showArrowResult,
    columnRefsRef: feedState.columnRefsRef,
    setWatchModeByFeedId: feedState.setWatchModeByFeedId,
    setLoadingNewerFeedIds: feedState.setLoadingNewerFeedIds,
    requestValidatedInboxCount: feedState.requestValidatedInboxCount,
    catchUpFeedUnreadToTail: feedState.catchUpFeedUnreadToTail,
    authUserName,
    currentUserOrganismId,
    profiles: filterOpts.profiles,
    groupInfos: filterOpts.groupInfos,
    tagsMap: filterOpts.tagsMap,
    tagsOrder: filterOpts.tagsOrder,
    savedFilters: filterOpts.savedFilters,
    setSavedFilters: filterOpts.setSavedFilters,
    selectedSavedIdByFeedId: filterOpts.selectedSavedIdByFeedId,
    setSelectedSavedIdByFeedId: filterOpts.setSelectedSavedIdByFeedId,
    saveFilterNameByFeedId: filterOpts.saveFilterNameByFeedId,
    setSaveFilterNameByFeedId: filterOpts.setSaveFilterNameByFeedId,
    dutyDisableAutoScroll,
    beginExplicitNavigation: feedState.beginExplicitNavigation,
    isExplicitNavigationCurrent: feedState.isExplicitNavigationCurrent,
    registerExplicitLanding: feedState.registerExplicitLanding,
    registerExplicitLoading: feedState.registerExplicitLoading,
    cancelExplicitNavigation: feedState.cancelExplicitNavigation,
    registerExplicitScheduledWork: feedState.registerExplicitScheduledWork,
    clearExplicitScheduledWork: feedState.clearExplicitScheduledWork,
    getExplicitScrollNavigation: feedState.getExplicitScrollNavigation,
  });

  const freqs = useMemo(
    () => mergeAvailableFrequencies(filterOpts.freqs, feedState.messageFeeds),
    [filterOpts.freqs, feedState.messageFeeds],
  );
  const persistentUnitFilterValues = useMemo(
    () => mergePersistentUnitFilterValues(feedState.messageFeeds),
    [feedState.messageFeeds],
  );
  const recentGroupKeys = filterOpts.groupsList;
  const availableGroupKeys = useMemo(
    () =>
      mergeKnownGroupKeys(
        knownGroupKeys,
        recentGroupKeys,
        Object.keys(filterOpts.groupInfos),
        feedState.messageFeeds,
        filterOpts.savedFilters.map(({ req }) => req),
      ),
    [
      feedState.messageFeeds,
      filterOpts.groupInfos,
      recentGroupKeys,
      filterOpts.savedFilters,
      knownGroupKeys,
    ],
  );
  useEffect(() => {
    setKnownGroupKeys((previous) => {
      const next = mergeKnownGroupKeys(
        previous,
        recentGroupKeys,
        Object.keys(filterOpts.groupInfos),
        feedState.messageFeeds,
        filterOpts.savedFilters.map(({ req }) => req),
      );
      return next.length === previous.length && next.every((key, index) => key === previous[index])
        ? previous
        : next;
    });
  }, [feedState.messageFeeds, filterOpts.groupInfos, recentGroupKeys, filterOpts.savedFilters]);
  const postsList = useMemo(
    () => mergePostsFromMessages(filterOpts.postsList, feedState.messageFeeds),
    [filterOpts.postsList, feedState.messageFeeds],
  );
  return {
    messageFeeds: feedState.messageFeeds,
    setMessageFeeds: feedState.setMessageFeeds,
    error: feedState.error,
    errorNotificationVersion: feedState.errorNotificationVersion,
    clearDutyError: () => feedState.setError(null),
    authUserName,
    columnRefsRef: feedState.columnRefsRef,
    nearBottomByFeedIdRef: feedState.nearBottomByFeedIdRef,
    atBottomByFeedIdRef: feedState.atBottomByFeedIdRef,
    physicallyAtBottomByFeedIdRef: feedState.physicallyAtBottomByFeedIdRef,
    tailAvailabilityByFeedId: feedState.tailAvailabilityByFeedId,
    confirmedTailPreviewByFeedId: feedState.confirmedTailPreviewByFeedId,
    beginFollowTail: feedState.beginFollowTail,
    ensureFollowTail: feedState.ensureFollowTail,
    cancelFollowTail: feedState.cancelFollowTail,
    dutyDisableAutoScroll,
    initialPositioningReady,
    createMessageFeed: feedState.createMessageFeed,
    removeMessageFeed: feedState.removeMessageFeed,
    loadFeedInitialMessages: feedState.loadFeedInitialMessages,
    reloadEmptyFeeds: feedState.reloadEmptyFeeds,
    reloadFeeds: feedState.reloadFeeds,
    reloadEditedFeeds: feedState.reloadEditedFeeds,
    loadFeedOlderMessages: feedState.loadFeedOlderMessages,
    loadFeedNewerMessages: feedState.loadFeedNewerMessages,
    flushPendingNewerMessages: feedState.flushPendingNewerMessages,
    applyFilter: feedState.applyFilter,
    toggleGroup: feedState.toggleGroup,
    selectAllGroups: feedState.selectAllGroups,
    handleSaveFilter: actions.handleSaveFilter,
    handleApplySavedFilter: actions.handleApplySavedFilter,
    handleUpdateSelectedSavedFilter: actions.handleUpdateSelectedSavedFilter,
    handleRenameSelectedSavedFilter: actions.handleRenameSelectedSavedFilter,
    handleDeleteSelectedSavedFilter: actions.handleDeleteSelectedSavedFilter,
    handleDeleteSavedFilter: actions.handleDeleteSavedFilter,
    handleMessageBookmark: actions.handleMessageBookmark,
    handleMessageImportant: actions.handleMessageImportant,
    handleMessageCopy: actions.handleMessageCopy,
    handleOpenPointsOnMap: actions.handleOpenPointsOnMap,
    onAddPointHighlightBlacklist: actions.onAddPointHighlightBlacklist,
    handleDeleteConfirm: actions.handleDeleteConfirm,
    setDeleteConfirmId: actions.setDeleteConfirmId,
    setDeleteConfirmFeedId: actions.setDeleteConfirmFeedId,
    handleToggleTag: actions.handleToggleTag,
    botTagAction: actions.botTagAction,
    onCancelBotTagAction: actions.onCancelBotTagAction,
    onMarkBotTagWrong: actions.onMarkBotTagWrong,
    handleArrowClick: actions.handleArrowClick,
    handleVisibleMessageIds: actions.handleVisibleMessageIds,
    deleteConfirmId: actions.deleteConfirmId,
    deleteConfirmFeedId: actions.deleteConfirmFeedId,
    profiles: filterOpts.profiles,
    senderOptions: actions.senderOptions,
    freqs,
    postsList,
    // Shared persistent group catalog for every Duty column.
    groupsList: availableGroupKeys,
    groupInfos: filterOpts.groupInfos,
    tagsMap: filterOpts.tagsMap,
    tagsOrder: filterOpts.tagsOrder,
    tagIdsList: actions.tagIdsList,
    savedFilters: filterOpts.savedFilters,
    selectedSavedIdByFeedId: filterOpts.selectedSavedIdByFeedId,
    setSelectedSavedIdByFeedId: filterOpts.setSelectedSavedIdByFeedId,
    saveFilterNameByFeedId: filterOpts.saveFilterNameByFeedId,
    setSaveFilterNameByFeedId: filterOpts.setSaveFilterNameByFeedId,
    reloadFreqsLoading: filterOpts.reloadFreqsLoading,
    reloadLatestFrequencies: filterOpts.reloadLatestFrequencies,
    groupCatalogLoading: filterOpts.groupCatalogLoading,
    groupCatalogError: filterOpts.groupCatalogError,
    reloadGroupCatalog: filterOpts.reloadGroupCatalog,
    networkDisplayMap: feedState.networkDisplayMap,
    networkMap: feedState.networkMap,
    unitsMap: feedState.unitsMap,
    persistentUnitFilterValues,
    callsignInfoMap: feedState.callsignInfoMap,
    featureStrictNetworks: filterOpts.featureStrictNetworks,
    watchModeByFeedId: feedState.watchModeByFeedId,
    setWatchModeByFeedId: feedState.setWatchModeByFeedId,
    loadingNewerFeedIds: feedState.loadingNewerFeedIds,
    arrowResultByFeedId: feedState.arrowResultByFeedId,
    copiedFeedbackId: actions.copiedFeedbackId,
    handleEditedMessage: actions.handleEditedMessage,
    keywordSets,
    reloadKeywordSets,
    setFeedInitialTarget: feedState.setFeedInitialTarget,
  };
}
