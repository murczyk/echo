import { useCallback, useEffect, useRef, useState } from 'react';
import {
  IMPORTANT_MESSAGE_UPDATED_EVENT,
  type ImportantMessageUpdate,
  requestImportantMessage,
} from '../../components/app-navbar/ImportantMessageDialog';
import type { Dispatch, SetStateAction } from 'react';

import type { InboxMessage } from '../../../../Bindings';
import {
  buildAnalysisMapHrefWithSearch,
  sortMessageItemsByTime,
  uniquePointEtalonsForMapSearch,
} from './utils';
import {
  bookmarkAdd,
  bookmarkRemove,
  deleteMessage,
  importantRemove,
  inboxMessageTagsAdd,
  inboxMessageTagsModelError,
  inboxMessageTagsRm,
} from '../../services/api/inbox';
import { addPalitraHighlightBlacklistEntry } from '../../services/api/palitra';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';
import { notifyMessageCopySuccess } from '../shared/message-card/message-card-copy-feedback';
import { mergeUpdatedDutyFeedMessages } from '../shared/message-card/message-card-message-updates';
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
  currentUserOrganismId: number | null;
  setError: (value: string) => void;
};

export function useRerDutyMessageItemActions(params: Params) {
  const { messageFeeds, setMessageFeeds, authUserName, currentUserOrganismId, setError } = params;
  const { notify } = useOptionalPowerSnackbar();
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [deleteConfirmFeedId, setDeleteConfirmFeedId] = useState<string | null>(null);
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
    async (feedId: string, id: number, currentlyImportant: boolean, keepAiImportance = false) => {
      if (!currentlyImportant) {
        requestImportantMessage({
          messageId: id,
          groupMasterKey: getMessageByFeedId(messageFeeds, feedId, id)?.groupMasterKey,
        });
        return;
      }
      try {
        const { important, importantByMyOrganism } = await importantRemove({
          messageId: id,
          keepAiImportance,
        });
        setMessageFeeds((prev) =>
          prev.map((w) =>
            w.id === feedId
              ? {
                  ...w,
                  items: w.items.map(([msgId, msg]) =>
                    msgId === id
                      ? [
                          msgId,
                          {
                            ...msg,
                            important,
                            importantByMyOrganism,
                            aiImportant: keepAiImportance && msg.aiImportant,
                          },
                        ]
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
    [messageFeeds, setMessageFeeds, setError],
  );

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<ImportantMessageUpdate>).detail;
      setMessageFeeds((feeds) => {
        let changed = false;
        const updatedFeeds = feeds.map((feed) => {
          let feedChanged = false;
          const items = feed.items.map((item) => {
            const [id, message] = item;
            if (
              id !== detail.messageId ||
              (message.important === detail.important &&
                message.importantByMyOrganism === detail.importantByMyOrganism)
            ) {
              return item;
            }
            changed = true;
            feedChanged = true;
            const { important, importantByMyOrganism } = detail;
            return [id, { ...message, important, importantByMyOrganism }] as [number, InboxMessage];
          });
          return feedChanged ? { ...feed, items } : feed;
        });
        return changed ? updatedFeeds : feeds;
      });
    };
    window.addEventListener(IMPORTANT_MESSAGE_UPDATED_EVENT, update);
    return () => window.removeEventListener(IMPORTANT_MESSAGE_UPDATED_EVENT, update);
  }, [setMessageFeeds]);

  const handleMessageCopy = useCallback(
    (text: string, feedbackId: string) => {
      void copyTextToClipboard(text)
        .then(() => notifyMessageCopySuccess(feedbackId, notify))
        .catch((err) => {
          console.error('Failed to copy text to clipboard', err);
        });
      if (copiedFeedbackTimeoutRef.current) clearTimeout(copiedFeedbackTimeoutRef.current);
      setCopiedFeedbackId(feedbackId);
      copiedFeedbackTimeoutRef.current = setTimeout(() => {
        setCopiedFeedbackId(null);
        copiedFeedbackTimeoutRef.current = null;
      }, 1000);
    },
    [notify],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteConfirmId == null || deleteConfirmFeedId == null) return;
    try {
      await deleteMessage({ id: deleteConfirmId });
      setMessageFeeds((feeds) => mergeUpdatedDutyFeedMessages(feeds, null, [deleteConfirmId], []));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setDeleteConfirmId(null);
    setDeleteConfirmFeedId(null);
  }, [deleteConfirmFeedId, deleteConfirmId, setMessageFeeds, setError]);

  const handleToggleTag = useCallback(
    async (feedId: string, msgId: number, tagId: number) => {
      const sourceMessage = getMessageByFeedId(messageFeeds, feedId, msgId);
      if (sourceMessage == null) return;

      const currentUserName = authUserName ?? null;
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
    [authUserName, currentUserOrganismId, messageFeeds, setMessageFeeds, setError],
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
          await addPalitraHighlightBlacklistEntry(
            request.palitraId,
            request.etalon,
            request.messageId,
          );
          setMessageFeeds((prev) =>
            prev.map((feed) => ({
              ...feed,
              items: feed.items.map(([id, message]) => [
                id,
                removePointHighlightSourceFromMessage(message, request),
              ]),
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
    handleToggleTag,
    botTagAction,
    onCancelBotTagAction,
    onMarkBotTagWrong,
    handleEditedMessage,
    deleteConfirmId,
    deleteConfirmFeedId,
    copiedFeedbackId,
    handleOpenPointsOnMap,
    onAddPointHighlightBlacklist,
  };
}
