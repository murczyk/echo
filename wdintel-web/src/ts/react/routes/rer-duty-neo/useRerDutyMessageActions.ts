import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

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
  savedFilterRename,
  savedFilterUpsert,
} from '../../services/api/inbox';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import type { FeedColumnHandle } from './FeedColumn';
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
      'filter' | 'expandedFreqsSelected' | 'expandedFreqsDenied' | 'highlightSignals' | 'reportTagsOnlyThisUnit'
    >,
  ) => InboxMessagesReq;
  columnRefsRef: MutableRefObject<Record<string, FeedColumnHandle | null>>;
  showArrowResult: (feedId: string, message: string) => void;
  setWatchModeByFeedId: Dispatch<SetStateAction<Record<string, boolean>>>;
  setLoadingNewerFeedId: Dispatch<SetStateAction<string | null>>;
  authUserName: string | null;
  profiles: Record<string, SignalProfileEntry | null>;
  tagsMap: Record<number, Tag>;
  savedFilters: SavedFilterDuty[];
  setSavedFilters: Dispatch<SetStateAction<SavedFilterDuty[]>>;
  selectedSavedId: number | null;
  setSelectedSavedId: Dispatch<SetStateAction<number | null>>;
  saveFilterName: string;
  setSaveFilterName: Dispatch<SetStateAction<string>>;
  /** User pref: do not auto-scroll / stay in watch mode on duty. */
  dutyDisableAutoScroll: boolean;
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
    dutyDisableAutoScroll,
  } = deps;

  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [deleteConfirmFeedId, setDeleteConfirmFeedId] = useState<string | null>(null);
  const [commentMessageId, setCommentMessageId] = useState<number | null>(null);
  const [commentFeedId, setCommentFeedId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [copiedFeedbackId, setCopiedFeedbackId] = useState<string | null>(null);
  const copiedFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedFeedbackTimeoutRef.current) clearTimeout(copiedFeedbackTimeoutRef.current);
    };
  }, []);

  const handleSaveFilter = useCallback(
    async (feedId: string) => {
      if (!saveFilterName.trim()) return;
      if (savedFilters.some((savedFilter) => savedFilter.name === saveFilterName.trim())) {
        setError(`Фільтр з назвою "${saveFilterName.trim()}" вже існує`);
        return;
      }
      const w = messageFeeds.find((x) => x.id === feedId);
      if (!w) return;
      try {
        const list = await savedFilterUpsert({ name: saveFilterName.trim(), req: w.filter });
        setSavedFilters(list);
        const created = list.find((savedFilter) => savedFilter.name === saveFilterName.trim());
        if (created != null) setSelectedSavedId(created.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [messageFeeds, saveFilterName, savedFilters, setSavedFilters, setSelectedSavedId, setError],
  );

  const handleApplySavedFilter = useCallback(
    (feedId: string, saved: SavedFilterDuty) => {
      setSelectedSavedId(saved.id);
      setSaveFilterName(saved.name);
      applyFilter(feedId, normalizeFeed(saved.req as unknown as Record<string, unknown>));
    },
    [applyFilter, setSelectedSavedId, setSaveFilterName],
  );

  const handleUpdateSelectedSavedFilter = useCallback(
    async (feedId: string) => {
      if (selectedSavedId == null) return;
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
    [selectedSavedId, savedFilters, messageFeeds, setSavedFilters, setError],
  );

  const handleRenameSelectedSavedFilter = useCallback(async () => {
    if (selectedSavedId == null) return;
    const selectedSaved = savedFilters.find((savedFilter) => savedFilter.id === selectedSavedId);
    if (!selectedSaved) return;
    const trimmed = saveFilterName.trim();
    if (!trimmed || trimmed === selectedSaved.name) return;
    if (savedFilters.some((savedFilter) => savedFilter.id !== selectedSaved.id && savedFilter.name === trimmed)) {
      setError(`Фільтр з назвою "${trimmed}" вже існує`);
      return;
    }
    try {
      await savedFilterRename({ id: selectedSaved.id, name: trimmed });
      setSavedFilters((prev) => prev.map((savedFilter) => (savedFilter.id === selectedSaved.id ? { ...savedFilter, name: trimmed } : savedFilter)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selectedSavedId, savedFilters, saveFilterName, setSavedFilters, setError]);

  const handleDeleteSelectedSavedFilter = useCallback(async () => {
    if (selectedSavedId == null) return;
    try {
      await savedFilterDelete(selectedSavedId);
      setSavedFilters((prev) => prev.filter((x) => x.id !== selectedSavedId));
      setSelectedSavedId(null);
      setSaveFilterName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selectedSavedId, setSavedFilters, setSelectedSavedId, setSaveFilterName, setError]);

  const handleDeleteSavedFilter = useCallback(
    async (id: number) => {
      try {
        await savedFilterDelete(id);
        setSavedFilters((prev) => prev.filter((x) => x.id !== id));
        if (selectedSavedId === id) {
          setSelectedSavedId(null);
          setSaveFilterName('');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [selectedSavedId, setSavedFilters, setSelectedSavedId, setSaveFilterName, setError],
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
          const unreadCount = w.readIds.has(deleteConfirmId) ? w.unreadCount : Math.max(0, w.unreadCount - 1);
          return { ...w, items: newItems, readIds: newReadIds, unreadCount };
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setDeleteConfirmId(null);
    setDeleteConfirmFeedId(null);
  }, [deleteConfirmId, deleteConfirmFeedId, setMessageFeeds, setError]);

  const openCommentDialog = useCallback((msgId: number, feedId: string, currentComment: string | null) => {
    setCommentMessageId(msgId);
    setCommentFeedId(feedId);
    setCommentText(currentComment ?? '');
  }, []);

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
  }, [commentMessageId, commentFeedId, commentText, setMessageFeeds, setError]);

  const senderOptions = useMemo(() => buildSenderOptions(profiles, messageFeeds), [profiles, messageFeeds]);

  const senderOptionsStableRef = useRef(senderOptions);
  const senderOptionsStable =
    senderOptionsStableRef.current.length === senderOptions.length &&
    senderOptionsStableRef.current.every((o, i) => o.id === senderOptions[i].id && o.label === senderOptions[i].label)
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
          const { quantity } = await fetchInboxCount(buildReqForFeed(feed, { sinceIdNoninclusive: lastItem[0], nolimit: true }));
          if (quantity === 0) {
            showArrowResult(feedId, 'Немає нових повідомлень');
            return;
          }
          setMessageFeeds((prev) =>
            prev.map((f) => (f.id === feedId ? { ...f, unreadCount: Math.max(f.unreadCount, quantity) } : f)),
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
