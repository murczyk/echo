import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import React from 'react';

import type {
  InboxMessage,
  InboxMessageTag,
  InboxMessagesReq,
  RerDutyState,
  RerDutyFeedFilterState,
  SavedFilterDuty,
  SignalGroupEntry,
  SignalProfileEntry,
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

const PAGE_ID = 'rer-duty-neo';
const LOAD_NEWER_INTERVAL_MS = 5000;

function emptyFilter(): RerDutyFeedFilterState {
  return {
    groupsSelected: null,
    sendersSelected: null,
    deniedSenders: null,
    freqsSelected: null,
    freqsDenied: null,
    postsSelected: null,
    postsDenied: null,
    lastViewedMessageId: null,
  };
}

function buildInboxReq(opts: {
  loadLatest?: boolean;
  beforeIdNoninclusive?: number | null;
  sinceIdNoninclusive?: number | null;
  sinceDateInclusiveMs?: number | null;
  nolimit?: boolean;
  filter: RerDutyFeedFilterState;
}): InboxMessagesReq {
  const f = opts.filter;
  return {
    sinceIdNoninclusive: null,
    beforeIdNoninclusive: opts.beforeIdNoninclusive ?? null,
    sinceDateInclusiveMs: opts.sinceDateInclusiveMs ?? null,
    tillDateInclusiveMs: null,
    onlyShowUnprocessed: null,
    checkedOnly: null,
    selectedGroups: f.groupsSelected ?? null,
    selectedSenders: f.sendersSelected ?? null,
    deniedSenders: f.deniedSenders ?? null,
    selectedFreqs: f.freqsSelected ?? null,
    selectedPosts: f.postsSelected ?? null,
    deniedPosts: f.postsDenied ?? null,
    deniedFreqs: f.freqsDenied ?? null,
    selectedCallsigns: null,
    selectedUnits: null,
    selectedLocations: null,
    nolimit: opts.nolimit ?? null,
    orWithExtendedForm: null,
    loadLatest: opts.loadLatest ?? null,
    returnDuplicates: true,
    orBookmarked: null,
    orImportant: null,
    orWithCoords: null,
    newestFirst: null,
    search: null,
    highlightCallsigns: true,
    highlightKeywords: true,
    highlightSearchres: true,
    highlightSignals: false,
    selectedTags: null,
    selectedAors: null,
    selectedNetworks: null,
    sortBy: 'IMSTimestamp',
    reportTagsOnlyThisUnit: null,
    ignoreImportedCoords: true,
    includePelengLocations: null,
    unitsExactMatchOnly: null,
    calculateFreqPelengsSummary: null,
    skipGroupStats: true,
    filterTagsOption: null,
    pageId: PAGE_ID,
    withoutModelTags: null,
  };
}

function normalizeFeed(raw: Record<string, unknown>): RerDutyFeedFilterState {
  return {
    groupsSelected: (raw.groupsSelected ?? raw.groups_selected ?? null) as string[] | null,
    sendersSelected: (raw.sendersSelected ?? raw.senders_selected ?? null) as string[] | null,
    deniedSenders: (raw.deniedSenders ?? raw.denied_senders ?? null) as string[] | null,
    freqsSelected: (raw.freqsSelected ?? raw.freqs_selected ?? null) as string[] | null,
    freqsDenied: (raw.freqsDenied ?? raw.freqs_denied ?? null) as string[] | null,
    postsSelected: (raw.postsSelected ?? raw.posts_selected ?? null) as string[] | null,
    postsDenied: (raw.postsDenied ?? raw.posts_denied ?? null) as string[] | null,
    lastViewedMessageId: (raw.lastViewedMessageId ?? raw.last_viewed_message_id ?? null) as number | null,
  };
}

function parseStateFromUrl(): RerDutyState {
  const params = new URLSearchParams(window.location.search);
  const stateStr = params.get('state');
  if (!stateStr) return { messageFeeds: [['mf-0', emptyFilter()]] };
  try {
    const raw = JSON.parse(decodeURIComponent(stateStr)) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return { messageFeeds: [['mf-0', emptyFilter()]] };
    // React writes messageFeeds; Elm writes waterfalls
    const wfs = raw.messageFeeds ?? raw.waterfalls ?? raw.waterfall;
    if (!Array.isArray(wfs) || wfs.length === 0) return { messageFeeds: [['mf-0', emptyFilter()]] };
    const list: [string, RerDutyFeedFilterState][] = wfs.map((entry: unknown) => {
      if (Array.isArray(entry) && entry.length >= 2) {
        const id = String(entry[0]);
        const f = normalizeFeed((entry[1] as Record<string, unknown>) ?? {});
        return [id, f];
      }
      return [`mf-${Math.random().toString(36).slice(2, 7)}`, emptyFilter()];
    });
    return { messageFeeds: list };
  } catch {
    return { messageFeeds: [['mf-0', emptyFilter()]] };
  }
}

function pushStateToUrl(state: RerDutyState) {
  const q = new URLSearchParams(window.location.search);
  q.set('state', encodeURIComponent(JSON.stringify(state)));
  const url = `${window.location.pathname}?${q.toString()}`;
  window.history.replaceState({}, '', url);
}

function generateMessageFeedId(): string {
  return 'mf-' + Math.random().toString(36).slice(2, 7);
}

function profileLabel(uuid: string, entry: SignalProfileEntry | null): string {
  if (!entry) return 'Невідомий';
  const parts = [entry.givenName, entry.familyName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'Невідомий';
}

/** Time without seconds (e.g. "14:30:45" -> "14:30") */
function formatTime(time: string | null): string {
  if (time == null || time === '') return '—';
  const parts = time.trim().split(':');
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  return time;
}

/** Date without year (e.g. "16.02.2025" -> "16.02") */
/** Format as day.month (no year), e.g. "16.02". Parses via Date so order of input parts doesn't matter. */
function formatDateNoYear(date: string | null): string {
  if (date == null || date === '') return '—';
  const d = new Date(date.trim());
  if (Number.isNaN(d.getTime())) return date;
  const day = d.getDate();
  const month = d.getMonth() + 1;
  return `${day}.${month.toString().padStart(2, '0')}`;
}

/** Format date as YYYY-MM-DD (matches Elm renderDateF4) */
function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Build /rer-analysis URL with state that focuses on this message (freq + date range + search by messageUid). Uses snake_case keys to match Elm encoder/decoder. */
function buildAnalysisHref(msg: InboxMessage, showMap: boolean): string {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 15);
  const to = new Date(now);
  to.setDate(to.getDate() + 1);
  const stateSnake = {
    date_from_str: toDateStr(from),
    time_from_str: '',
    date_to_str: toDateStr(to),
    time_to_str: '00:00',
    groups_selected: [] as string[],
    senders_selected: [] as string[],
    freqs_selected: msg.freq != null && msg.freq !== '' ? [msg.freq] : ([] as string[]),
    callsigns_selected: [] as string[],
    units_selected: [] as string[],
    locations_selected: [] as string[],
    include_peleng_locations: false,
    or_with_extended_form: false,
    or_bookmarked: false,
    or_important: false,
    or_with_coords: false,
    search: msg.messageUid ?? '',
    tags: [] as number[],
    units_exact_match_only: true,
    adjacent_freqs_range: 0,
    without_model_tags: false,
  };
  const stateEnc = encodeURIComponent(JSON.stringify(stateSnake));
  const base = `/rer-analysis?state=${stateEnc}`;
  return showMap ? `${base}&showMap=true` : base;
}

type MessageItem = [number, InboxMessage];

type MessageFeedState = {
  id: string;
  filter: RerDutyFeedFilterState;
  items: MessageItem[];
  loading: boolean;
  loadingEarlier: boolean;
};

function toQueryState(messageFeeds: MessageFeedState[]): RerDutyState {
  return {
    messageFeeds: messageFeeds.map((f) => [f.id, f.filter]),
  };
}

export function RerDutyNeoPage() {
  const [messageFeeds, setMessageFeeds] = React.useState<MessageFeedState[]>(() => {
    const state = parseStateFromUrl();
    return (state.messageFeeds ?? [['mf-0', emptyFilter()]]).map(([id, filter]) => ({
      id,
      filter,
      items: [],
      loading: true,
      loadingEarlier: false,
    }));
  });
  const [error, setError] = React.useState<string | null>(null);
  const [profiles, setProfiles] = React.useState<Record<string, SignalProfileEntry | null>>({});
  const [freqs, setFreqs] = React.useState<string[]>([]);
  const [groupInfos, setGroupInfos] = React.useState<Record<string, SignalGroupEntry>>({});
  const [groupsList, setGroupsList] = React.useState<string[]>([]);
  const [tagsMap, setTagsMap] = React.useState<Record<number, string>>({});
  const [unfoldFilters, setUnfoldFilters] = React.useState(false);
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
  const loadNewerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshMessageCounterRef = React.useRef<() => Promise<void>>(() => Promise.resolve());

  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (copiedFeedbackTimeoutRef.current) clearTimeout(copiedFeedbackTimeoutRef.current);
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
      const seen = new Set<number>();
      const deduped = rsp.inboxItems.filter(([id]) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      setMessageFeeds((prev) => prev.map((x) => (x.id === feedId ? { ...x, items: deduped, loading: false } : x)));
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
      if (!w || w.items.length === 0) return;
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
            return { ...x, items: [...newItems, ...x.items], loadingEarlier: false };
          })
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setMessageFeeds((prev) => prev.map((x) => (x.id === feedId ? { ...x, loadingEarlier: false } : x)));
      }
    },
    [messageFeeds]
  );

  const loadFeedNewerMessages = React.useCallback(
    async (feedId: string) => {
      const f = messageFeeds.find((x) => x.id === feedId);
      if (!f || f.items.length === 0) return;
      const lastId = f.items[f.items.length - 1][0];
      try {
        const req = buildInboxReq({
          sinceIdNoninclusive: lastId,
          filter: f.filter,
        });
        const rsp = await fetchInboxMessages(req);
        if (rsp.inboxItems.length > 0) {
          setMessageFeeds((prev) =>
            prev.map((x) => {
              if (x.id !== feedId) return x;
              const existingIds = new Set(x.items.map(([id]) => id));
              const newItems = rsp.inboxItems.filter(([id]) => !existingIds.has(id));
              if (newItems.length === 0) return x;
              return { ...x, items: [...x.items, ...newItems] };
            })
          );
        }
      } catch {
        // ignore single failure to keep polling and prev messages
      }
    },
    [messageFeeds]
  );

  const refreshMessageCounter = React.useCallback(async () => {
    const w = messageFeeds[0];
    if (!w) return;
    try {
      const req = buildInboxReq({
        filter: w.filter,
        sinceDateInclusiveMs: Math.floor(Date.now() / 1000) * 1000 - 60 * 60 * 1000,
        nolimit: true,
      });
      const d = await fetchInboxCount(req);
      setDigestCount(d.quantity);
    } catch {
      setDigestCount(null);
    }
  }, [messageFeeds]);
  refreshMessageCounterRef.current = refreshMessageCounter;

  React.useEffect(() => {
    loadFilterOptions();
  }, [loadFilterOptions]);

  React.useEffect(() => {
    refreshMessageCounterRef.current();
  }, []);

  const feedIds = React.useMemo(() => messageFeeds.map((w) => w.id).join(','), [messageFeeds]);
  const feedsNeedingLoadKey = React.useMemo(
    () =>
      messageFeeds
        .filter((w) => w.loading && w.items.length === 0)
        .map((w) => `${w.id}:${JSON.stringify(w.filter)}`)
        .join(';'),
    [messageFeeds]
  );
  React.useEffect(() => {
    messageFeeds.forEach((w) => {
      if (w.loading && w.items.length === 0) loadFeedInitialMessages(w.id, w.filter);
    });
  }, [feedIds, feedsNeedingLoadKey, loadFeedInitialMessages]);

  // Poll for newer messages and message count every LOAD_NEWER_INTERVAL_MS
  React.useEffect(() => {
    loadNewerRef.current = setInterval(() => {
      messageFeeds.forEach((w) => loadFeedNewerMessages(w.id));
      refreshMessageCounter();
    }, LOAD_NEWER_INTERVAL_MS);
    return () => {
      if (loadNewerRef.current) clearInterval(loadNewerRef.current);
    };
  }, [messageFeeds, loadFeedNewerMessages, refreshMessageCounter]);

  const applyFilter = React.useCallback((feedId: string, f: RerDutyFeedFilterState) => {
    setMessageFeeds((prev) => {
      const next = prev.map((w) => (w.id === feedId ? { ...w, filter: f, items: [], loading: true } : w));
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
    };
    setMessageFeeds((prev) => {
      if (prev.some((w) => w.id === id)) return prev;
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
    [messageFeeds.length]
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
                  msgId === id ? [msgId, { ...msg, bookmarked: !currentlyBookmarked }] : [msgId, msg]
                ),
              }
            : w
        )
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
                  msgId === id ? [msgId, { ...msg, important: !currentlyImportant }] : [msgId, msg]
                ),
              }
            : w
        )
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
          w.id === deleteConfirmFeedId ? { ...w, items: w.items.filter(([id]) => id !== deleteConfirmId) } : w
        )
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
                  id === commentMessageId ? [id, { ...m, extendedForm: trimmed }] : [id, m]
                ),
              }
            : w
        )
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
    [tagsMap]
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
            : x
        )
      );
      try {
        if (hasTag) await inboxMessageTagsRm({ messageId: msgId, tagId });
        else await inboxMessageTagsAdd({ messageId: msgId, tagId });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setMessageFeeds((prev) =>
          prev.map((x) =>
            x.id === feedId ? { ...x, items: x.items.map(([id, m]) => (id === msgId ? [id, pair[1]] : [id, m])) } : x
          )
        );
      }
    },
    [messageFeeds]
  );

  return (
    <Box className="flex flex-col h-full" sx={{ minHeight: '60vh' }}>
      <Box display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
        {digestCount != null && digestCount > 0 && (
          <Chip size="small" color="primary" label={`Нових: ${digestCount}`} />
        )}
      </Box>

      {error && (
        <Paper elevation={0} sx={{ p: 1, mb: 1, bgcolor: 'error.light', color: 'error.contrastText' }}>
          {error}
        </Paper>
      )}

      <Paper variant="outlined" sx={{ p: 1, mb: 1 }}>
        <Button
          size="small"
          startIcon={unfoldFilters ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          onClick={() => setUnfoldFilters((u) => !u)}
        >
          Фільтри
        </Button>
      </Paper>

      <Box display="flex" flexWrap="nowrap" gap={2} sx={{ overflowX: 'auto', minHeight: 0 }}>
        {messageFeeds.map((w, idx) => {
          const filterStable = {
            groupsSelected: w.filter.groupsSelected ?? [],
            sendersSelected: w.filter.sendersSelected ?? [],
            deniedSenders: w.filter.deniedSenders ?? [],
            freqsSelected: w.filter.freqsSelected ?? [],
            freqsDenied: w.filter.freqsDenied ?? [],
          };
          return (
            <Box
              key={w.id}
              sx={{
                flex: '1 1 0',
                minWidth: 320,
                maxWidth: messageFeeds.length === 1 ? '100%' : '50%',
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
              }}
            >
              {unfoldFilters && (
                <Paper variant="outlined" sx={{ p: 1.5 }}>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    {/* Групи */}
                    <Box>
                      <Typography variant="subtitle2" sx={{ mb: 0.5, fontWeight: 600 }}>
                        Групи
                      </Typography>
                      <Box display="flex" flexWrap="wrap" gap={0.5} alignItems="center">
                        <Chip
                          size="small"
                          label="всі"
                          color={filterStable.groupsSelected.length === 0 ? 'primary' : 'default'}
                          onClick={() => selectAllGroups(w.id)}
                        />
                        {groupsList.map((key) => {
                          const name = groupInfos[key]?.name ?? key;
                          const selected = filterStable.groupsSelected.includes(key);
                          return (
                            <Chip
                              key={key}
                              size="small"
                              label={name}
                              color={selected ? 'primary' : 'default'}
                              onClick={() => toggleGroup(w.id, key)}
                            />
                          );
                        })}
                      </Box>
                    </Box>

                    {/* Відправник */}
                    <Box>
                      <Typography variant="subtitle2" sx={{ mb: 0.5, fontWeight: 600 }}>
                        Відправник
                      </Typography>
                      <Box display="flex" flexWrap="wrap" gap={1} alignItems="center">
                        <Typography variant="caption" sx={{ minWidth: 56, textAlign: 'right' }}>
                          лише
                        </Typography>
                        <FormControl size="small" sx={{ minWidth: 180, flex: 1 }}>
                          <Select
                            multiple
                            displayEmpty
                            value={filterStable.sendersSelected}
                            onChange={(e) => {
                              const v = e.target.value as string[];
                              applyFilter(w.id, { ...w.filter, sendersSelected: v.length ? v : null });
                            }}
                            renderValue={(sel) =>
                              (sel as string[]).length === 0
                                ? 'всі'
                                : (sel as string[]).map((id) => profileLabel(id, profiles[id] ?? null)).join(', ')
                            }
                          >
                            {senderOptions.map((opt) => (
                              <MenuItem key={opt.id} value={opt.id}>
                                {opt.label}
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                      </Box>
                      <Box display="flex" flexWrap="wrap" gap={1} alignItems="center" sx={{ mt: 0.5 }}>
                        <Typography variant="caption" sx={{ minWidth: 56, textAlign: 'right' }}>
                          окрім
                        </Typography>
                        <FormControl size="small" sx={{ minWidth: 180, flex: 1 }}>
                          <Select
                            multiple
                            displayEmpty
                            value={filterStable.deniedSenders}
                            onChange={(e) => {
                              const v = e.target.value as string[];
                              applyFilter(w.id, { ...w.filter, deniedSenders: v.length ? v : null });
                            }}
                            renderValue={(sel) =>
                              (sel as string[]).length === 0
                                ? 'ніхто'
                                : (sel as string[]).map((id) => profileLabel(id, profiles[id] ?? null)).join(', ')
                            }
                          >
                            {senderOptions.map((opt) => (
                              <MenuItem key={opt.id} value={opt.id}>
                                {opt.label}
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                      </Box>
                    </Box>

                    {/* Частота: лише / окрім + оновити */}
                    <Box>
                      <Box display="flex" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                          Частота
                        </Typography>
                        <Button
                          size="small"
                          variant="outlined"
                          disabled={reloadFreqsLoading}
                          onClick={reloadLatestFrequencies}
                          startIcon={
                            reloadFreqsLoading ? (
                              <CircularProgress size={14} />
                            ) : (
                              <i className="bi bi-arrow-clockwise" />
                            )
                          }
                        >
                          {reloadFreqsLoading ? '…' : 'Оновити список'}
                        </Button>
                      </Box>
                      <Box display="flex" flexWrap="wrap" gap={1} alignItems="center">
                        <Typography variant="caption" sx={{ minWidth: 56, textAlign: 'right' }}>
                          лише
                        </Typography>
                        <FormControl size="small" sx={{ minWidth: 160, flex: 1 }}>
                          <Select
                            multiple
                            displayEmpty
                            value={filterStable.freqsSelected}
                            onChange={(e) => {
                              const v = e.target.value as string[];
                              applyFilter(w.id, { ...w.filter, freqsSelected: v.length ? v : null });
                            }}
                            renderValue={(sel) =>
                              (sel as string[]).length === 0 ? 'всі' : (sel as string[]).join(', ')
                            }
                          >
                            {freqs.map((f) => (
                              <MenuItem key={f} value={f}>
                                {f}
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                      </Box>
                      <Box display="flex" flexWrap="wrap" gap={1} alignItems="center" sx={{ mt: 0.5 }}>
                        <Typography variant="caption" sx={{ minWidth: 56, textAlign: 'right' }}>
                          окрім
                        </Typography>
                        <FormControl size="small" sx={{ minWidth: 160, flex: 1 }}>
                          <Select
                            multiple
                            displayEmpty
                            value={filterStable.freqsDenied}
                            onChange={(e) => {
                              const v = e.target.value as string[];
                              applyFilter(w.id, { ...w.filter, freqsDenied: v.length ? v : null });
                            }}
                            renderValue={(sel) =>
                              (sel as string[]).length === 0 ? 'ніяка' : (sel as string[]).join(', ')
                            }
                          >
                            {freqs.map((f) => (
                              <MenuItem key={f} value={f}>
                                {f}
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                      </Box>
                    </Box>

                    {/* Збережені фільтри */}
                    <Box>
                      <Typography variant="subtitle2" sx={{ mb: 0.5, fontWeight: 600 }}>
                        Збережені фільтри
                      </Typography>
                      <Box display="flex" flexWrap="wrap" gap={1} alignItems="center">
                        <FormControl size="small" sx={{ minWidth: 180 }}>
                          <InputLabel>вибрати фільтр</InputLabel>
                          <Select
                            label="вибрати фільтр"
                            value={selectedSavedId ?? ''}
                            onChange={(e) => {
                              const id = e.target.value as number | '';
                              setSelectedSavedId(id === '' ? null : id);
                              if (id !== '') {
                                const saved = savedFilters.find((s) => s.id === id);
                                if (saved) handleApplySavedFilter(w.id, saved);
                              }
                            }}
                          >
                            <MenuItem value="">—</MenuItem>
                            {savedFilters.map((s) => (
                              <MenuItem key={s.id} value={s.id}>
                                {s.name}
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                        <TextField
                          size="small"
                          placeholder="назва"
                          value={saveFilterName}
                          onChange={(e) => setSaveFilterName(e.target.value)}
                          sx={{ width: 140 }}
                        />
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() => handleSaveFilter(w.id)}
                          disabled={!saveFilterName.trim()}
                        >
                          додати
                        </Button>
                        {selectedSavedId != null && (
                          <Button
                            size="small"
                            color="error"
                            variant="outlined"
                            onClick={() => {
                              const s = savedFilters.find((x) => x.id === selectedSavedId);
                              if (s) handleDeleteSavedFilter(s.id);
                            }}
                          >
                            <i className="bi bi-trash" />
                          </Button>
                        )}
                      </Box>
                    </Box>
                  </Box>
                </Paper>
              )}

              <Box sx={{ mb: 0.5 }} display="flex" alignItems="center" justifyContent="space-between">
                <Button
                  size="small"
                  variant="outlined"
                  disabled={w.loadingEarlier || w.items.length === 0}
                  onClick={() => loadFeedEarlierMessages(w.id)}
                  title="Завантажити старіші"
                >
                  {w.loadingEarlier ? <CircularProgress size={16} /> : 'Завантажити старіші'}
                </Button>
                <Typography
                  variant="caption"
                  sx={{ ml: 1 }}
                  component="span"
                  title="Кількість повідомлень у цій колонці"
                >
                  Показано: {w.items.length}
                </Typography>

                <Box gap={0.5}>
                  {messageFeeds.length > 1 && (
                    <Button
                      size="small"
                      color="error"
                      aria-label="Закрити колонку"
                      onClick={() => removeMessageFeed(w.id)}
                      sx={{ minWidth: 32 }}
                    >
                      <i className="bi bi-x-lg" />
                    </Button>
                  )}
                </Box>
              </Box>

              {w.loading ? (
                <Box display="flex" justifyContent="center" alignItems="center" py={4}>
                  <CircularProgress />
                </Box>
              ) : (
                <Paper
                  variant="outlined"
                  sx={{
                    flex: 1,
                    overflow: 'auto',
                    maxHeight: '65vh',
                    p: 0,
                  }}
                >
                  {w.items.length === 0 ? (
                    <Typography color="text.secondary" sx={{ p: 2 }}>
                      Немає повідомлень
                    </Typography>
                  ) : (
                    <Box component="ul" sx={{ m: 0, px: 0, listStyle: 'none' }} className="rer-duty pt-2">
                      {w.items.map(([id, msg]) => {
                        const senderName =
                          msg.sender != null ? profileLabel(msg.sender, profiles[msg.sender] ?? null) : null;
                        const groupName = msg.groupMasterKey != null ? groupInfos[msg.groupMasterKey]?.name : null;
                        return (
                          <Box
                            component="li"
                            key={id}
                            sx={{ listStyle: 'none', display: 'flex', px: 1 }}
                            className="rer-duty-message flex px-2"
                          >
                            {/* Left column: date/time, actions, group, sender, freq */}
                            <div
                              className="min-w-[120px] mr-2 basis-1/4 mb-[8px]"
                              style={{
                                minWidth: 120,
                                marginRight: 8,
                                flex: '0 0 25%',
                                marginBottom: 8,
                              }}
                            >
                              <div
                                className="flex justify-around w-full text-center mb-1"
                                style={{
                                  fontSize: '.75rem',
                                  display: 'flex',
                                  justifyContent: 'space-around',
                                  width: '100%',
                                  textAlign: 'center',
                                  marginBottom: 4,
                                }}
                              >
                                <span>
                                  <i className="bi bi-clock mr-1 text-icons" style={{ marginRight: 4 }} />
                                  {formatTime(msg.time)}
                                </span>
                                {msg.date != null && (
                                  <span>
                                    <i className="bi bi-calendar mr-1 text-icons" style={{ marginRight: 4 }} />
                                    {formatDateNoYear(msg.date)}
                                  </span>
                                )}
                              </div>
                              <div
                                className="flex justify-around mb-2"
                                style={{ display: 'flex', justifyContent: 'space-around', marginBottom: 8 }}
                              >
                                <span
                                  role="button"
                                  tabIndex={0}
                                  title={msg.bookmarked ? 'Прибрати закладку' : 'Додати в закладки'}
                                  className="me-1 cursor-pointer"
                                  style={{ fontSize: '1rem' }}
                                  onClick={() => handleMessageBookmark(w.id, id, msg.bookmarked)}
                                  onKeyDown={(e) =>
                                    e.key === 'Enter' && handleMessageBookmark(w.id, id, msg.bookmarked)
                                  }
                                >
                                  <i
                                    className={
                                      msg.bookmarked
                                        ? 'bi bi-bookmark-fill text-action'
                                        : 'bi bi-bookmark text-action cursor-pointer'
                                    }
                                  />
                                </span>
                                <span
                                  role="button"
                                  tabIndex={0}
                                  title={msg.important ? 'Прибрати важливе' : 'Помітити як важливе'}
                                  className="me-1 cursor-pointer"
                                  style={{ fontSize: '1rem' }}
                                  onClick={() => handleMessageImportant(w.id, id, msg.important)}
                                  onKeyDown={(e) =>
                                    e.key === 'Enter' && handleMessageImportant(w.id, id, msg.important)
                                  }
                                >
                                  <i
                                    className={
                                      msg.important
                                        ? 'bi bi-exclamation-triangle-fill text-action'
                                        : 'bi bi-exclamation-triangle text-action'
                                    }
                                  />
                                </span>
                                <span
                                  role="button"
                                  tabIndex={0}
                                  title="Копіювати"
                                  className="cursor-pointer text-normal"
                                  onClick={() => handleMessageCopy(msg.text || '', `text-${id}`)}
                                  onKeyDown={(e) =>
                                    e.key === 'Enter' && handleMessageCopy(msg.text || '', `text-${id}`)
                                  }
                                >
                                  <i
                                    className={
                                      copiedFeedbackId === `text-${id}`
                                        ? 'bi bi-clipboard-check-fill text-action cursor-pointer'
                                        : 'bi bi-clipboard text-action cursor-pointer'
                                    }
                                  />
                                </span>
                                {/* Comment (as in Elm): pencil opens comment dialog; delete hidden for now */}
                                <span
                                  role="button"
                                  tabIndex={0}
                                  title="редагувати коментар"
                                  className="me-1 cursor-pointer"
                                  style={{ fontSize: '1rem' }}
                                  onClick={() => openCommentDialog(id, w.id, msg.extendedForm ?? null)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') openCommentDialog(id, w.id, msg.extendedForm ?? null);
                                  }}
                                >
                                  <i className="bi bi-chat-square text-action" />
                                </span>
                                {/* Delete hidden for now
                                <span ... onClick={() => { setDeleteConfirmId(id); setDeleteConfirmFeedId(w.id); }}>
                                  <i className="bi bi-trash3 text-action" />
                                </span>
                                */}
                              </div>
                              {groupName != null && (
                                <div className="bg-card rounded-sm text-sm">
                                  <div className="flex items-center px-2 py-1 border-b-2 border-border">
                                    <i className="bi bi-signal mr-1 text-icons leading-none" title="Група" />
                                    <span className="text-xs">{groupName}</span>
                                  </div>
                                </div>
                              )}
                              {senderName != null && (
                                <div className="py-1 px-2 flex items-center bg-card rounded-sm text-sm mb-2">
                                  <i className="bi bi-person-circle mr-1 text-icons leading-none" title="Відправник" />
                                  <span className="text-xs">{senderName}</span>
                                </div>
                              )}
                              {msg.freq != null && (
                                <div className="bg-card text-sm mb-2 rounded-sm">
                                  <div className="flex justify-between items-center py-1 px-2 border-b-2 border-border">
                                    <div className="flex items-center">
                                      <i className="bi bi-broadcast mr-1 text-icons leading-none" title="Частота" />
                                      <span className="font-semibold text-xs">{msg.freq}</span>
                                    </div>
                                    <span
                                      role="button"
                                      tabIndex={0}
                                      title="Копіювати частоту"
                                      className="cursor-pointer text-action text-sm"
                                      onClick={() => handleMessageCopy(msg.freq ?? '', `freq-${id}`)}
                                      onKeyDown={(e) =>
                                        e.key === 'Enter' && handleMessageCopy(msg.freq ?? '', `freq-${id}`)
                                      }
                                    >
                                      <i
                                        className={
                                          copiedFeedbackId === `freq-${id}`
                                            ? 'bi bi-clipboard-check-fill cursor-pointer'
                                            : 'bi bi-clipboard cursor-pointer'
                                        }
                                      />
                                    </span>
                                  </div>
                                  <div className="flex justify-between items-center py-1 px-2 border-b-2 border-border">
                                    <div className="flex items-center">
                                      <i className="bi bi-bar-chart-line mr-1 text-icons leading-none" title="Аналіз" />
                                      <span className="text-xs">Аналіз</span>
                                    </div>
                                    <a
                                      href={buildAnalysisHref(msg, false)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      title="Відкрити повідомлення в Аналізі"
                                      className="text-action text-sm text-inherit"
                                    >
                                      <i className="bi bi-box-arrow-up-right cursor-pointer" />
                                    </a>
                                  </div>
                                  <a
                                    href={buildAnalysisHref(msg, true)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="Відкрити повідомлення на карті в аналізі"
                                    className="text-action text-sm text-inherit"
                                  >
                                    <div className="flex justify-between py-1 px-2 w-full">
                                      <div>
                                        <i
                                          className="bi bi-map text-icons leading-none mr-2 text-sm"
                                          title="Відкрити повідомлення на карті"
                                        />
                                        <span className="text-xs">Карта</span>
                                      </div>
                                      <i className="bi bi-box-arrow-up-right cursor-pointer leading-none" />
                                    </div>
                                  </a>
                                </div>
                              )}

                              {msg.extendedForm != null && msg.extendedForm.trim() !== '' && (
                                <div className="bg-card text-sm mb-2 rounded-sm">
                                  <div className="flex justify-between items-center py-1 px-2 border-border">
                                    <div className="flex items-center">
                                      <i className="bi bi-chat-text mr-1 text-icons leading-none" title="Коментар" />
                                      <span className="text-xs">Коментар</span>
                                    </div>
                                  </div>
                                  <div className="flex justify-between items-center py-1 pl-6 pr-2 border-b-2 border-border">
                                    <div className="flex items-center">
                                      <span className="font-semibold text-xs">{msg.extendedForm}</span>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                            {/* Right column: message card */}
                            <div className="mb-2 rounded-3 px-2 pt-2 pb-2 basis-3/4 flex-1 message-div bg-card relative min-w-0 break-words">
                              {/* Еталонна прив'язка Мережі + Локація */}
                              <div className="flex justify-start items-start flex-wrap py-1 border-b-2 border-border gap-2">
                                <div className="font-semibold inline-flex gap-1">
                                  <i className="bi bi-people text-icons" title="Еталонна прив'язка" />
                                  {(msg.networkIds ?? []).length > 0 ? (
                                    (msg.networkIds ?? []).map((networkId) => (
                                      <a
                                        href={`/rer-networks/${networkId}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="opacity-70 hover:opacity-100 transition-opacity cursor-pointer inline-flex items-center gap-1 font-medium group"
                                        title="Відкрити мережу в новій вкладці"
                                        key={networkId}
                                      >
                                        Мережа {networkId}
                                        <i className="bi bi-box-arrow-up-right text-sm" />
                                      </a>
                                    ))
                                  ) : (
                                    <span>Не встановлена</span>
                                  )}
                                </div>
                                <div className="font-semibold break-words min-w-0">
                                  <i className="bi bi-geo text-icons" title="Локація" />{' '}
                                  {msg.location ?? 'Не встановлена'}
                                </div>
                              </div>
                              <div className="whitespace-pre-wrap break-words mt-1 mb-2">{msg.text || '—'}</div>
                              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                                {tagIdsList.map((tagId) => {
                                  const label = tagsMap[tagId] ?? `#${tagId}`;
                                  const isSet = messageHasTag(msg, tagId);
                                  const contribs = (msg.inboxTags ?? []).filter((t) => t.tagId === tagId);
                                  const humans = contribs
                                    .filter((t) => !t.model)
                                    .map((t) => t.login)
                                    .filter(Boolean) as string[];
                                  const bots = contribs
                                    .filter((t) => t.model)
                                    .map((t) => `${t.model} (${Math.round((t.confidence ?? 0) * 100)}%)`);
                                  const tip =
                                    isSet && (humans.length > 0 || bots.length > 0)
                                      ? [
                                          ...(humans.length > 0 ? [`Користувачі: ${humans.join(', ')}`] : []),
                                          ...(bots.length > 0 ? [`Боти: ${bots.join(', ')}`] : []),
                                        ].join('\n')
                                      : isSet
                                      ? 'Натисніть, щоб зняти тег'
                                      : 'Натисніть, щоб додати тег';
                                  return (
                                    <Tooltip key={tagId} title={tip} placement="top">
                                      <Chip
                                        size="small"
                                        label={label}
                                        onClick={() => handleToggleTag(w.id, id, tagId)}
                                        color={isSet ? 'primary' : 'default'}
                                        variant={isSet ? 'filled' : 'outlined'}
                                        sx={{
                                          fontSize: '0.7rem',
                                          height: 20,
                                          cursor: 'pointer',
                                          '& .MuiChip-label': { px: 0.75 },
                                        }}
                                      />
                                    </Tooltip>
                                  );
                                })}
                              </Box>
                            </div>
                          </Box>
                        );
                      })}
                    </Box>
                  )}
                </Paper>
              )}
            </Box>
          );
        })}
        <Button
          size="large"
          className="p-0"
          startIcon={<i className="bi bi-plus-square" />}
          onClick={createMessageFeed}
          sx={{ alignSelf: 'flex-start', flexShrink: 0 }}
        ></Button>
      </Box>

      <Dialog
        open={commentMessageId != null}
        onClose={() => {
          setCommentMessageId(null);
          setCommentFeedId(null);
        }}
      >
        <DialogTitle>Коментар</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={4}
            placeholder="Введіть коментар..."
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            sx={{ mt: 1, minWidth: 300 }}
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setCommentMessageId(null);
              setCommentFeedId(null);
            }}
          >
            Відміна
          </Button>
          <Button variant="contained" onClick={handleCommentSave}>
            Зберегти
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={deleteConfirmId != null}
        onClose={() => {
          setDeleteConfirmId(null);
          setDeleteConfirmFeedId(null);
        }}
      >
        <DialogTitle>Видалити повідомлення?</DialogTitle>
        <DialogContent>Цю дію не можна скасувати.</DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setDeleteConfirmId(null);
              setDeleteConfirmFeedId(null);
            }}
          >
            Скасувати
          </Button>
          <Button color="error" variant="contained" onClick={handleDeleteConfirm}>
            Видалити
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
