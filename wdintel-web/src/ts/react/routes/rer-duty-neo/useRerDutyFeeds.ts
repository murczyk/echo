import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchAnalysisCallsignInfos } from '../../services/api/analysis';
import { USER_SETTINGS_UPDATED_EVENT, fetchUserSettings } from '../../services/api/user-settings';
import { currentSystemSettings } from '../../services/api/system-settings';
import { attachDutyNotificationAudioPrimingListeners } from './notifications';
import { isNullOrUndefined, sortFrequenciesNumerically } from '../../utils/misc';
import { normalizeCallsignLookupValue } from '../../utils/callsign-normalization';
import { useRerDutyFeedState } from './useRerDutyFeedState';
import { useRerDutyFilterOptions } from './useRerDutyFilterOptions';
import { useRerDutyMessageActions } from './useRerDutyMessageActions';
import { collectUniqueCallsignsFromMessages } from './utils';

const MAX_MESSAGE_FEEDS = 4;
const CALLSIGN_LOOKUP_RETRY_BACKOFF_MS = 30_000;

export { MAX_MESSAGE_FEEDS };

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

/** Merge API freqs with frequencies from loaded messages. */
function mergeFreqsFromMessages(apiFreqs: string[], messageFeeds: { items: [number, { freq?: string | null }][] }[]): string[] {
  const fromMsgs = new Set<string>();
  messageFeeds.forEach((feed) =>
    feed.items.forEach(([, msg]) => {
      if (msg.freq && msg.freq.trim() !== '') fromMsgs.add(msg.freq.trim());
    })
  );
  const merged = new Set<string>([...apiFreqs, ...fromMsgs]);
  return sortFrequenciesNumerically([...merged]);
}

function mergeGroupsFromMessages(
  apiGroups: string[],
  messageFeeds: {
    items: [number, { groupMasterKey?: string | null }][];
    filter: { groupsSelected?: string[] | null; groupsDenied?: string[] | null };
  }[],
): string[] {
  const fromMsgs = new Set<string>();
  messageFeeds.forEach((feed) =>
    feed.items.forEach(([, msg]) => {
      if (msg.groupMasterKey && msg.groupMasterKey.trim() !== '') fromMsgs.add(msg.groupMasterKey.trim());
    })
  );
  messageFeeds.forEach((feed) => {
    (feed.filter.groupsSelected ?? []).forEach((key) => {
      if (key.trim() !== '') fromMsgs.add(key.trim());
    });
    (feed.filter.groupsDenied ?? []).forEach((key) => {
      if (key.trim() !== '') fromMsgs.add(key.trim());
    });
  });
  const merged = new Set<string>([...apiGroups, ...fromMsgs]);
  return [...merged].sort((a, b) => a.localeCompare(b));
}

function mergePostsFromMessages(
  apiPosts: string[],
  messageFeeds: { items: [number, { post?: string | null }][]; filter: { postsSelected?: string[] | null; postsDenied?: string[] | null } }[],
): string[] {
  const fromMsgs = new Set<string>();
  messageFeeds.forEach((feed) =>
    feed.items.forEach(([, msg]) => {
      if (msg.post && msg.post.trim() !== '') fromMsgs.add(msg.post.trim());
    })
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

export function useRerDutyFeeds(authUserName: string | null) {
  const filterOpts = useRerDutyFilterOptions();
  const [testEnabled, setTestEnabled] = useState(false);
  const [testSinceMs, setTestSinceMs] = useState(0);
  const [testLimit, setTestLimit] = useState(1);
  const [pollIntervalSec, setPollIntervalSec] = useState(1);
  const [dutyDisableAutoScroll, setDutyDisableAutoScroll] = useState(false);
  const [callsignRetryVersion, setCallsignRetryVersion] = useState(0);
  const loadingCallsignsRef = useRef<Set<string>>(new Set());
  const enrichedCallsignsRef = useRef<Set<string>>(new Set());
  const emptyResultRetryAfterMsRef = useRef<Map<string, number>>(new Map());
  const callsignRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUnmountedRef = useRef(false);
  const feedState = useRerDutyFeedState({
    freqs: filterOpts.freqs,
    setProfiles: filterOpts.setProfiles,
    setGroupInfos: filterOpts.setGroupInfos,
    testEnabled,
    testSinceMs,
    testLimit,
    pollIntervalSec,
    disableAutoScroll: dutyDisableAutoScroll,
    onFeedRemoved: filterOpts.pruneSavedFilterUiState,
  });
  const setFeedError = feedState.setError;
  useEffect(() => attachDutyNotificationAudioPrimingListeners(), []);
  useEffect(() => {
    let cancelled = false;
    currentSystemSettings()
      .then((settings) => {
        if (cancelled) return;
        setTestEnabled(settings.rerDutyTestEnabled);
        setTestSinceMs(settings.rerDutyTestSinceMs);
        setTestLimit(settings.rerDutyTestLimit);
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
    let cancelled = false;
    fetchUserSettings()
      .then((prefs) => {
        if (cancelled) return;
        setDutyDisableAutoScroll(prefs.disableAutoScroll);
      })
      .catch(() => {
        if (cancelled) return;
        setDutyDisableAutoScroll(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const onSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ disableAutoScroll?: boolean }>).detail;
      if (isNullOrUndefined(detail?.disableAutoScroll)) return;
      setDutyDisableAutoScroll(detail.disableAutoScroll);
    };

    window.addEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
    return () => {
      window.removeEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
    };
  }, []);
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
        const returnedByCallsign = new Map(items.map((item) => [normalizeCallsignLookupValue(item.callsign), item] as const));
        items.forEach((item) => {
          const key = normalizeCallsignLookupValue(item.callsign);
          if (item.res.length > 0) {
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
            emptyResultRetryAfterMsRef.current.set(callsign, nowMs + CALLSIGN_LOOKUP_RETRY_BACKOFF_MS);
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
          emptyResultRetryAfterMsRef.current.set(callsign, nowMs + CALLSIGN_LOOKUP_RETRY_BACKOFF_MS);
        });
        setCallsignRetryVersion((current) => current + 1);
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

    callsignRetryTimeoutRef.current = setTimeout(() => {
      callsignRetryTimeoutRef.current = null;
      setCallsignRetryVersion((current) => current + 1);
    }, Math.max(0, nextRetryAtMs - nowMs));

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
    buildReqForFeed: feedState.buildReqForFeed,
    columnRefsRef: feedState.columnRefsRef,
    showArrowResult: feedState.showArrowResult,
    setWatchModeByFeedId: feedState.setWatchModeByFeedId,
    setLoadingNewerFeedId: feedState.setLoadingNewerFeedId,
    authUserName,
    profiles: filterOpts.profiles,
    tagsMap: filterOpts.tagsMap,
    savedFilters: filterOpts.savedFilters,
    setSavedFilters: filterOpts.setSavedFilters,
    selectedSavedIdByFeedId: filterOpts.selectedSavedIdByFeedId,
    setSelectedSavedIdByFeedId: filterOpts.setSelectedSavedIdByFeedId,
    saveFilterNameByFeedId: filterOpts.saveFilterNameByFeedId,
    setSaveFilterNameByFeedId: filterOpts.setSaveFilterNameByFeedId,
    dutyDisableAutoScroll,
  });

  const freqs = useMemo(
    () => mergeFreqsFromMessages(filterOpts.freqs, feedState.messageFeeds),
    [filterOpts.freqs, feedState.messageFeeds]
  );
  const groupsList = useMemo(
    () => mergeGroupsFromMessages(filterOpts.groupsList, feedState.messageFeeds),
    [filterOpts.groupsList, feedState.messageFeeds]
  );
  const postsList = useMemo(
    () => mergePostsFromMessages(filterOpts.postsList, feedState.messageFeeds),
    [filterOpts.postsList, feedState.messageFeeds]
  );

  return {
    messageFeeds: feedState.messageFeeds,
    setMessageFeeds: feedState.setMessageFeeds,
    error: feedState.error,
    clearDutyError: () => feedState.setError(null),
    authUserName,
    columnRefsRef: feedState.columnRefsRef,
    nearBottomByFeedIdRef: feedState.nearBottomByFeedIdRef,
    atBottomByFeedIdRef: feedState.atBottomByFeedIdRef,
    dutyDisableAutoScroll,
    createMessageFeed: feedState.createMessageFeed,
    removeMessageFeed: feedState.removeMessageFeed,
    loadFeedInitialMessages: feedState.loadFeedInitialMessages,
    loadFeedOlderMessages: feedState.loadFeedOlderMessages,
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
    handleDeleteConfirm: actions.handleDeleteConfirm,
    setDeleteConfirmId: actions.setDeleteConfirmId,
    setDeleteConfirmFeedId: actions.setDeleteConfirmFeedId,
    openCommentDialog: actions.openCommentDialog,
    handleCommentSave: actions.handleCommentSave,
    handleToggleTag: actions.handleToggleTag,
    handleArrowClick: actions.handleArrowClick,
    handleVisibleMessageIds: actions.handleVisibleMessageIds,
    commentMessageId: actions.commentMessageId,
    commentText: actions.commentText,
    setCommentText: actions.setCommentText,
    setCommentMessageId: actions.setCommentMessageId,
    setCommentFeedId: actions.setCommentFeedId,
    deleteConfirmId: actions.deleteConfirmId,
    deleteConfirmFeedId: actions.deleteConfirmFeedId,
    profiles: filterOpts.profiles,
    senderOptions: actions.senderOptions,
    freqs,
    postsList,
    groupsList,
    groupInfos: filterOpts.groupInfos,
    tagsMap: filterOpts.tagsMap,
    tagIdsList: actions.tagIdsList,
    savedFilters: filterOpts.savedFilters,
    selectedSavedIdByFeedId: filterOpts.selectedSavedIdByFeedId,
    setSelectedSavedIdByFeedId: filterOpts.setSelectedSavedIdByFeedId,
    saveFilterNameByFeedId: filterOpts.saveFilterNameByFeedId,
    setSaveFilterNameByFeedId: filterOpts.setSaveFilterNameByFeedId,
    reloadFreqsLoading: filterOpts.reloadFreqsLoading,
    reloadLatestFrequencies: filterOpts.reloadLatestFrequencies,
    networkDisplayMap: feedState.networkDisplayMap,
    networkMap: feedState.networkMap,
    unitsMap: feedState.unitsMap,
    callsignInfoMap: feedState.callsignInfoMap,
    featureStrictNetworks: filterOpts.featureStrictNetworks,
    watchModeByFeedId: feedState.watchModeByFeedId,
    setWatchModeByFeedId: feedState.setWatchModeByFeedId,
    loadingNewerFeedId: feedState.loadingNewerFeedId,
    arrowResultByFeedId: feedState.arrowResultByFeedId,
    copiedFeedbackId: actions.copiedFeedbackId,
  };
}
