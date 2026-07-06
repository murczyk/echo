import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { isNullOrUndefined, isPresent } from '../../utils/misc';

import type {
  InboxMessage,
  InboxMessagesReq,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SavedFilterDuty,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
} from '../../../../Bindings';
import {
  bookmarkAdd,
  bookmarkRemove,
  commentSave,
  deleteMessage,
  fetchInboxCount,
  importantAdd,
  importantRemove,
  inboxMessageTagsAdd,
  inboxMessageTagsModelError,
  inboxMessageTagsRm,
  savedFilterDelete,
  savedFilterRename,
  savedFilterUpsert,
} from '../../services/api/inbox';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import type { FeedColumnHandle } from './FeedColumn';
import type { MessageCardBotTagAction } from '../shared/message-card/message-card.types';
import {
  hasBotTag,
  hasUserTag,
  removeBotTags,
  toggleHumanTag,
} from '../shared/message-card/message-card-tag-actions';
import { buildMessageCardDisplayLabels } from '../shared/message-card/message-card-labels';
import { buildInboxReq, buildSenderOptions, normalizeFeed } from './utils';
import type { MessageFeedState } from './utils';

export type MessageActionsDeps = {
  messageFeeds: MessageFeedState[];
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
  setError: (value: SetStateAction<string | null>) => void;
  applyFilter: (feedId: string, f: RerDutyFeedFilterState) => void;
  loadFeedInitialMessages: (
    feedId: string,
    overrides?: { highlightSignalsEnabled?: boolean; onlyMyUnitTagsEnabled?: boolean },
  ) => Promise<void>;
  loadFeedNewerMessages: (
    feedId: string,
    opts?: { nolimit?: boolean; scrollToEndAfterLoad?: boolean; markAllReadAfterAppend?: boolean },
  ) => Promise<void>;
  buildReqForFeed: (
    feed: MessageFeedState,
    opts: Omit<
      Parameters<typeof buildInboxReq>[0],
      | 'filter'
      | 'expandedFreqsSelected'
      | 'expandedFreqsDenied'
      | 'highlightSignals'
      | 'reportTagsOnlyThisUnit'
    >,
  ) => InboxMessagesReq;
  columnRefsRef: MutableRefObject<Record<string, FeedColumnHandle | null>>;
  showArrowResult: (feedId: string, message: string) => void;
  setWatchModeByFeedId: Dispatch<SetStateAction<Record<string, boolean>>>;
  setLoadingNewerFeedId: Dispatch<SetStateAction<string | null>>;
  authUserName: string | null;
  profiles: Record<string, SignalProfileEntry | null>;
  tagsMap: Record<number, Tag>;
  groupInfos: Record<string, SignalGroupEntry>;
  savedFilters: SavedFilterDuty[];
  setSavedFilters: Dispatch<SetStateAction<SavedFilterDuty[]>>;
  selectedSavedIdByFeedId: Record<string, number | null>;
  setSelectedSavedIdByFeedId: Dispatch<SetStateAction<Record<string, number | null>>>;
  saveFilterNameByFeedId: Record<string, string>;
  setSaveFilterNameByFeedId: Dispatch<SetStateAction<Record<string, string>>>;
  /** User pref: do not auto-scroll / stay in watch mode on duty. */
  dutyDisableAutoScroll: boolean;
};

function getMessageByFeedId(
  messageFeeds: MessageFeedState[],
  feedId: string,
  msgId: number,
): InboxMessage | null {
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
          items: feed.items.map(([id, message]) =>
            id === msgId ? [id, updater(message)] : [id, message],
          ),
        },
  );
}

export function useRerDutyMessageActions(deps: MessageActionsDeps) {
  const {
    messageFeeds,
    setMessageFeeds,
    setError,
    applyFilter,
    loadFeedInitialMessages,
    loadFeedNewerMessages,
    buildReqForFeed,
    columnRefsRef,
    showArrowResult,
    setWatchModeByFeedId,
    setLoadingNewerFeedId,
    authUserName,
    profiles,
    tagsMap,
    groupInfos,
    savedFilters,
    setSavedFilters,
    selectedSavedIdByFeedId,
    setSelectedSavedIdByFeedId,
    saveFilterNameByFeedId,
    setSaveFilterNameByFeedId,
    dutyDisableAutoScroll,
  } = deps;

  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [deleteConfirmFeedId, setDeleteConfirmFeedId] = useState<string | null>(null);
  const [commentMessageId, setCommentMessageId] = useState<number | null>(null);
  const [commentFeedId, setCommentFeedId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [copiedFeedbackId, setCopiedFeedbackId] = useState<string | null>(null);
  const [botTagAction, setBotTagAction] = useState<MessageCardBotTagAction | null>(null);
  const copiedFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedSavedIdByFeedIdRef = useRef(selectedSavedIdByFeedId);

  useEffect(() => {
    selectedSavedIdByFeedIdRef.current = selectedSavedIdByFeedId;
  }, [selectedSavedIdByFeedId]);

  const getSelectedSavedIdForFeed = useCallback(
    (feedId: string) => selectedSavedIdByFeedId[feedId] ?? null,
    [selectedSavedIdByFeedId],
  );

  const setSavedFilterSelectionForFeed = useCallback(
    (feedId: string, savedId: number | null) => {
      setSelectedSavedIdByFeedId((prev) =>
        prev[feedId] === savedId ? prev : { ...prev, [feedId]: savedId },
      );
    },
    [setSelectedSavedIdByFeedId],
  );

  const setSavedFilterNameForFeed = useCallback(
    (feedId: string, name: string) => {
      setSaveFilterNameByFeedId((prev) =>
        prev[feedId] === name ? prev : { ...prev, [feedId]: name },
      );
    },
    [setSaveFilterNameByFeedId],
  );

  useEffect(() => {
    return () => {
      if (copiedFeedbackTimeoutRef.current) clearTimeout(copiedFeedbackTimeoutRef.current);
    };
  }, []);

  const handleSaveFilter = useCallback(
    async (feedId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return false;
      if (savedFilters.some((savedFilter) => savedFilter.name === trimmed)) {
        setError(`Фільтр з назвою "${trimmed}" вже існує`);
        return false;
      }
      const w = messageFeeds.find((x) => x.id === feedId);
      if (!w) return false;
      try {
        const list = await savedFilterUpsert({ name: trimmed, req: w.filter });
        setSavedFilters(list);
        const created = list.find((savedFilter) => savedFilter.name === trimmed);
        if (isPresent(created)) {
          setSavedFilterSelectionForFeed(feedId, created.id);
          setSavedFilterNameForFeed(feedId, created.name);
        }
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [
      messageFeeds,
      savedFilters,
      setSavedFilters,
      setError,
      setSavedFilterSelectionForFeed,
      setSavedFilterNameForFeed,
    ],
  );

  const handleApplySavedFilter = useCallback(
    (feedId: string, saved: SavedFilterDuty) => {
      setSavedFilterSelectionForFeed(feedId, saved.id);
      setSavedFilterNameForFeed(feedId, saved.name);
      applyFilter(feedId, normalizeFeed(saved.req as unknown as Record<string, unknown>));
    },
    [applyFilter, setSavedFilterSelectionForFeed, setSavedFilterNameForFeed],
  );

  const handleUpdateSelectedSavedFilter = useCallback(
    async (feedId: string) => {
      const selectedSavedId = getSelectedSavedIdForFeed(feedId);
      if (isNullOrUndefined(selectedSavedId)) return;
      const selectedSaved = savedFilters.find((savedFilter) => savedFilter.id === selectedSavedId);
      if (!selectedSaved) return;
      const feed = messageFeeds.find((item) => item.id === feedId);
      if (!feed) return;
      try {
        const list = await savedFilterUpsert({ name: selectedSaved.name, req: feed.filter });
        setSavedFilters(list);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [getSelectedSavedIdForFeed, savedFilters, messageFeeds, setSavedFilters, setError],
  );

  const handleRenameSelectedSavedFilter = useCallback(
    async (feedId: string, name: string) => {
      const selectedSavedId = getSelectedSavedIdForFeed(feedId);
      if (isNullOrUndefined(selectedSavedId)) return false;
      const selectedSaved = savedFilters.find((savedFilter) => savedFilter.id === selectedSavedId);
      if (!selectedSaved) return false;
      const trimmed = name.trim();
      if (!trimmed || trimmed === selectedSaved.name) return false;
      if (
        savedFilters.some(
          (savedFilter) => savedFilter.id !== selectedSaved.id && savedFilter.name === trimmed,
        )
      ) {
        setError(`Фільтр з назвою "${trimmed}" вже існує`);
        return false;
      }
      try {
        await savedFilterRename({ id: selectedSaved.id, name: trimmed });
        setSavedFilters((prev) =>
          prev.map((savedFilter) =>
            savedFilter.id === selectedSaved.id ? { ...savedFilter, name: trimmed } : savedFilter,
          ),
        );
        setSaveFilterNameByFeedId((prev) => {
          let changed = false;
          const next = { ...prev };
          Object.entries(selectedSavedIdByFeedIdRef.current).forEach(
            ([targetFeedId, targetSavedId]) => {
              if (targetSavedId === selectedSaved.id && next[targetFeedId] !== trimmed) {
                next[targetFeedId] = trimmed;
                changed = true;
              }
            },
          );
          return changed ? next : prev;
        });
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [getSelectedSavedIdForFeed, savedFilters, setSavedFilters, setSaveFilterNameByFeedId, setError],
  );

  const clearDeletedSavedFilterFromFeeds = useCallback(
    (deletedSavedId: number) => {
      setSelectedSavedIdByFeedId((prev) => {
        let changed = false;
        const next = { ...prev };
        Object.entries(prev).forEach(([feedId, savedId]) => {
          if (savedId === deletedSavedId) {
            next[feedId] = null;
            changed = true;
          }
        });
        return changed ? next : prev;
      });
      setSaveFilterNameByFeedId((prev) => {
        let changed = false;
        const next = { ...prev };
        Object.entries(prev).forEach(([feedId, savedName]) => {
          const savedId = selectedSavedIdByFeedIdRef.current[feedId] ?? null;
          if (savedId === deletedSavedId && savedName !== '') {
            next[feedId] = '';
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    },
    [setSaveFilterNameByFeedId, setSelectedSavedIdByFeedId],
  );

  const handleDeleteSelectedSavedFilter = useCallback(
    async (feedId: string) => {
      const selectedSavedId = getSelectedSavedIdForFeed(feedId);
      if (isNullOrUndefined(selectedSavedId)) return;
      try {
        await savedFilterDelete(selectedSavedId);
        setSavedFilters((prev) => prev.filter((x) => x.id !== selectedSavedId));
        clearDeletedSavedFilterFromFeeds(selectedSavedId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [getSelectedSavedIdForFeed, setSavedFilters, clearDeletedSavedFilterFromFeeds, setError],
  );

  const handleDeleteSavedFilter = useCallback(
    async (id: number) => {
      try {
        await savedFilterDelete(id);
        setSavedFilters((prev) => prev.filter((x) => x.id !== id));
        clearDeletedSavedFilterFromFeeds(id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [setSavedFilters, clearDeletedSavedFilterFromFeeds, setError],
  );

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
    if (isNullOrUndefined(deleteConfirmId) || isNullOrUndefined(deleteConfirmFeedId)) return;
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
  }, [deleteConfirmId, deleteConfirmFeedId, setMessageFeeds, setError]);

  const openCommentDialog = useCallback(
    (msgId: number, feedId: string, currentComment: string | null) => {
      setCommentMessageId(msgId);
      setCommentFeedId(feedId);
      setCommentText(currentComment ?? '');
    },
    [],
  );

  const commentMessagePreview = useMemo(() => {
    if (isNullOrUndefined(commentMessageId) || isNullOrUndefined(commentFeedId)) return null;
    const feed = messageFeeds.find((item) => item.id === commentFeedId);
    if (!feed) return null;
    const message = feed.items.find(([id]) => id === commentMessageId)?.[1];
    if (!message) return null;
    return buildMessageCardDisplayLabels(message, { groupInfos, profiles }).commentPreview;
  }, [commentFeedId, commentMessageId, groupInfos, messageFeeds, profiles]);

  const handleCommentSave = useCallback(async () => {
    if (isNullOrUndefined(commentMessageId) || isNullOrUndefined(commentFeedId)) return;
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
  }, [commentMessageId, commentFeedId, commentText, setMessageFeeds, setError]);

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

  const tagIdsList = useMemo(
    () =>
      Object.keys(tagsMap)
        .map(Number)
        .filter((n) => !Number.isNaN(n))
        .sort((a, b) => a - b),
    [tagsMap],
  );

  const handleToggleTag = useCallback(
    async (feedId: string, msgId: number, tagId: number) => {
      const sourceMessage = getMessageByFeedId(messageFeeds, feedId, msgId);
      if (isNullOrUndefined(sourceMessage)) return;

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
    [messageFeeds, authUserName, setMessageFeeds, setError],
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

  const handleArrowClick = useCallback(
    async (feedId: string) => {
      const feed = messageFeeds.find((x) => x.id === feedId);
      if (!feed) return;
      if (!dutyDisableAutoScroll) {
        setWatchModeByFeedId((prev) => ({ ...prev, [feedId]: true }));
      }
      const refs = columnRefsRef.current;
      const scrollToEnd = () => {
        requestAnimationFrame(() => requestAnimationFrame(() => refs[feedId]?.scrollToEnd()));
      };
      scrollToEnd();
      setLoadingNewerFeedId(feedId);
      try {
        if (feed.items.length > 0) {
          const lastItem = feed.items[feed.items.length - 1];
          const { quantity } = await fetchInboxCount(
            buildReqForFeed(feed, { sinceIdNoninclusive: lastItem[0], nolimit: true }),
          );
          if (quantity === 0) {
            showArrowResult(feedId, 'Немає нових повідомлень');
            return;
          }
          setMessageFeeds((prev) =>
            prev.map((f) =>
              f.id === feedId ? { ...f, unreadCount: Math.max(f.unreadCount, quantity) } : f,
            ),
          );
          await loadFeedNewerMessages(feedId, {
            nolimit: true,
            scrollToEndAfterLoad: true,
          });
        } else if (!feed.loading) {
          await loadFeedInitialMessages(feedId);
        }
        showArrowResult(feedId, 'Завантажено нові повідомлення');
      } catch {
        showArrowResult(feedId, 'Немає нових повідомлень');
      } finally {
        setLoadingNewerFeedId((prev) => (prev === feedId ? null : prev));
      }
    },
    [
      messageFeeds,
      loadFeedNewerMessages,
      loadFeedInitialMessages,
      buildReqForFeed,
      showArrowResult,
      columnRefsRef,
      setWatchModeByFeedId,
      setLoadingNewerFeedId,
      setMessageFeeds,
      dutyDisableAutoScroll,
    ],
  );

  const handleVisibleMessageIds = useCallback(
    (feedId: string) => (ids: number[], opts?: { atBottom?: boolean }) => {
      if (ids.length === 0) return;
      setMessageFeeds((prev) =>
        prev.map((f) => {
          if (f.id !== feedId) return f;
          const newlyReadIds = ids.filter((id) => !f.readIds.has(id));
          if (newlyReadIds.length === 0 && !opts?.atBottom) return f;
          const nextReadIds = new Set([...f.readIds, ...newlyReadIds]);
          return {
            ...f,
            readIds: nextReadIds,
            unreadCount: opts?.atBottom ? 0 : Math.max(0, f.unreadCount - newlyReadIds.length),
          };
        }),
      );
    },
    [setMessageFeeds],
  );

  return {
    handleSaveFilter,
    handleApplySavedFilter,
    handleUpdateSelectedSavedFilter,
    handleRenameSelectedSavedFilter,
    handleDeleteSelectedSavedFilter,
    handleDeleteSavedFilter,
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
    handleArrowClick,
    handleVisibleMessageIds,
    commentMessageId,
    commentText,
    setCommentText,
    setCommentMessageId,
    setCommentFeedId,
    deleteConfirmId,
    deleteConfirmFeedId,
    senderOptions: senderOptionsStable,
    tagIdsList,
    copiedFeedbackId,
  };
}
