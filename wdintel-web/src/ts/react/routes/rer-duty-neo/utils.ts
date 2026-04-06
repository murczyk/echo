import type {
  InboxMessage,
  InboxMessagesReq,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
} from '../../../../Bindings';
import type { Network, Unit } from '../../../../Bindings';
import { emptyArrToNull } from '../../utils/misc';

export type RerDutyState = {
  messageFeeds: [string, RerDutyFeedFilterState][];
};

/** Network display text: "р/м " + name + " " + unit names + optional " (LOCATION)". */
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
/** LocalStorage key for message card layout preference (dividers | fluid). */
export const MESSAGE_CARD_LAYOUT_STORAGE_KEY = 'rer-duty-neo-message-card-layout';
/** Poll get-inbox-count every 2s; load newer (get-inbox) only when count > 0. */
export const INBOX_COUNT_POLL_INTERVAL_MS = 1000;

export type MessageCardLayoutVariant = 'dividers' | 'fluid';

export function getStoredMessageCardLayout(): MessageCardLayoutVariant {
  if (typeof window === 'undefined') return 'dividers';
  const raw = window.localStorage.getItem(MESSAGE_CARD_LAYOUT_STORAGE_KEY);
  return raw === 'fluid' ? 'fluid' : 'dividers';
}

export function setStoredMessageCardLayout(v: MessageCardLayoutVariant): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(MESSAGE_CARD_LAYOUT_STORAGE_KEY, v);
}

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

/** Distinguishes null/undefined from []. Backend treats None (no filter) vs Some([]) (empty filter → no rows) differently. */
function optArrEqual(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** True when both filters are equivalent for request purposes (no need to refetch). */
export function filtersEqual(a: RerDutyFeedFilterState, b: RerDutyFeedFilterState): boolean {
  return (
    optArrEqual(a.groupsSelected, b.groupsSelected) &&
    optArrEqual(a.sendersSelected, b.sendersSelected) &&
    optArrEqual(a.deniedSenders, b.deniedSenders) &&
    optArrEqual(a.freqsSelected, b.freqsSelected) &&
    optArrEqual(a.freqsDenied, b.freqsDenied) &&
    optArrEqual(a.postsSelected, b.postsSelected) &&
    optArrEqual(a.postsDenied, b.postsDenied)
  );
}

/** Options for "автоматично додавати частоти в діапазоні" (MHz). */
export const ADJACENT_FREQS_RANGE_OPTIONS = [0, 0.0005, 0.002, 0.005] as const;

function isInRange(selectedS: string, freqS: string, range: number): boolean {
  const selected = parseFloat(selectedS);
  const freq = parseFloat(freqS);
  if (Number.isNaN(selected) || Number.isNaN(freq)) return false;
  return freq >= selected - range && freq <= selected + range;
}

/** Expand selected freqs with adjacent within range (MHz). */
export function findAllAdjacentFreqs(
  allFrequencies: string[],
  selectedFrequencies: string[],
  range: number
): string[] {
  if (range <= 0) return [];
  return allFrequencies.filter(
    (freq) =>
      !selectedFrequencies.includes(freq) &&
      selectedFrequencies.some((selected) => isInRange(selected, freq, range))
  );
}

export function buildInboxReq(opts: {
  loadLatest?: boolean;
  beforeIdNoninclusive?: number | null;
  sinceIdNoninclusive?: number | null;
  sinceDateInclusiveMs?: number | null;
  tillDateInclusiveMs?: number | null;
  nolimit?: boolean;
  filter: RerDutyFeedFilterState;
  /** Expanded freqs (selected + adjacent); if not set, filter.freqsSelected is used. */
  expandedFreqsSelected?: string[] | null;
  expandedFreqsDenied?: string[] | null;
  highlightSignals?: boolean | null;
  reportTagsOnlyThisUnit?: boolean | null;
}): InboxMessagesReq {
  const f = opts.filter;
  // send empty arrays as null (backend treats null/undefined vs [] differently)
  const selectedFreqs = emptyArrToNull(opts.expandedFreqsSelected ?? f.freqsSelected ?? null);
  const deniedFreqs = emptyArrToNull(opts.expandedFreqsDenied ?? f.freqsDenied ?? null);
  return {
    sinceIdNoninclusive: opts.sinceIdNoninclusive ?? null,
    beforeIdNoninclusive: opts.beforeIdNoninclusive ?? null,
    sinceDateInclusiveMs: opts.sinceDateInclusiveMs ?? null,
    tillDateInclusiveMs: opts.tillDateInclusiveMs ?? null,
    onlyShowUnprocessed: null,
    checkedOnly: null,
    selectedGroups: emptyArrToNull(f.groupsSelected),
    selectedSenders: emptyArrToNull(f.sendersSelected),
    deniedSenders: emptyArrToNull(f.deniedSenders),
    selectedFreqs,
    selectedPosts: emptyArrToNull(f.postsSelected),
    deniedPosts: emptyArrToNull(f.postsDenied),
    deniedFreqs,
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
    highlightSignals: opts.highlightSignals ?? false,
    highlightPoints: true,
    selectedTags: null,
    selectedAors: null,
    selectedNetworks: null,
    withoutNetwork: null,
    metadataCc: null,
    metadataSender: null,
    metadataReceiver: null,
    metadataHash: null,
    onlyWithMetadata: null,
    withoutMetadata: null,
    sortBy: 'IMSTimestamp',
    reportTagsOnlyThisUnit: opts.reportTagsOnlyThisUnit ?? null,
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
    groupsSelected: emptyArrToNull((raw.groupsSelected ?? raw.groups_selected ?? null) as string[] | null),
    sendersSelected: emptyArrToNull((raw.sendersSelected ?? raw.senders_selected ?? null) as string[] | null),
    deniedSenders: emptyArrToNull((raw.deniedSenders ?? raw.denied_senders ?? null) as string[] | null),
    freqsSelected: emptyArrToNull((raw.freqsSelected ?? raw.freqs_selected ?? null) as string[] | null),
    freqsDenied: emptyArrToNull((raw.freqsDenied ?? raw.freqs_denied ?? null) as string[] | null),
    postsSelected: emptyArrToNull((raw.postsSelected ?? raw.posts_selected ?? null) as string[] | null),
    postsDenied: emptyArrToNull((raw.postsDenied ?? raw.posts_denied ?? null) as string[] | null),
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

export function buildSenderOptions(
  profiles: Record<string, SignalProfileEntry | null>,
  messageFeeds: MessageFeedState[],
): Array<{ id: string; label: string }> {
  const senderIds = new Set(Object.keys(profiles));

  messageFeeds.forEach((feed) => {
    feed.items.forEach(([, message]) => {
      const sender = message.sender?.trim();
      if (sender) senderIds.add(sender);
    });
    (feed.filter.sendersSelected ?? []).forEach((sender) => {
      const senderTrimmed = sender.trim();
      if (senderTrimmed) senderIds.add(senderTrimmed);
    });
    (feed.filter.deniedSenders ?? []).forEach((sender) => {
      const senderTrimmed = sender.trim();
      if (senderTrimmed) senderIds.add(senderTrimmed);
    });
  });

  return [...senderIds]
    .map((uuid) => ({
      id: uuid,
      label: profileLabel(uuid, profiles[uuid] ?? null),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
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

/**
 * When there are no resolved `networkIds`: no freq → no label (`null`, render as space);
 * strict mode → "Не встановлена"; else `msg.unit` or "Не встановлена".
 */
export function etalonFallbackWhenNoNetworks(
  msg: InboxMessage,
  options?: { featureStrictNetworks?: boolean },
): string | null {
  const hasFreq = msg.freq != null && String(msg.freq).trim() !== '';
  if (!hasFreq) return null;
  const strict = options?.featureStrictNetworks ?? false;
  if (strict) return 'Не встановлена';
  const unit = msg.unit?.trim();
  return unit != null && unit !== '' ? unit : 'Не встановлена';
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
  const freqStr = msg.freq != null ? String(msg.freq).trim() : '';
  const freqsSelected = freqStr !== '' ? [freqStr] : [];
  const stateSnake = {
    date_from_str: toDateStr(from),
    time_from_str: '',
    date_to_str: toDateStr(to),
    time_to_str: '00:00',
    aors_selected: [] as string[],
    groups_selected: [] as string[],
    senders_selected: [] as string[],
    freqs_selected: freqsSelected,
    callsigns_selected: [] as string[],
    units_selected: [] as string[],
    locations_selected: [] as string[],
    posts_selected: [] as string[],
    networks_selected: [] as string[],
    without_network: false,
    or_with_extended_form: false,
    or_bookmarked: false,
    or_important: false,
    or_with_coords: false,
    search: msg.messageUid ?? '',
    metadata_cc: [] as string[],
    metadata_sender: [] as string[],
    metadata_receiver: [] as string[],
    metadata_hash: [] as string[],
    only_with_metadata: false,
    without_metadata: false,
    tags: [] as number[],
    include_peleng_locations: false,
    units_exact_match_only: null as boolean | null,
    adjacent_freqs_range: 0,
    without_model_tags: false,
  };
  const stateEnc = encodeURIComponent(JSON.stringify(stateSnake));
  const base = `/rer-analysis?state=${stateEnc}`;
  return showMap ? `${base}&showMap=true` : base;
}

export function uniquePointEtalonsForMapSearch(etalons: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of etalons) {
    const t = String(raw).trim();
    if (t === '' || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function buildAnalysisMapHrefWithSearch(etalons: string | string[]): string {
  const searchStr = Array.isArray(etalons)
    ? uniquePointEtalonsForMapSearch(etalons).join(',')
    : String(etalons).trim();
  if (!searchStr) return '/rer-analysis?showMap=true';
  const stateEnc = encodeURIComponent(JSON.stringify({ search: searchStr }));
  return `/rer-analysis?state=${stateEnc}&showMap=true`;
}

export function messageHasPalitraTag(msg: InboxMessage, tagsMap: Record<number, Tag>): boolean {
  for (const row of msg.inboxTags ?? []) {
    if (tagsMap[row.tagId]?.isPalitra) return true;
  }
  for (const tagId of msg.tags ?? []) {
    if (tagsMap[tagId]?.isPalitra) return true;
  }
  return false;
}

export function getPointEtalonsFromMessage(msg: InboxMessage, tagsMap?: Record<number, Tag>): string[] {
  if (tagsMap != null && !messageHasPalitraTag(msg, tagsMap)) {
    return [];
  }
  const fromTokens = (msg.pointTokens ?? [])
    .map((p) => p.etalon)
    .filter((e) => e != null && String(e).trim() !== '');
  if (fromTokens.length > 0) return uniquePointEtalonsForMapSearch(fromTokens.map(String));
  const nodes = msg.textMarked ?? [];
  const etalons: string[] = [];
  for (const n of nodes) {
    if (typeof n !== 'string' && 'CNPointC' in n && (n as { CNPointC?: { etalon?: string } }).CNPointC?.etalon != null) {
      const e = String((n as { CNPointC: { etalon: string } }).CNPointC.etalon).trim();
      if (e !== '') etalons.push(e);
    }
  }
  return uniquePointEtalonsForMapSearch(etalons);
}

export type MessageItem = [number, InboxMessage];

/** Sort message items by time ascending (oldest first). Uses timestamp then id as tiebreaker. */
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
  /** Auto-add freqs in range (MHz); 0 = off. */
  adjacentFreqsRange: number;
  /** Підсвічувати сигнали (додатково). */
  highlightSignalsEnabled: boolean;
  /** Лише теги мого підрозділу (додатково). */
  onlyMyUnitTagsEnabled: boolean;
};

/** Unread count on the column “new messages” FAB chip — keep in sync anywhere else we show the same number (e.g. tab title). */
export function feedColumnUnreadDisplayed(feed: MessageFeedState): number {
  return feed.items.length > 0
    ? Math.max(feed.unreadCount, feed.items.filter(([id]) => !feed.readIds.has(id)).length)
    : feed.unreadCount;
}

export function toQueryState(messageFeeds: MessageFeedState[]): RerDutyState {
  return {
    messageFeeds: messageFeeds.map((f) => [f.id, f.filter]),
  };
}
