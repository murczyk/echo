import type {
  InboxMessage,
  InboxMessagesReq,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SignalGroupEntry,
  SignalProfileEntry,
} from '../../../../Bindings';
import type { Network, Unit } from '../../../../Bindings';

export type RerDutyState = {
  messageFeeds: [string, RerDutyFeedFilterState][];
};

/** Elm-style network display text: "р/м " + name + " " + unit names + optional " (LOCATION)". */
export function createMasterUnitText(network: Network, unitsMap: Record<number, Unit>): string {
  const unitIds = network.unitIds ?? [];
  const unitNames = unitIds.map((id) => {
    const u = unitsMap[id];
    return u?.name ?? `Невідомий підрозділ (id=${id})`;
  });
  const locationPart =
    network.location && network.location.trim() !== ''
      ? ` (${network.location.trim().toUpperCase()})`
      : '';
  return `р/м ${network.name} ${unitNames.join(', ')}${locationPart}`;
}

export const PAGE_ID = 'rer-duty-neo';
/** Poll get-inbox-count every 2s; load newer (get-inbox) only when count > 0. */
export const INBOX_COUNT_POLL_INTERVAL_MS = 2000;

export function emptyFilter(): RerDutyFeedFilterState {
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

export function buildInboxReq(opts: {
  loadLatest?: boolean;
  beforeIdNoninclusive?: number | null;
  sinceIdNoninclusive?: number | null;
  sinceDateInclusiveMs?: number | null;
  nolimit?: boolean;
  filter: RerDutyFeedFilterState;
}): InboxMessagesReq {
  const f = opts.filter;
  return {
    sinceIdNoninclusive: opts.sinceIdNoninclusive ?? null,
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
    highlightPoints: true,
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

export function normalizeFeed(raw: Record<string, unknown>): RerDutyFeedFilterState {
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

export function parseStateFromUrl(): RerDutyState {
  const params = new URLSearchParams(window.location.search);
  const stateStr = params.get('state');
  if (!stateStr) return { messageFeeds: [['mf-0', emptyFilter()]] };
  try {
    const raw = JSON.parse(decodeURIComponent(stateStr)) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return { messageFeeds: [['mf-0', emptyFilter()]] };
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

export function pushStateToUrl(state: RerDutyState) {
  const q = new URLSearchParams(window.location.search);
  q.set('state', encodeURIComponent(JSON.stringify(state)));
  const url = `${window.location.pathname}?${q.toString()}`;
  window.history.replaceState({}, '', url);
}

export function generateMessageFeedId(): string {
  return 'mf-' + Math.random().toString(36).slice(2, 7);
}

export function profileLabel(uuid: string, entry: SignalProfileEntry | null): string {
  if (!entry) return 'Невідомий';
  const parts = [entry.givenName, entry.familyName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : 'Невідомий';
}

export function formatTime(time: string | null): string {
  if (time == null || time === '') return '—';
  const parts = time.trim().split(':');
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  return time;
}

export function formatDateNoYear(date: string | null): string {
  if (date == null || date === '') return '—';
  const d = new Date(date.trim());
  if (Number.isNaN(d.getTime())) return date;
  const day = d.getDate();
  const month = d.getMonth() + 1;
  return `${day}.${month.toString().padStart(2, '0')}`;
}

/** Relative time from event to now, same logic */
export function messageRenderDistance(eventMs: number, nowMs: number): string {
  const secsAgo = Math.floor((nowMs - eventMs) / 1000);
  if (secsAgo < 5) return 'щойно';
  if (secsAgo < 60) return `${secsAgo} сек`;
  const minsAgo = Math.floor(secsAgo / 60);
  if (minsAgo < 60) return `${minsAgo} хв`;
  const hoursAgo = Math.floor(minsAgo / 60);
  const eventDate = new Date(eventMs);
  const nowDate = new Date(nowMs);
  const sameDay =
    eventDate.getFullYear() === nowDate.getFullYear() &&
    eventDate.getMonth() === nowDate.getMonth() &&
    eventDate.getDate() === nowDate.getDate();
  if (sameDay || hoursAgo < 24) return `${hoursAgo} год`;
  const daysAgo = Math.floor((nowMs - eventMs) / (24 * 60 * 60 * 1000));
  return `${daysAgo} дн`;
}

export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function buildAnalysisHref(msg: InboxMessage, showMap: boolean): string {
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

export type MessageItem = [number, InboxMessage];

/** Sort message items by time ascending (oldest first), like Elm duty. Uses timestamp then id as tiebreaker. */
export function sortMessageItemsByTime(items: MessageItem[]): MessageItem[] {
  return [...items].sort(([idA, a], [idB, b]) => {
    const tsA = a.timestamp ?? 0;
    const tsB = b.timestamp ?? 0;
    if (tsA !== tsB) return tsA - tsB;
    return idA - idB;
  });
}

/** Deduplicate by message id (first occurrence wins). Prevents duplicate key warnings when API or merge returns same id twice. */
export function dedupeMessageItems(items: MessageItem[]): MessageItem[] {
  const seen = new Set<number>();
  return items.filter(([id]) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Initial firstItemIndex for Virtuoso; decreased when we prepend so scroll position is preserved. */
export const VIRTUOSO_FIRST_ITEM_INDEX_INITIAL = 10_000;

export type MessageFeedState = {
  id: string;
  filter: RerDutyFeedFilterState;
  items: MessageItem[];
  loading: boolean;
  loadingOlder: boolean;
  /** True after "load older" returned 0 new items — nothing older to fetch */
  hasReachedStart: boolean;
  /** Virtuoso firstItemIndex: start at VIRTUOSO_FIRST_ITEM_INDEX_INITIAL, decrease by N when prepending N items (infinite scroll). */
  firstItemIndex: number;
  /** Reference time (ms) for relative "time ago" in message cards; set when feed items are loaded. */
  referenceTimeMs: number | null;
  /** Message IDs that have been "read" (entered viewport). Unread count = items not in this set. */
  readIds: Set<number>;
  unreadCount: number;
  /** When true, the left column (freq, date/time, buttons) is hidden for all messages in this feed. */
  leftSideCollapsed: boolean;
};

export function toQueryState(messageFeeds: MessageFeedState[]): RerDutyState {
  return {
    messageFeeds: messageFeeds.map((f) => [f.id, f.filter]),
  };
}
