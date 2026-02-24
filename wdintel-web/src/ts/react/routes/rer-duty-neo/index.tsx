import { Box, Button, Paper, Typography } from '@mui/material';
import React from 'react';

import type {
  InboxMessage,
  InboxMessageTag,
  InboxMessagesReq,
  Network,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SavedFilterDuty,
  SignalGroupEntry,
  SignalProfileEntry,
  Unit,
} from '../../../../Bindings';
import {
  bookmarkAdd,
  bookmarkRemove,
  commentSave,
  deleteMessage,
  getGroupInfosBatch,
  fetchInboxCount,
  fetchInboxMessages,
  getLatestFrequencies,
  getLatestSenders,
  getTagsList,
  getUserSigintGroups,
  importantAdd,
  importantRemove,
  inboxMessageTagsAdd,
  inboxMessageTagsRm,
  savedFilterDelete,
  savedFiltersList,
  savedFilterUpsert,
} from '../../services/api/inbox';
import { getNetworksByIds } from '../../services/api/networks';
import { getUnitsList } from '../../services/api/units';
import { CommentDialog, DeleteConfirmDialog } from './dialogs';
import { FeedColumn, type FeedColumnHandle } from './FeedColumn';
import {
  buildInboxReq,
  createMasterUnitText,
  dedupeMessageItems,
  emptyFilter,
  generateMessageFeedId,
  INBOX_COUNT_POLL_INTERVAL_MS,
  normalizeFeed,
  VIRTUOSO_FIRST_ITEM_INDEX_INITIAL,
  parseStateFromUrl,
  profileLabel,
  pushStateToUrl,
  sortMessageItemsByTime,
  toQueryState,
} from './utils';
import type { MessageFeedState } from './utils';

const MAX_MESSAGE_FEEDS = 4;

export type RerDutyNeoPageProps = {
  /** Auth user display name from Elm layout (avoids duplicate /api/user request). */
  authUserName?: string | null;
};

export function RerDutyNeoPage({ authUserName: authUserNameProp = null }: RerDutyNeoPageProps = {}) {
  const [messageFeeds, setMessageFeeds] = React.useState<MessageFeedState[]>(() => {
    const state = parseStateFromUrl();
    return (state.messageFeeds ?? [['mf-0', emptyFilter()]]).map(([id, filter]) => ({
      id,
      filter,
      items: [],
      loading: true,
      loadingEarlier: false,
      hasReachedStart: false,
      firstItemIndex: VIRTUOSO_FIRST_ITEM_INDEX_INITIAL,
      referenceTimeMs: null,
    }));
  });
  const [error, setError] = React.useState<string | null>(null);
  const [profiles, setProfiles] = React.useState<Record<string, SignalProfileEntry | null>>({});
  const [freqs, setFreqs] = React.useState<string[]>([]);
  const [groupInfos, setGroupInfos] = React.useState<Record<string, SignalGroupEntry>>({});
  const [groupsList, setGroupsList] = React.useState<string[]>([]);
  const [tagsMap, setTagsMap] = React.useState<Record<number, string>>({});
  const [savedFilters, setSavedFilters] = React.useState<SavedFilterDuty[]>([]);
  const [selectedSavedId, setSelectedSavedId] = React.useState<number | null>(null);
  const [saveFilterName, setSaveFilterName] = React.useState('');
  const [digestCount, setDigestCount] = React.useState<number | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = React.useState<number | null>(null);
  const [deleteConfirmFeedId, setDeleteConfirmFeedId] = React.useState<string | null>(null);
  const [commentMessageId, setCommentMessageId] = React.useState<number | null>(null);
  const [commentFeedId, setCommentFeedId] = React.useState<string | null>(null);
  const [commentText, setCommentText] = React.useState('');
  const [reloadFreqsLoading, setReloadFreqsLoading] = React.useState(false);
  const [networkMap, setNetworkMap] = React.useState<Record<number, Network>>({});
  const [unitsMap, setUnitsMap] = React.useState<Record<number, Unit>>({});
  const authUserName = authUserNameProp ?? null;
  const loadNewerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshMessageCounterRef = React.useRef<() => Promise<void>>(() => Promise.resolve());
  /** Time (ms) from which we count "new" messages for the digest badge; set once on mount */
  const digestSinceMsRef = React.useRef<number | null>(null);
  /** Feed IDs that currently have a get-inbox (load newer) request in flight; prevents duplicate requests from polling. */
  const loadNewerInFlightRef = React.useRef<Set<string>>(new Set());
  /** Which feed columns are in "watch mode" (auto-scroll to newest when new messages arrive). */
  const [watchModeByFeedId, setWatchModeByFeedId] = React.useState<Record<string, boolean>>({});
  /** Feed id currently loading newer messages (after arrow click). */
  const [loadingNewerFeedId, setLoadingNewerFeedId] = React.useState<string | null>(null);
  /** Brief per-feed message after arrow click ("Немає нових" / "Завантажено нові"), cleared after delay. */
  const [arrowResultByFeedId, setArrowResultByFeedId] = React.useState<Record<string, string | null>>({});
  const columnRefsRef = React.useRef<Record<string, FeedColumnHandle | null>>({});
  const arrowResultTimeoutsRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /** Feed ID to scroll to end after next commit (used after load newer so we scroll once new items are rendered). */
  const scrollToEndAfterNewerRef = React.useRef<string | null>(null);

  const mountedRef = React.useRef(true);
  const showArrowResult = React.useCallback((feedId: string, message: string) => {
    const key = feedId;
    if (arrowResultTimeoutsRef.current[key]) clearTimeout(arrowResultTimeoutsRef.current[key]);
    setArrowResultByFeedId((prev) => ({ ...prev, [feedId]: message }));
    arrowResultTimeoutsRef.current[key] = setTimeout(() => {
      delete arrowResultTimeoutsRef.current[key];
      setArrowResultByFeedId((prev) => (prev[feedId] === message ? { ...prev, [feedId]: null } : prev));
    }, 3000);
  }, []);

  React.useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (copiedFeedbackTimeoutRef.current) clearTimeout(copiedFeedbackTimeoutRef.current);
      Object.values(arrowResultTimeoutsRef.current).forEach(clearTimeout);
    };
  }, []);
  const reloadLatestFrequencies = React.useCallback(async () => {
    setReloadFreqsLoading(true);
    try {
      const list = await getLatestFrequencies();
      if (mountedRef.current) setFreqs(list);
    } finally {
      if (mountedRef.current) setReloadFreqsLoading(false);
    }
  }, []);

  const loadFilterOptions = React.useCallback(async () => {
    try {
      const [sendersRsp, freqsList, groupKeys, tagsList] = await Promise.all([
        getLatestSenders(),
        getLatestFrequencies(),
        getUserSigintGroups(Date.now() - 2 * 24 * 60 * 60 * 1000),
        getTagsList(),
      ]);
      setProfiles(sendersRsp.data ?? {});
      setFreqs(freqsList);
      setTagsMap(tagsList);
      if (groupKeys.length > 0) {
        const infos = await getGroupInfosBatch(groupKeys);
        const map: Record<string, SignalGroupEntry> = {};
        infos.forEach((g) => {
          map[g.masterKey] = g;
        });
        setGroupInfos(map);
        setGroupsList(groupKeys);
      }
      const saved = await savedFiltersList();
      setSavedFilters(saved);
    } catch {
      // non-fatal
    }
  }, []);

  const loadFeedInitialMessages = React.useCallback(async (feedId: string, filter: RerDutyFeedFilterState) => {
    setMessageFeeds((prev) => prev.map((x) => (x.id === feedId ? { ...x, loading: true } : x)));
    setError(null);
    try {
      const req = buildInboxReq({ loadLatest: true, filter });
      const rsp = await fetchInboxMessages(req);
      const deduped = dedupeMessageItems(rsp.inboxItems);
      setMessageFeeds((prev) =>
        prev.map((x) =>
          x.id === feedId
            ? {
                ...x,
                items: sortMessageItemsByTime(deduped),
                loading: false,
                firstItemIndex: VIRTUOSO_FIRST_ITEM_INDEX_INITIAL,
                referenceTimeMs: Date.now(),
              }
            : x,
        ),
      );
      if (rsp.signalProfiles) setProfiles((p) => ({ ...p, ...rsp.signalProfiles }));
      if (rsp.signalGroups?.length) {
        const map: Record<string, SignalGroupEntry> = {};
        rsp.signalGroups.forEach((g) => {
          map[g.masterKey] = g;
        });
        setGroupInfos((prev) => ({ ...prev, ...map }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMessageFeeds((prev) => prev.map((x) => (x.id === feedId ? { ...x, loading: false } : x)));
    }
  }, []);

  const loadFeedEarlierMessages = React.useCallback(
    async (feedId: string) => {
      const w = messageFeeds.find((x) => x.id === feedId);
      if (!w || w.items.length === 0 || w.hasReachedStart) return;
      const firstId = w.items[0][0];
      setMessageFeeds((prev) => prev.map((x) => (x.id === feedId ? { ...x, loadingEarlier: true } : x)));
      setError(null);
      try {
        const req = buildInboxReq({
          beforeIdNoninclusive: firstId,
          filter: w.filter,
        });
        const rsp = await fetchInboxMessages(req);
        setMessageFeeds((prev) =>
          prev.map((x) => {
            if (x.id !== feedId) return x;
            const existingIds = new Set(x.items.map(([id]) => id));
            const newItems = rsp.inboxItems.filter(([id]) => !existingIds.has(id));
            const hasReachedStart = newItems.length === 0;
            const prevFirst = x.firstItemIndex ?? VIRTUOSO_FIRST_ITEM_INDEX_INITIAL;
            const firstItemIndex = Math.max(0, prevFirst - newItems.length);
            const combined = dedupeMessageItems([...newItems, ...x.items]);
            return {
              ...x,
              items: sortMessageItemsByTime(combined),
              loadingEarlier: false,
              hasReachedStart,
              firstItemIndex,
            };
          }),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setMessageFeeds((prev) => prev.map((x) => (x.id === feedId ? { ...x, loadingEarlier: false } : x)));
      }
    },
    [messageFeeds],
  );

  const loadFeedNewerMessages = React.useCallback(
    async (feedId: string) => {
      // Prevent duplicate requests from polling
      if (loadNewerInFlightRef.current.has(feedId)) return;
      const feed = messageFeeds.find((x) => x.id === feedId);
      if (!feed || feed.items.length === 0) return;
      loadNewerInFlightRef.current.add(feedId);
      const lastId = feed.items[feed.items.length - 1][0];
      try {
        const req = buildInboxReq({
          sinceIdNoninclusive: lastId,
          filter: feed.filter,
        });
        const rsp = await fetchInboxMessages(req);
        if (rsp.inboxItems.length > 0) {
          const feedNow = messageFeeds.find((x) => x.id === feedId);
          if (feedNow) {
            const newItems = rsp.inboxItems.filter(([id]) => !new Set(feedNow.items.map(([i]) => i)).has(id));
            if (newItems.length > 0) {
              setMessageFeeds((prev) =>
                prev.map((x) => {
                  if (x.id !== feedId) return x;
                  const existingIds = new Set(x.items.map(([id]) => id));
                  const toAdd = newItems.filter(([id]) => !existingIds.has(id));
                  if (toAdd.length === 0) return x;
                  const combined = dedupeMessageItems([...x.items, ...toAdd]);
                  return { ...x, items: sortMessageItemsByTime(combined) };
                }),
              );
              if (messageFeeds[0]?.id === feedId) {
                digestSinceMsRef.current = Math.floor(Date.now() / 1000) * 1000;
                setDigestCount(0);
              }
              scrollToEndAfterNewerRef.current = feedId;
            }
          }
        }
      } catch {
        // ignore single failure to keep polling and prev messages
      } finally {
        loadNewerInFlightRef.current.delete(feedId);
      }
    },
    [messageFeeds],
  );

  const refreshMessageCounter = React.useCallback(async () => {
    const w = messageFeeds[0];
    if (!w) return;
    const sinceMs = digestSinceMsRef.current ?? Math.floor(Date.now() / 1000) * 1000;
    if (digestSinceMsRef.current == null) digestSinceMsRef.current = sinceMs;
    try {
      const req = buildInboxReq({
        filter: w.filter,
        sinceDateInclusiveMs: sinceMs,
        nolimit: true,
      });
      const d = await fetchInboxCount(req);
      setDigestCount(d.quantity);
      if (d.quantity > 0) {
        for (const feedId of Object.keys(watchModeByFeedId)) {
          if (watchModeByFeedId[feedId]) {
            await loadFeedNewerMessages(feedId);
          }
        }
      }
    } catch {
      setDigestCount(null);
    }
  }, [messageFeeds, watchModeByFeedId, loadFeedNewerMessages]);
  refreshMessageCounterRef.current = refreshMessageCounter;

  React.useEffect(() => {
    loadFilterOptions();
  }, [loadFilterOptions]);

  React.useEffect(() => {
    digestSinceMsRef.current = Math.floor(Date.now() / 1000) * 1000;
    refreshMessageCounterRef.current();
  }, []);

  const feedIds = React.useMemo(() => messageFeeds.map((w) => w.id).join(','), [messageFeeds]);
  const feedsNeedingLoadKey = React.useMemo(
    () =>
      messageFeeds
        .filter((w) => w.loading && w.items.length === 0)
        .map((w) => `${w.id}:${JSON.stringify(w.filter)}`)
        .join(';'),
    [messageFeeds],
  );
  React.useEffect(() => {
    messageFeeds.forEach((w) => {
      if (w.loading && w.items.length === 0) loadFeedInitialMessages(w.id, w.filter);
    });
  }, [feedIds, feedsNeedingLoadKey, loadFeedInitialMessages]);

  // Poll get-inbox-count every 2s
  React.useEffect(() => {
    loadNewerRef.current = setInterval(() => {
      refreshMessageCounter();
    }, INBOX_COUNT_POLL_INTERVAL_MS);
    return () => {
      if (loadNewerRef.current) clearInterval(loadNewerRef.current);
    };
  }, [refreshMessageCounter]);

  // After we merged newer messages, scroll that feed to end once the new items are rendered
  React.useEffect(() => {
    const feedId = scrollToEndAfterNewerRef.current;
    if (feedId == null) return;
    scrollToEndAfterNewerRef.current = null;
    const refs = columnRefsRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => refs[feedId]?.scrollToEnd());
    });
  }, [messageFeeds]);

  // Fetch missing networks on demand - only IDs that appear in messages and are not yet loaded
  const allNetworkIds = React.useMemo(() => {
    const ids = new Set<number>();
    messageFeeds.forEach((w) => {
      w.items.forEach(([, msg]) => {
        (msg.networkIds ?? []).forEach((id) => ids.add(id));
      });
    });
    return Array.from(ids);
  }, [messageFeeds]);

  const networkMapRef = React.useRef(networkMap);
  networkMapRef.current = networkMap;
  React.useEffect(() => {
    const missing = allNetworkIds.filter((id) => !(id in networkMapRef.current));
    if (missing.length === 0) return;
    let cancelled = false;
    getNetworksByIds(missing)
      .then((networks) => {
        if (cancelled) return;
        setNetworkMap((prev) => {
          const next = { ...prev };
          networks.forEach((n) => {
            next[n.id] = n;
          });
          return next;
        });
      })
      .catch((err) => console.error('Failed to load networks', err));
    return () => {
      cancelled = true;
    };
  }, [allNetworkIds.join(',')]);

  // Fetch all units once for network display text
  React.useEffect(() => {
    let cancelled = false;
    getUnitsList()
      .then((units) => {
        if (cancelled) return;
        setUnitsMap((prev) => {
          const next = { ...prev };
          units.forEach((u) => {
            next[u.id] = u;
          });
          return next;
        });
      })
      .catch((err) => console.error('Failed to load units', err));
    return () => {
      cancelled = true;
    };
  }, []);

  const networkDisplayMap = React.useMemo(() => {
    const out: Record<number, string> = {};
    Object.entries(networkMap).forEach(([idStr, n]) => {
      const id = Number(idStr);
      out[id] = createMasterUnitText(n, unitsMap);
    });
    return out;
  }, [networkMap, unitsMap]);

  const applyFilter = React.useCallback((feedId: string, f: RerDutyFeedFilterState) => {
    setMessageFeeds((prev) => {
      const next = prev.map((w) =>
        w.id === feedId
          ? {
              ...w,
              filter: f,
              items: [],
              loading: true,
              hasReachedStart: false,
              firstItemIndex: VIRTUOSO_FIRST_ITEM_INDEX_INITIAL,
              referenceTimeMs: null,
            }
          : w,
      );
      pushStateToUrl(toQueryState(next));
      return next;
    });
  }, []);

  const toggleGroup = (feedId: string, key: string) => {
    const w = messageFeeds.find((x) => x.id === feedId);
    if (!w) return;
    const current = w.filter.groupsSelected ?? [];
    const next = current.includes(key) ? current.filter((x) => x !== key) : [...current, key];
    const f = { ...w.filter, groupsSelected: next.length ? next : null };
    applyFilter(feedId, f);
  };

  const selectAllGroups = (feedId: string) => {
    const w = messageFeeds.find((x) => x.id === feedId);
    if (!w) return;
    const f = { ...w.filter, groupsSelected: null };
    applyFilter(feedId, f);
  };

  const createMessageFeed = React.useCallback(() => {
    const id = generateMessageFeedId();
    const newFeed: MessageFeedState = {
      id,
      filter: emptyFilter(),
      items: [],
      loading: true,
      loadingEarlier: false,
      hasReachedStart: false,
      firstItemIndex: VIRTUOSO_FIRST_ITEM_INDEX_INITIAL,
      referenceTimeMs: null,
    };
    setMessageFeeds((prev) => {
      if (prev.length >= MAX_MESSAGE_FEEDS || prev.some((w) => w.id === id)) return prev;
      const next = [...prev, newFeed];
      pushStateToUrl(toQueryState(next));
      return next;
    });
    // Initial load for the new column is triggered by the useEffect when messageFeeds change
  }, []);

  const removeMessageFeed = React.useCallback(
    (feedId: string) => {
      if (messageFeeds.length <= 1) return;
      setMessageFeeds((prev) => {
        const next = prev.filter((w) => w.id !== feedId);
        pushStateToUrl(toQueryState(next));
        return next;
      });
    },
    [messageFeeds.length],
  );

  const handleSaveFilter = async (feedId: string) => {
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
  };

  const handleApplySavedFilter = (feedId: string, saved: SavedFilterDuty) => {
    setSelectedSavedId(saved.id);
    applyFilter(feedId, normalizeFeed(saved.req as unknown as Record<string, unknown>));
  };

  const handleDeleteSavedFilter = async (id: number) => {
    try {
      await savedFilterDelete(id);
      setSavedFilters((prev) => prev.filter((x) => x.id !== id));
      if (selectedSavedId === id) setSelectedSavedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleMessageBookmark = async (feedId: string, id: number, currentlyBookmarked: boolean) => {
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
  };

  const handleMessageImportant = async (feedId: string, id: number, currentlyImportant: boolean) => {
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
  };

  const [copiedFeedbackId, setCopiedFeedbackId] = React.useState<string | null>(null);
  const copiedFeedbackTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMessageCopy = (text: string, feedbackId: string) => {
    navigator.clipboard?.writeText(text).catch((err) => {
      console.error('Failed to copy text to clipboard', err);
    });
    if (copiedFeedbackTimeoutRef.current) clearTimeout(copiedFeedbackTimeoutRef.current);
    setCopiedFeedbackId(feedbackId);
    copiedFeedbackTimeoutRef.current = setTimeout(() => {
      setCopiedFeedbackId(null);
      copiedFeedbackTimeoutRef.current = null;
    }, 1000);
  };

  const handleDeleteConfirm = async () => {
    if (deleteConfirmId == null || deleteConfirmFeedId == null) return;
    try {
      await deleteMessage({ id: deleteConfirmId });
      setMessageFeeds((prev) =>
        prev.map((w) =>
          w.id === deleteConfirmFeedId ? { ...w, items: w.items.filter(([id]) => id !== deleteConfirmId) } : w,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setDeleteConfirmId(null);
    setDeleteConfirmFeedId(null);
  };

  const openCommentDialog = (msgId: number, feedId: string, currentComment: string | null) => {
    setCommentMessageId(msgId);
    setCommentFeedId(feedId);
    setCommentText(currentComment ?? '');
  };

  const handleCommentSave = async () => {
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
  };

  const senderOptions = React.useMemo(() => {
    return Object.entries(profiles).map(([uuid, entry]) => ({
      id: uuid,
      label: profileLabel(uuid, entry),
    }));
  }, [profiles]);

  const tagIdsList = React.useMemo(
    () =>
      Object.keys(tagsMap)
        .map(Number)
        .filter((n) => !Number.isNaN(n))
        .sort((a, b) => a - b),
    [tagsMap],
  );

  function messageHasTag(msg: InboxMessage, tagId: number): boolean {
    if ((msg.inboxTags ?? []).length > 0) return (msg.inboxTags ?? []).some((t) => t.tagId === tagId);
    return (msg.tags ?? []).includes(tagId);
  }

  const handleToggleTag = React.useCallback(
    async (feedId: string, msgId: number, tagId: number) => {
      const w = messageFeeds.find((x) => x.id === feedId);
      if (!w) return;
      const pair = w.items.find(([id]) => id === msgId);
      if (!pair) return;
      const [, msg] = pair;
      const hasTag = messageHasTag(msg, tagId);
      const updateMessage = (m: InboxMessage): InboxMessage => {
        if (hasTag) {
          const nextInbox = (m.inboxTags ?? []).filter((t) => t.tagId !== tagId);
          const nextTags = (m.tags ?? []).filter((id) => id !== tagId);
          return { ...m, inboxTags: nextInbox.length ? nextInbox : null, tags: nextTags.length ? nextTags : null };
        }
        const newEntry: InboxMessageTag = {
          id: 0,
          tagId,
          confidence: 1,
          login: null,
          model: null,
          organismId: null,
        };
        const nextInbox = [...(m.inboxTags ?? []), newEntry];
        const tagIds = [...new Set([...(m.tags ?? []), ...nextInbox.map((t) => t.tagId)])];
        return { ...m, inboxTags: nextInbox, tags: tagIds };
      };
      setMessageFeeds((prev) =>
        prev.map((x) =>
          x.id === feedId
            ? { ...x, items: x.items.map(([id, m]) => (id === msgId ? [id, updateMessage(m)] : [id, m])) }
            : x,
        ),
      );
      try {
        if (hasTag) await inboxMessageTagsRm({ messageId: msgId, tagId });
        else await inboxMessageTagsAdd({ messageId: msgId, tagId });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setMessageFeeds((prev) =>
          prev.map((x) =>
            x.id === feedId ? { ...x, items: x.items.map(([id, m]) => (id === msgId ? [id, pair[1]] : [id, m])) } : x,
          ),
        );
      }
    },
    [messageFeeds],
  );

  return (
    <Box className="flex flex-col w-full" sx={{ height: 'calc(100vh - 80px)', minHeight: 0, overflow: 'hidden' }}>
      <Box className="flex items-center justify-between flex-wrap gap-2 mb-2 shrink-0" />

      {error && (
        <Paper elevation={0} className="p-2 mb-2 shrink-0" sx={{ bgcolor: 'error.light', color: 'error.contrastText' }}>
          {error}
        </Paper>
      )}

      <Box className="flex flex-1 flex-nowrap gap-2 overflow-x-auto justify-center w-full min-h-0">
        {messageFeeds.map((w) => {
          const filterStable = {
            groupsSelected: w.filter.groupsSelected ?? [],
            sendersSelected: w.filter.sendersSelected ?? [],
            deniedSenders: w.filter.deniedSenders ?? [],
            freqsSelected: w.filter.freqsSelected ?? [],
            freqsDenied: w.filter.freqsDenied ?? [],
          };
          return (
            <FeedColumn
              key={w.id}
              ref={(el) => {
                columnRefsRef.current[w.id] = el;
              }}
              feed={w}
              filterStable={filterStable}
              groupsList={groupsList}
              groupInfos={groupInfos}
              profiles={profiles}
              senderOptions={senderOptions}
              freqs={freqs}
              savedFilters={savedFilters}
              selectedSavedId={selectedSavedId}
              saveFilterName={saveFilterName}
              reloadFreqsLoading={reloadFreqsLoading}
              canRemove={messageFeeds.length > 1}
              maxWidth={
                messageFeeds.length >= 4
                  ? 'calc((100% - 2rem) / 4)'
                  : messageFeeds.length === 3
                    ? 'calc((100% - 2rem - 48px) / 3)'
                    : messageFeeds.length === 2
                      ? 'calc((90% - 2rem - 48px) / 2)'
                      : '45%'
              }
              authUserName={authUserName}
              copiedFeedbackId={copiedFeedbackId}
              networkDisplayMap={networkDisplayMap}
              tagsMap={tagsMap}
              tagIdsList={tagIdsList}
              messageHasTag={messageHasTag}
              onLoadEarlier={() => loadFeedEarlierMessages(w.id)}
              onRemoveColumn={() => removeMessageFeed(w.id)}
              onApplyFilter={(f) => applyFilter(w.id, f)}
              onSelectAllGroups={() => selectAllGroups(w.id)}
              onToggleGroup={(key) => toggleGroup(w.id, key)}
              onSendersChange={(v) => applyFilter(w.id, { ...w.filter, sendersSelected: v.length ? v : null })}
              onDeniedSendersChange={(v) => applyFilter(w.id, { ...w.filter, deniedSenders: v.length ? v : null })}
              onFreqsChange={(v) => applyFilter(w.id, { ...w.filter, freqsSelected: v.length ? v : null })}
              onFreqsDeniedChange={(v) => applyFilter(w.id, { ...w.filter, freqsDenied: v.length ? v : null })}
              onReloadFreqs={reloadLatestFrequencies}
              onSavedFilterSelect={(id) => setSelectedSavedId(id === '' ? null : id)}
              onSaveFilterNameChange={setSaveFilterName}
              onSaveFilter={() => handleSaveFilter(w.id)}
              onApplySavedFilter={(saved) => handleApplySavedFilter(w.id, saved)}
              onDeleteSavedFilter={handleDeleteSavedFilter}
              onMessageBookmark={(msgId, currentlyBookmarked) =>
                handleMessageBookmark(w.id, msgId, currentlyBookmarked)
              }
              onMessageImportant={(msgId, currentlyImportant) =>
                handleMessageImportant(w.id, msgId, currentlyImportant)
              }
              onMessageCopy={handleMessageCopy}
              onMessageComment={(msgId, currentComment) => openCommentDialog(msgId, w.id, currentComment)}
              onMessageToggleTag={(msgId, tagId) => handleToggleTag(w.id, msgId, tagId)}
              onScrollToTop={() => setWatchModeByFeedId((prev) => ({ ...prev, [w.id]: false }))}
              onReachedBottom={() => setWatchModeByFeedId((prev) => ({ ...prev, [w.id]: true }))}
              onLeftBottom={() => setWatchModeByFeedId((prev) => ({ ...prev, [w.id]: false }))}
              isWatchMode={watchModeByFeedId[w.id] ?? false}
              digestCount={digestCount}
              loadingNewer={loadingNewerFeedId === w.id}
              arrowResultMessage={arrowResultByFeedId[w.id] ?? null}
              onArrowClick={async () => {
                setWatchModeByFeedId((prev) => ({ ...prev, [w.id]: true }));
                const refs = columnRefsRef.current;
                const scrollToEnd = () => {
                  requestAnimationFrame(() => requestAnimationFrame(() => refs[w.id]?.scrollToEnd()));
                };
                scrollToEnd();
                if (digestCount != null && digestCount > 0) {
                  setLoadingNewerFeedId(w.id);
                  try {
                    if (w.items.length > 0) {
                      await loadFeedNewerMessages(w.id);
                    } else if (!w.loading) {
                      await loadFeedInitialMessages(w.id, w.filter);
                    }
                    showArrowResult(w.id, 'Завантажено нові повідомлення');
                  } finally {
                    setLoadingNewerFeedId((prev) => (prev === w.id ? null : prev));
                  }
                } else {
                  showArrowResult(w.id, 'Немає нових повідомлень');
                }
              }}
            />
          );
        })}
        {messageFeeds.length < MAX_MESSAGE_FEEDS && (
          <Button
            size="large"
            variant="text"
            className="p-0 self-start shrink-0"
            sx={{
              width: 48,
              minWidth: 48,
              height: 32,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              backgroundColor: 'transparent',
              '&:hover': { backgroundColor: 'background.default' },
              '& .bi': { fontSize: 23 },
            }}
            onClick={createMessageFeed}
            aria-label="Додати колонку"
          >
            <i className="bi bi-plus-square" />
          </Button>
        )}
      </Box>

      <CommentDialog
        open={commentMessageId != null}
        commentText={commentText}
        onCommentTextChange={setCommentText}
        onClose={() => {
          setCommentMessageId(null);
          setCommentFeedId(null);
        }}
        onSave={handleCommentSave}
      />

      <DeleteConfirmDialog
        open={deleteConfirmId != null}
        onClose={() => {
          setDeleteConfirmId(null);
          setDeleteConfirmFeedId(null);
        }}
        onConfirm={handleDeleteConfirm}
      />
    </Box>
  );
}
