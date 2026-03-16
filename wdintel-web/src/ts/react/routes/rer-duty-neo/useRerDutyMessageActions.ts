import React from 'react';

import type {
  InboxMessage,
  InboxMessageTag,
  InboxMessagesReq,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SavedFilterDuty,
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
  inboxMessageTagsRm,
  savedFilterDelete,
  savedFilterUpsert,
} from '../../services/api/inbox';
import type { FeedColumnHandle } from './FeedColumn';
import { normalizeFeed, profileLabel } from './utils';
import type { MessageFeedState } from './utils';

export type MessageActionsDeps = {
  messageFeeds: MessageFeedState[];
  setMessageFeeds: React.Dispatch<React.SetStateAction<MessageFeedState[]>>;
  setError: (value: React.SetStateAction<string | null>) => void;
  applyFilter: (feedId: string, f: RerDutyFeedFilterState) => void;
  loadFeedInitialMessages: (
    feedId: string,
    overrides?: { highlightSignalsEnabled?: boolean; onlyMyUnitTagsEnabled?: boolean },
  ) => Promise<void>;
  loadFeedNewerMessages: (
    feedId: string,
    opts?: { nolimit?: boolean; scrollToEndAfterLoad?: boolean; markAllReadAfterAppend?: boolean },
  ) => Promise<void>;
  buildReqForFeed: (feed: MessageFeedState, opts: { sinceDateInclusiveMs?: number; nolimit?: boolean }) => InboxMessagesReq;
  columnRefsRef: React.MutableRefObject<Record<string, FeedColumnHandle | null>>;
  showArrowResult: (feedId: string, message: string) => void;
  setWatchModeByFeedId: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setLoadingNewerFeedId: React.Dispatch<React.SetStateAction<string | null>>;
  authUserName: string | null;
  profiles: Record<string, SignalProfileEntry | null>;
  tagsMap: Record<number, Tag>;
  savedFilters: SavedFilterDuty[];
  setSavedFilters: React.Dispatch<React.SetStateAction<SavedFilterDuty[]>>;
  selectedSavedId: number | null;
  setSelectedSavedId: React.Dispatch<React.SetStateAction<number | null>>;
  saveFilterName: string;
  setSaveFilterName: React.Dispatch<React.SetStateAction<string>>;
};

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
    savedFilters,
    setSavedFilters,
    selectedSavedId,
    setSelectedSavedId,
    saveFilterName,
    setSaveFilterName,
  } = deps;

  const [deleteConfirmId, setDeleteConfirmId] = React.useState<number | null>(null);
  const [deleteConfirmFeedId, setDeleteConfirmFeedId] = React.useState<string | null>(null);
  const [commentMessageId, setCommentMessageId] = React.useState<number | null>(null);
  const [commentFeedId, setCommentFeedId] = React.useState<string | null>(null);
  const [commentText, setCommentText] = React.useState('');
  const [copiedFeedbackId, setCopiedFeedbackId] = React.useState<string | null>(null);
  const copiedFeedbackTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (copiedFeedbackTimeoutRef.current) clearTimeout(copiedFeedbackTimeoutRef.current);
    };
  }, []);

  const handleSaveFilter = React.useCallback(
    async (feedId: string) => {
      if (!saveFilterName.trim()) return;
      const w = messageFeeds.find((x) => x.id === feedId);
      if (!w) return;
      try {
        const list = await savedFilterUpsert({ name: saveFilterName.trim(), req: w.filter });
        setSavedFilters(list);
        setSaveFilterName('');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [messageFeeds, saveFilterName, setSavedFilters, setSaveFilterName, setError],
  );

  const handleApplySavedFilter = React.useCallback(
    (feedId: string, saved: SavedFilterDuty) => {
      setSelectedSavedId(saved.id);
      applyFilter(feedId, normalizeFeed(saved.req as unknown as Record<string, unknown>));
    },
    [applyFilter, setSelectedSavedId],
  );

  const handleDeleteSavedFilter = React.useCallback(
    async (id: number) => {
      try {
        await savedFilterDelete(id);
        setSavedFilters((prev) => prev.filter((x) => x.id !== id));
        if (selectedSavedId === id) setSelectedSavedId(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [selectedSavedId, setSavedFilters, setSelectedSavedId, setError],
  );

  const handleMessageBookmark = React.useCallback(
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
                    msgId === id ? [msgId, { ...msg, bookmarked: !currentlyBookmarked }] : [msgId, msg],
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

  const handleMessageImportant = React.useCallback(
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
                    msgId === id ? [msgId, { ...msg, important: !currentlyImportant }] : [msgId, msg],
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

  const handleMessageCopy = React.useCallback((text: string, feedbackId: string) => {
    navigator.clipboard?.writeText(text).catch((err) => {
      console.error('Failed to copy text to clipboard', err);
    });
    if (copiedFeedbackTimeoutRef.current) clearTimeout(copiedFeedbackTimeoutRef.current);
    setCopiedFeedbackId(feedbackId);
    copiedFeedbackTimeoutRef.current = setTimeout(() => {
      setCopiedFeedbackId(null);
      copiedFeedbackTimeoutRef.current = null;
    }, 1000);
  }, []);

  const handleDeleteConfirm = React.useCallback(async () => {
    if (deleteConfirmId == null || deleteConfirmFeedId == null) return;
    try {
      await deleteMessage({ id: deleteConfirmId });
      setMessageFeeds((prev) =>
        prev.map((w) => {
          if (w.id !== deleteConfirmFeedId) return w;
          const newItems = w.items.filter(([id]) => id !== deleteConfirmId);
          const newReadIds = new Set([...w.readIds].filter((id) => id !== deleteConfirmId));
          const unreadCount = newItems.filter(([id]) => !newReadIds.has(id)).length;
          return { ...w, items: newItems, readIds: newReadIds, unreadCount };
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setDeleteConfirmId(null);
    setDeleteConfirmFeedId(null);
  }, [deleteConfirmId, deleteConfirmFeedId, setMessageFeeds, setError]);

  const openCommentDialog = React.useCallback((msgId: number, feedId: string, currentComment: string | null) => {
    setCommentMessageId(msgId);
    setCommentFeedId(feedId);
    setCommentText(currentComment ?? '');
  }, []);

  const handleCommentSave = React.useCallback(async () => {
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
  }, [commentMessageId, commentFeedId, commentText, setMessageFeeds, setError]);

  const senderOptions = React.useMemo(() => {
    const next = Object.entries(profiles).map(([uuid, entry]) => ({
      id: uuid,
      label: profileLabel(uuid, entry),
    }));
    next.sort((a, b) => a.id.localeCompare(b.id));
    return next;
  }, [profiles]);

  const senderOptionsStableRef = React.useRef(senderOptions);
  const senderOptionsStable =
    senderOptionsStableRef.current.length === senderOptions.length &&
    senderOptionsStableRef.current.every((o, i) => o.id === senderOptions[i].id && o.label === senderOptions[i].label)
      ? senderOptionsStableRef.current
      : ((senderOptionsStableRef.current = senderOptions), senderOptions);

  const tagIdsList = React.useMemo(
    () =>
      Object.keys(tagsMap)
        .map(Number)
        .filter((n) => !Number.isNaN(n))
        .sort((a, b) => a - b),
    [tagsMap],
  );

  const handleToggleTag = React.useCallback(
    async (feedId: string, msgId: number, tagId: number) => {
      const w = messageFeeds.find((x) => x.id === feedId);
      if (!w) return;
      const pair = w.items.find(([id]) => id === msgId);
      if (!pair) return;
      const [, msg] = pair;
      const hasTag =
        (msg.tags ?? []).includes(tagId) || (msg.inboxTags ?? []).some((t) => t.tagId === tagId);
      const nextTags = hasTag ? (msg.tags ?? []).filter((id) => id !== tagId) : [...(msg.tags ?? []), tagId];
      let nextInboxTags: InboxMessageTag[] | null;
      if (hasTag) {
        const filtered = (msg.inboxTags ?? []).filter((t) => t.tagId !== tagId);
        nextInboxTags = filtered.length ? filtered : null;
      } else {
        nextInboxTags = [
          ...(msg.inboxTags ?? []),
          { id: 0, tagId, confidence: 1, login: authUserName, model: null, organismId: null },
        ];
      }
      const updated: InboxMessage = {
        ...msg,
        tags: nextTags.length ? nextTags : null,
        inboxTags: nextInboxTags?.length ? nextInboxTags : null,
      };
      setMessageFeeds((prev) =>
        prev.map((x) =>
          x.id === feedId ? { ...x, items: x.items.map(([id, m]) => (id === msgId ? [id, updated] : [id, m])) } : x,
        ),
      );
      try {
        if (hasTag) await inboxMessageTagsRm({ messageId: msgId, tagId });
        else await inboxMessageTagsAdd({ messageId: msgId, tagId });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setMessageFeeds((prev) =>
          prev.map((x) =>
            x.id === feedId ? { ...x, items: x.items.map(([id, m]) => (id === msgId ? [id, msg] : [id, m])) } : x,
          ),
        );
      }
    },
    [messageFeeds, authUserName, setMessageFeeds, setError],
  );

  const handleArrowClick = React.useCallback(
    async (feedId: string) => {
      const feed = messageFeeds.find((x) => x.id === feedId);
      if (!feed) return;
      setWatchModeByFeedId((prev) => ({ ...prev, [feedId]: true }));
      const refs = columnRefsRef.current;
      const scrollToEnd = () => {
        requestAnimationFrame(() => requestAnimationFrame(() => refs[feedId]?.scrollToEnd()));
      };
      scrollToEnd();
      setLoadingNewerFeedId(feedId);
      try {
        if (feed.items.length > 0) {
          const lastItem = feed.items[feed.items.length - 1];
          const sinceMs =
            lastItem != null && lastItem[1].timestamp != null && lastItem[1].timestamp > 0
              ? lastItem[1].timestamp + 1
              : 0;
          const { quantity } = await fetchInboxCount(
            buildReqForFeed(feed, { sinceDateInclusiveMs: sinceMs, nolimit: true }),
          );
          if (quantity === 0) {
            showArrowResult(feedId, 'Немає нових повідомлень');
            return;
          }
          setMessageFeeds((prev) =>
            prev.map((f) => (f.id === feedId ? { ...f, unreadCount: Math.max(f.unreadCount, quantity) } : f)),
          );
          await loadFeedNewerMessages(feedId, { nolimit: true, scrollToEndAfterLoad: true });
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
    ],
  );

  const handleVisibleMessageIds = React.useCallback(
    (feedId: string) => (ids: number[], opts?: { atBottom?: boolean }) => {
      if (ids.length === 0) return;
      setMessageFeeds((prev) =>
        prev.map((f) => {
          if (f.id !== feedId) return f;
          if (ids.length >= f.items.length && !opts?.atBottom) return f;
          const nextReadIds = new Set([...f.readIds, ...ids]);
          if (nextReadIds.size === f.readIds.size && ids.every((id) => f.readIds.has(id))) return f;
          return {
            ...f,
            readIds: nextReadIds,
            unreadCount: f.items.filter(([id]) => !nextReadIds.has(id)).length,
          };
        }),
      );
    },
    [setMessageFeeds],
  );

  return {
    handleSaveFilter,
    handleApplySavedFilter,
    handleDeleteSavedFilter,
    handleMessageBookmark,
    handleMessageImportant,
    handleMessageCopy,
    handleDeleteConfirm,
    setDeleteConfirmId,
    setDeleteConfirmFeedId,
    openCommentDialog,
    handleCommentSave,
    handleToggleTag,
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
