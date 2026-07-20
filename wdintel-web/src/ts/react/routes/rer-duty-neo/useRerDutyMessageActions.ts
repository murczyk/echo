import { useMemo, useRef } from 'react';

import { buildSenderOptions } from './utils';
import type { MessageActionsDeps } from './useRerDutyMessageActions.shared';
import { useRerDutyFeedInteractionActions } from './useRerDutyFeedInteractionActions';
import { useRerDutyMessageItemActions } from './useRerDutyMessageItemActions';
import { useRerDutySavedFilterActions } from './useRerDutySavedFilterActions';

export type { MessageActionsDeps } from './useRerDutyMessageActions.shared';

export function useRerDutyMessageActions(deps: MessageActionsDeps) {
  const {
    messageFeeds,
    setMessageFeeds,
    setError,
    applyFilter,
    loadFeedInitialMessages,
    loadFeedNewerMessages,
    showArrowResult,
    columnRefsRef,
    setWatchModeByFeedId,
    setLoadingNewerFeedIds,
    requestValidatedInboxCount,
    authUserName,
    profiles,
    tagsMap,
    tagsOrder,
    groupInfos,
    savedFilters,
    setSavedFilters,
    selectedSavedIdByFeedId,
    setSelectedSavedIdByFeedId,
    saveFilterNameByFeedId,
    setSaveFilterNameByFeedId,
    dutyDisableAutoScroll,
    openPointsOnMap,
  } = deps;

  const savedFilterActions = useRerDutySavedFilterActions({
    messageFeeds,
    savedFilters,
    setSavedFilters,
    selectedSavedIdByFeedId,
    setSelectedSavedIdByFeedId,
    saveFilterNameByFeedId,
    setSaveFilterNameByFeedId,
    applyFilter,
    setError,
  });

  const messageItemActions = useRerDutyMessageItemActions({
    messageFeeds,
    setMessageFeeds,
    authUserName,
    profiles,
    groupInfos,
    setError,
  });

  const feedInteractionActions = useRerDutyFeedInteractionActions({
    messageFeeds,
    showArrowResult,
    columnRefsRef,
    setWatchModeByFeedId,
    setLoadingNewerFeedIds,
    loadFeedInitialMessages,
    loadFeedNewerMessages,
    requestValidatedInboxCount,
    dutyDisableAutoScroll,
    setMessageFeeds,
  });

  const senderOptions = useMemo(
    () => buildSenderOptions(profiles, messageFeeds),
    [profiles, messageFeeds],
  );

  const senderOptionsStableRef = useRef(senderOptions);
  const senderOptionsStable =
    senderOptionsStableRef.current.length === senderOptions.length &&
    senderOptionsStableRef.current.every(
      (o, i) => o.id === senderOptions[i].id && o.label === senderOptions[i].label,
    )
      ? senderOptionsStableRef.current
      : ((senderOptionsStableRef.current = senderOptions), senderOptions);

  const tagIdsList = useMemo(() => {
    const seen = new Set<number>();
    const ordered: number[] = [];
    for (const tagId of tagsOrder) {
      if (!tagsMap[tagId] || seen.has(tagId)) continue;
      seen.add(tagId);
      ordered.push(tagId);
    }
    for (const tagId of Object.keys(tagsMap).map(Number)) {
      if (!Number.isFinite(tagId) || seen.has(tagId)) continue;
      seen.add(tagId);
      ordered.push(tagId);
    }
    return ordered;
  }, [tagsMap, tagsOrder]);

  return {
    handleSaveFilter: savedFilterActions.handleSaveFilter,
    handleApplySavedFilter: savedFilterActions.handleApplySavedFilter,
    handleUpdateSelectedSavedFilter: savedFilterActions.handleUpdateSelectedSavedFilter,
    handleRenameSelectedSavedFilter: savedFilterActions.handleRenameSelectedSavedFilter,
    handleDeleteSelectedSavedFilter: savedFilterActions.handleDeleteSelectedSavedFilter,
    handleDeleteSavedFilter: savedFilterActions.handleDeleteSavedFilter,
    handleMessageBookmark: messageItemActions.handleMessageBookmark,
    handleMessageImportant: messageItemActions.handleMessageImportant,
    handleMessageCopy: messageItemActions.handleMessageCopy,
    handleDeleteConfirm: messageItemActions.handleDeleteConfirm,
    setDeleteConfirmId: messageItemActions.setDeleteConfirmId,
    setDeleteConfirmFeedId: messageItemActions.setDeleteConfirmFeedId,
    openCommentDialog: messageItemActions.openCommentDialog,
    commentMessagePreview: messageItemActions.commentMessagePreview,
    handleCommentSave: messageItemActions.handleCommentSave,
    handleToggleTag: messageItemActions.handleToggleTag,
    botTagAction: messageItemActions.botTagAction,
    onCancelBotTagAction: messageItemActions.onCancelBotTagAction,
    onMarkBotTagWrong: messageItemActions.onMarkBotTagWrong,
    handleEditedMessage: messageItemActions.handleEditedMessage,
    handleArrowClick: feedInteractionActions.handleArrowClick,
    handleVisibleMessageIds: feedInteractionActions.handleVisibleMessageIds,
    commentMessageId: messageItemActions.commentMessageId,
    commentText: messageItemActions.commentText,
    setCommentText: messageItemActions.setCommentText,
    setCommentMessageId: messageItemActions.setCommentMessageId,
    setCommentFeedId: messageItemActions.setCommentFeedId,
    deleteConfirmId: messageItemActions.deleteConfirmId,
    deleteConfirmFeedId: messageItemActions.deleteConfirmFeedId,
    senderOptions: senderOptionsStable,
    tagIdsList,
    copiedFeedbackId: messageItemActions.copiedFeedbackId,
    handleOpenPointsOnMap: openPointsOnMap ?? messageItemActions.handleOpenPointsOnMap,
  };
}
