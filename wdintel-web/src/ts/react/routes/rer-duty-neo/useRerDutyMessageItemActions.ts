import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { InboxMessage, SignalGroupEntry, SignalProfileEntry } from '../../../../Bindings';
import {
  buildAnalysisMapHrefWithSearch,
  sortMessageItemsByTime,
  uniquePointEtalonsForMapSearch,
} from './utils';
import {
  bookmarkAdd,
  bookmarkRemove,
  commentSave,
  deleteMessage,
  importantAdd,
  importantRemove,
  inboxMessageTagsAdd,
  inboxMessageTagsModelError,
  inboxMessageTagsRm,
} from '../../services/api/inbox';
import { addPalitraHighlightBlacklistEntry } from '../../services/api/palitra';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import { buildMessageCardDisplayLabels } from '../shared/message-card/message-card-labels';
import type { MessageCardBotTagAction } from '../shared/message-card/message-card.types';
import {
  hasBotTag,
  hasUserTag,
  removeBotTags,
  toggleHumanTag,
} from '../shared/message-card/message-card-tag-actions';
import type { MessageFeedState } from './utils';
import {
  pointBlacklistLabelKey,
  removePointHighlightSourceFromMessage,
  type AddPointHighlightBlacklistRequest,
} from '../shared/message-card/point-highlight-blacklist';

function getMessageByFeedId(messageFeeds: MessageFeedState[], feedId: string, msgId: number) {
  return (
    messageFeeds.find((feed) => feed.id === feedId)?.items.find(([id]) => id === msgId)?.[1] ?? null
  );
}

function replaceMessageInFeed(
  messageFeeds: MessageFeedState[],
  feedId: string,
  msgId: number,
  updater: (message: InboxMessage) => InboxMessage,
): MessageFeedState[] {
  return messageFeeds.map((feed) =>
    feed.id !== feedId
      ? feed
      : {
          ...feed,
          items: feed.items.map(
            ([id, message]) =>
              (id === msgId ? [id, updater(message)] : [id, message]) as [number, InboxMessage],
          ),
        },
  );
}

type Params = {
  messageFeeds: MessageFeedState[];
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
  authUserName: string | null;
  profiles: Record<string, SignalProfileEntry | null>;
  groupInfos: Record<string, SignalGroupEntry>;
  setError: (value: string) => void;
};

export function useRerDutyMessageItemActions(params: Params) {
  const { messageFeeds, setMessageFeeds, authUserName, profiles, groupInfos, setError } = params;
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [deleteConfirmFeedId, setDeleteConfirmFeedId] = useState<string | null>(null);
  const [commentMessageId, setCommentMessageId] = useState<number | null>(null);
  const [commentFeedId, setCommentFeedId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [copiedFeedbackId, setCopiedFeedbackId] = useState<string | null>(null);
  const [botTagAction, setBotTagAction] = useState<MessageCardBotTagAction | null>(null);
  const copiedFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointBlacklistRequestsRef = useRef<Map<string, Promise<void>>>(new Map());

  useEffect(() => {
    return () => {
      if (copiedFeedbackTimeoutRef.current) clearTimeout(copiedFeedbackTimeoutRef.current);
    };
  }, []);

  const handleMessageBookmark = useCallback(
    async (feedId: string, id: number, currentlyBookmarked: boolean) => {
      try {
        if (currentlyBookmarked) await bookmarkRemove({ messageId: id });
        else await bookmarkAdd({ messageId: id });
        setMessageFeeds((prev) =>
          prev.map((w) =>
            w.id === feedId
              ? {
                  ...w,
                  items: w.items.map(([msgId, msg]) =>
                    msgId === id
                      ? [msgId, { ...msg, bookmarked: !currentlyBookmarked }]
                      : [msgId, msg],
                  ),
                }
              : w,
          ),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [setMessageFeeds, setError],
  );

  const handleMessageImportant = useCallback(
    async (feedId: string, id: number, currentlyImportant: boolean) => {
      try {
        if (currentlyImportant) await importantRemove({ messageId: id });
        else await importantAdd({ messageId: id });
        setMessageFeeds((prev) =>
          prev.map((w) =>
            w.id === feedId
              ? {
                  ...w,
                  items: w.items.map(([msgId, msg]) =>
                    msgId === id
                      ? [msgId, { ...msg, important: !currentlyImportant }]
                      : [msgId, msg],
                  ),
                }
              : w,
          ),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [setMessageFeeds, setError],
  );

  const handleMessageCopy = useCallback((text: string, feedbackId: string) => {
    void copyTextToClipboard(text).catch((err) => {
      console.error('Failed to copy text to clipboard', err);
    });
    if (copiedFeedbackTimeoutRef.current) clearTimeout(copiedFeedbackTimeoutRef.current);
    setCopiedFeedbackId(feedbackId);
    copiedFeedbackTimeoutRef.current = setTimeout(() => {
      setCopiedFeedbackId(null);
      copiedFeedbackTimeoutRef.current = null;
    }, 1000);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteConfirmId == null || deleteConfirmFeedId == null) return;
    try {
      await deleteMessage({ id: deleteConfirmId });
      setMessageFeeds((prev) =>
        prev.map((w) => {
          if (w.id !== deleteConfirmFeedId) return w;
          const newItems = w.items.filter(([id]) => id !== deleteConfirmId);
          const newReadIds = new Set([...w.readIds].filter((id) => id !== deleteConfirmId));
          const unreadCount = w.readIds.has(deleteConfirmId)
            ? w.unreadCount
            : Math.max(0, w.unreadCount - 1);
          return { ...w, items: newItems, readIds: newReadIds, unreadCount };
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setDeleteConfirmId(null);
    setDeleteConfirmFeedId(null);
  }, [deleteConfirmFeedId, deleteConfirmId, setMessageFeeds, setError]);

  const openCommentDialog = useCallback(
    (msgId: number, feedId: string, currentComment: string | null) => {
      setCommentMessageId(msgId);
      setCommentFeedId(feedId);
      setCommentText(currentComment ?? '');
    },
    [],
  );

  const commentMessagePreview = useMemo(() => {
    if (commentMessageId == null || commentFeedId == null) return null;
    const feed = messageFeeds.find((item) => item.id === commentFeedId);
    if (!feed) return null;
    const message = feed.items.find(([id]) => id === commentMessageId)?.[1];
    if (!message) return null;
    return buildMessageCardDisplayLabels(message, { groupInfos, profiles }).commentPreview;
  }, [commentFeedId, commentMessageId, groupInfos, messageFeeds, profiles]);

  const handleCommentSave = useCallback(async () => {
    if (commentMessageId == null || commentFeedId == null) return;
    const trimmed = commentText.trim() || null;
    try {
      await commentSave({ messageId: commentMessageId, comment: trimmed });
      setMessageFeeds((prev) =>
        prev.map((w) =>
          w.id === commentFeedId
            ? {
                ...w,
                items: w.items.map(([id, m]) =>
                  id === commentMessageId ? [id, { ...m, extendedForm: trimmed }] : [id, m],
                ),
              }
            : w,
        ),
      );
      setCommentMessageId(null);
      setCommentFeedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [commentFeedId, commentMessageId, commentText, setMessageFeeds, setError]);

  const handleToggleTag = useCallback(
    async (feedId: string, msgId: number, tagId: number) => {
      const sourceMessage = getMessageByFeedId(messageFeeds, feedId, msgId);
      if (sourceMessage == null) return;

      const currentUserName = authUserName ?? null;
      const currentUserOrganismId = null;
      const userHasTag = hasUserTag(sourceMessage, tagId, currentUserName);
      const botHasTag = hasBotTag(sourceMessage, tagId);

      setBotTagAction(userHasTag && botHasTag ? { messageId: msgId, tagId } : null);
      try {
        if (userHasTag) {
          await inboxMessageTagsRm({ messageId: msgId, tagId });
        } else {
          await inboxMessageTagsAdd({ messageId: msgId, tagId });
        }
        setMessageFeeds((prev) =>
          replaceMessageInFeed(prev, feedId, msgId, (message) =>
            toggleHumanTag(message, tagId, currentUserName, currentUserOrganismId),
          ),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [authUserName, messageFeeds, setMessageFeeds, setError],
  );

  const onMarkBotTagWrong = useCallback(
    async (messageId: number, tagId: number) => {
      try {
        await inboxMessageTagsModelError({ messageId, tagId });
        setBotTagAction(null);
        setMessageFeeds((prev) =>
          prev.map((feed) => ({
            ...feed,
            items: feed.items.map(([id, message]) =>
              id === messageId ? [id, removeBotTags(message, tagId)] : [id, message],
            ),
          })),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [setMessageFeeds, setError],
  );

  const onCancelBotTagAction = useCallback(() => {
    setBotTagAction(null);
  }, []);

  const handleEditedMessage = useCallback(
    (messageId: number, message: InboxMessage) => {
      setMessageFeeds((prev) =>
        prev.map((feed) => {
          if (!feed.items.some(([id]) => id === messageId)) return feed;
          const updatedItems = feed.items.map(
            ([id, currentMessage]) =>
              (id === messageId ? [id, message] : [id, currentMessage]) as [number, InboxMessage],
          );
          return { ...feed, items: sortMessageItemsByTime(updatedItems) };
        }),
      );
    },
    [setMessageFeeds],
  );

  const handleOpenPointsOnMap = useCallback((etalons: string[], message: InboxMessage) => {
    const search = uniquePointEtalonsForMapSearch(etalons).join(',');
    if (search === '') return;
    window.location.assign(buildAnalysisMapHrefWithSearch(search, message));
  }, []);

  const onAddPointHighlightBlacklist = useCallback(
    (request: AddPointHighlightBlacklistRequest) => {
      const key = `${request.messageId}:${pointBlacklistLabelKey(request.etalon)}:${request.palitraId}`;
      const existing = pointBlacklistRequestsRef.current.get(key);
      if (existing) return existing;

      let promise!: Promise<void>;
      promise = (async () => {
        try {
          await addPalitraHighlightBlacklistEntry(request.palitraId, request.etalon);
          setMessageFeeds((prev) =>
            prev.map((feed) => ({
              ...feed,
              items: feed.items.map(([id, message]) =>
                id === request.messageId
                  ? [id, removePointHighlightSourceFromMessage(message, request)]
                  : [id, message],
              ),
            })),
          );
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          if (pointBlacklistRequestsRef.current.get(key) === promise) {
            pointBlacklistRequestsRef.current.delete(key);
          }
        }
      })();
      pointBlacklistRequestsRef.current.set(key, promise);
      return promise;
    },
    [setError, setMessageFeeds],
  );

  return {
    handleMessageBookmark,
    handleMessageImportant,
    handleMessageCopy,
    handleDeleteConfirm,
    setDeleteConfirmId,
    setDeleteConfirmFeedId,
    openCommentDialog,
    commentMessagePreview,
    handleCommentSave,
    handleToggleTag,
    botTagAction,
    onCancelBotTagAction,
    onMarkBotTagWrong,
    handleEditedMessage,
    commentMessageId,
    commentText,
    setCommentText,
    setCommentMessageId,
    setCommentFeedId,
    deleteConfirmId,
    deleteConfirmFeedId,
    copiedFeedbackId,
    handleOpenPointsOnMap,
    onAddPointHighlightBlacklist,
  };
}
