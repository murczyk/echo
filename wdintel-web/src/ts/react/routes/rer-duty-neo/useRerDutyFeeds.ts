import { useMemo } from 'react';

import { currentSystemSettings } from '../../services/api/system-settings';
import { useRerDutyFeedState } from './useRerDutyFeedState';
import { useRerDutyFilterOptions } from './useRerDutyFilterOptions';
import { useRerDutyMessageActions } from './useRerDutyMessageActions';

const MAX_MESSAGE_FEEDS = 4;

export { MAX_MESSAGE_FEEDS };

/** Merge API freqs with frequencies from loaded messages. */
function mergeFreqsFromMessages(apiFreqs: string[], messageFeeds: { items: [number, { freq?: string | null }][] }[]): string[] {
  const fromMsgs = new Set<string>();
  messageFeeds.forEach((feed) =>
    feed.items.forEach(([, msg]) => {
      if (msg.freq && msg.freq.trim() !== '') fromMsgs.add(msg.freq.trim());
    })
  );
  const merged = new Set<string>([...apiFreqs, ...fromMsgs]);
  return [...merged].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function useRerDutyFeeds(authUserName: string | null) {
  const filterOpts = useRerDutyFilterOptions();
  const [randomEnabled, setRandomEnabled] = React.useState(false);
  const [randomIntervalSec, setRandomIntervalSec] = React.useState(1);
  const feedState = useRerDutyFeedState({
    freqs: filterOpts.freqs,
    setProfiles: filterOpts.setProfiles,
    setGroupInfos: filterOpts.setGroupInfos,
    randomEnabled,
    randomIntervalSec,
  });
  React.useEffect(() => {
    let cancelled = false;
    currentSystemSettings()
      .then((settings) => {
        if (cancelled) return;
        setRandomEnabled(settings.rerDutyRandomEnabled);
        setRandomIntervalSec(settings.rerDutyRandomIntervalSec);
      })
      .catch((error) => {
        if (cancelled) return;
        feedState.setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [feedState]);
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
    selectedSavedId: filterOpts.selectedSavedId,
    setSelectedSavedId: filterOpts.setSelectedSavedId,
    saveFilterName: filterOpts.saveFilterName,
    setSaveFilterName: filterOpts.setSaveFilterName,
  });

  const freqs = useMemo(
    () => mergeFreqsFromMessages(filterOpts.freqs, feedState.messageFeeds),
    [filterOpts.freqs, feedState.messageFeeds]
  );

  return {
    messageFeeds: feedState.messageFeeds,
    setMessageFeeds: feedState.setMessageFeeds,
    error: feedState.error,
    authUserName,
    columnRefsRef: feedState.columnRefsRef,
    nearBottomByFeedIdRef: feedState.nearBottomByFeedIdRef,
    createMessageFeed: feedState.createMessageFeed,
    removeMessageFeed: feedState.removeMessageFeed,
    loadFeedInitialMessages: feedState.loadFeedInitialMessages,
    loadFeedOlderMessages: feedState.loadFeedOlderMessages,
    applyFilter: feedState.applyFilter,
    toggleGroup: feedState.toggleGroup,
    selectAllGroups: feedState.selectAllGroups,
    handleSaveFilter: actions.handleSaveFilter,
    handleApplySavedFilter: actions.handleApplySavedFilter,
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
    postsList: filterOpts.postsList,
    groupsList: filterOpts.groupsList,
    groupInfos: filterOpts.groupInfos,
    tagsMap: filterOpts.tagsMap,
    tagIdsList: actions.tagIdsList,
    savedFilters: filterOpts.savedFilters,
    selectedSavedId: filterOpts.selectedSavedId,
    setSelectedSavedId: filterOpts.setSelectedSavedId,
    saveFilterName: filterOpts.saveFilterName,
    setSaveFilterName: filterOpts.setSaveFilterName,
    reloadFreqsLoading: filterOpts.reloadFreqsLoading,
    reloadLatestFrequencies: filterOpts.reloadLatestFrequencies,
    networkDisplayMap: feedState.networkDisplayMap,
    networkMap: feedState.networkMap,
    featureStrictNetworks: filterOpts.featureStrictNetworks,
    watchModeByFeedId: feedState.watchModeByFeedId,
    setWatchModeByFeedId: feedState.setWatchModeByFeedId,
    loadingNewerFeedId: feedState.loadingNewerFeedId,
    arrowResultByFeedId: feedState.arrowResultByFeedId,
    copiedFeedbackId: actions.copiedFeedbackId,
  };
}
