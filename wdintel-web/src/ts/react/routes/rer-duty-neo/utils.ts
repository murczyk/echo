import type {
  CallsignInfoRes,
  ContentNode,
  InboxMessage,
  InboxMessagesReq,
  RerDutyQueryState,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
} from '../../../../Bindings';
import type { Network, Unit } from '../../../../Bindings';
import type { RerAnalysisQueryState } from '../../../rer-analysis-query-state';
import { writeRerAnalysisQueryStateToSearchParams } from '../../../rer-analysis-query-state';
import { toLegacyRerAnalysisQueryState } from '../../../rer-analysis-query-state-legacy';
import { emptyArrToNull, isNullOrUndefined, isPresent } from '../../utils/misc';
import { normalizeCallsignLookupValue } from '../../utils/callsign-normalization';
import { getCanonicalUnitIdValue, isCanonicalUnitIdValue } from '../../utils/unit-search';
import { normalizeRerDutyQueryStateWf } from '../../../rer-duty-filter-normalizer';
import { readPersistedDutyFilterState } from './duty-filter-persistence';

export type DutyFeedFilterOptions = {
  adjacentFreqsRange: number;
  highlightSignalsEnabled: boolean;
  onlyMyUnitTagsEnabled: boolean;
};

export type RerDutyState = {
  messageFeeds: [string, RerDutyFeedFilterState, DutyFeedFilterOptions?][];
};

/** Network display text: "р/м " + name + " " + unit names + optional " (LOCATION)". */
export function createMasterUnitText(network: Network, unitsMap: Record<number, Unit>): string {
  const unitIds = network.unitIds ?? [];
  const networkName = network.name.trim();
  const unitNames = unitIds
    .map((id) => unitsMap[id]?.name?.trim() ?? '')
    .filter((name) => name !== '');
  const locationPart =
    network.location && network.location.trim() !== ''
      ? ` (${network.location.trim().toUpperCase()})`
      : '';
  if (unitNames.length === 0) {
    return networkName !== '' ? `р/м ${networkName}${locationPart}` : `р/м${locationPart}`;
  }
  return `р/м ${networkName} ${unitNames.join(', ')}${locationPart}`;
}

export const PAGE_ID = 'rer-duty-neo';
/** Poll get-inbox-count every 2s; load newer (get-inbox) only when count > 0. */
export const INBOX_COUNT_POLL_INTERVAL_MS = 1000;
export const MAX_MESSAGE_FEEDS = 4;

export type TagsLayoutVariant = 'full' | 'compact' | 'hidden';

/** When `rerDutyNeo` prefs omit a value or loading fails (settings + operative feed). */
export const DEFAULT_DUTY_TAGS_LAYOUT: TagsLayoutVariant = 'compact';

export type MessageEntityFilterKind = 'group' | 'sender' | 'freq' | 'post';

export type MessageEntityExcludeMenuOption = {
  entity: MessageEntityFilterKind;
  value: string;
  label: string;
};

export type MessageEntityValueSource = {
  value: string | null | undefined;
  label: string | null | undefined;
};

function normalizeFilterValues(values: readonly string[] | null | undefined): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  (values ?? []).forEach((value) => {
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed)) return;
    seen.add(trimmed);
    next.push(trimmed);
  });
  return next;
}

function appendUniqueValue(values: readonly string[] | null | undefined, value: string): string[] {
  const trimmed = value.trim();
  const next = normalizeFilterValues(values);
  if (trimmed !== '' && !next.includes(trimmed)) next.push(trimmed);
  return next;
}

function filterValuesForEntity(
  filters: RerDutyFeedFilterState,
  entity: MessageEntityFilterKind,
): {
  selected: readonly string[] | null | undefined;
  denied: readonly string[] | null | undefined;
} {
  switch (entity) {
    case 'group':
      return { selected: filters.groupsSelected, denied: filters.groupsDenied };
    case 'sender':
      return { selected: filters.sendersSelected, denied: filters.deniedSenders };
    case 'freq':
      return { selected: filters.freqsSelected, denied: filters.freqsDenied };
    case 'post':
      return { selected: filters.postsSelected, denied: filters.postsDenied };
  }
}

function setEntityFilterValues(
  filters: RerDutyFeedFilterState,
  entity: MessageEntityFilterKind,
  nextSelected: string[] | null,
  nextDenied: string[] | null,
): RerDutyFeedFilterState {
  switch (entity) {
    case 'group':
      return { ...filters, groupsSelected: nextSelected, groupsDenied: nextDenied };
    case 'sender':
      return { ...filters, sendersSelected: nextSelected, deniedSenders: nextDenied };
    case 'freq':
      return { ...filters, freqsSelected: nextSelected, freqsDenied: nextDenied };
    case 'post':
      return { ...filters, postsSelected: nextSelected, postsDenied: nextDenied };
  }
}

export function isMessageEntityExcluded(
  filters: RerDutyFeedFilterState,
  entity: MessageEntityFilterKind,
  value: string,
): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  const { denied } = filterValuesForEntity(filters, entity);
  return normalizeFilterValues(denied).includes(trimmed);
}

export function excludeMessageEntityFromFilters(
  filters: RerDutyFeedFilterState,
  entity: MessageEntityFilterKind,
  value: string,
): RerDutyFeedFilterState {
  const trimmed = value.trim();
  if (trimmed === '') return filters;
  const { selected, denied } = filterValuesForEntity(filters, entity);
  const currentSelected = normalizeFilterValues(selected);
  const currentDenied = normalizeFilterValues(denied);
  if (currentDenied.length > 0) {
    return setEntityFilterValues(filters, entity, null, appendUniqueValue(currentDenied, trimmed));
  }
  if (currentSelected.length > 0) {
    return setEntityFilterValues(filters, entity, null, [trimmed]);
  }
  return setEntityFilterValues(filters, entity, null, [trimmed]);
}

export function buildVisibleExcludeMenuOptions(
  filters: RerDutyFeedFilterState,
  sources: Record<MessageEntityFilterKind, MessageEntityValueSource | null | undefined>,
): MessageEntityExcludeMenuOption[] {
  const definitions: Array<{
    entity: MessageEntityFilterKind;
    value: string | null | undefined;
    label: string | null | undefined;
  }> = [
    { entity: 'group', value: sources.group?.value, label: sources.group?.label },
    { entity: 'sender', value: sources.sender?.value, label: sources.sender?.label },
    { entity: 'freq', value: sources.freq?.value, label: sources.freq?.label },
    { entity: 'post', value: sources.post?.value, label: sources.post?.label },
  ];
  return definitions.flatMap(({ entity, value, label }) => {
    const trimmedValue = value?.trim() ?? '';
    const trimmedLabel = label?.trim() ?? '';
    if (trimmedValue === '' || trimmedLabel === '') return [];
    if (isMessageEntityExcluded(filters, entity, trimmedValue)) return [];
    return [{ entity, value: trimmedValue, label: trimmedLabel }];
  });
}

export function emptyFilter(): RerDutyFeedFilterState {
  return {
    groupsSelected: null,
    groupsDenied: null,
    sendersSelected: null,
    deniedSenders: null,
    freqsSelected: null,
    freqsDenied: null,
    postsSelected: null,
    postsDenied: null,
    unitsSelected: null,
    unitsDenied: null,
    selectedDeviceNames: null,
    deniedDeviceNames: null,
    selectedUnitIds: null,
    deniedUnitIds: null,
    unitsExactMatchOnly: false,
    lastViewedMessageId: null,
    highlightKeywordsEnabled: null,
    highlightKeywordSetId: null,
  };
}

export function hasActiveFeedFilter(filter: RerDutyFeedFilterState): boolean {
  return (
    [
      filter.groupsSelected,
      filter.groupsDenied,
      filter.sendersSelected,
      filter.deniedSenders,
      filter.freqsSelected,
      filter.freqsDenied,
      filter.postsSelected,
      filter.postsDenied,
      filter.unitsSelected,
      filter.unitsDenied,
      filter.selectedUnitIds,
      filter.deniedUnitIds,
      filter.selectedDeviceNames,
      filter.deniedDeviceNames,
    ].some((values) => (values?.length ?? 0) > 0) || filter.unitsExactMatchOnly === true
  );
}

export function clearActiveFeedFilter(filter: RerDutyFeedFilterState): RerDutyFeedFilterState {
  return {
    ...emptyFilter(),
    lastViewedMessageId: filter.lastViewedMessageId,
    highlightKeywordsEnabled: filter.highlightKeywordsEnabled,
    highlightKeywordSetId: filter.highlightKeywordSetId,
  };
}

function normalizeFeedEntry(entry: unknown): [string, RerDutyFeedFilterState] {
  if (Array.isArray(entry) && entry.length >= 2) {
    const id = String(entry[0]);
    const filter = normalizeFeed((entry[1] as Record<string, unknown>) ?? {});
    return [id, filter];
  }
  return [`mf-${Math.random().toString(36).slice(2, 7)}`, emptyFilter()];
}

function normalizeFeedEntries(entries: unknown): [string, RerDutyFeedFilterState][] {
  if (!Array.isArray(entries) || entries.length === 0) return [['mf-0', emptyFilter()]];
  return entries.map(normalizeFeedEntry);
}

function normalizePersistedFeedOptions(value: unknown): DutyFeedFilterOptions | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const adjacentFreqsRange =
    typeof raw.adjacentFreqsRange === 'number' &&
    (ADJACENT_FREQS_RANGE_OPTIONS as readonly number[]).includes(raw.adjacentFreqsRange)
      ? raw.adjacentFreqsRange
      : 0;
  return {
    adjacentFreqsRange,
    highlightSignalsEnabled: raw.highlightSignalsEnabled === true,
    onlyMyUnitTagsEnabled: raw.onlyMyUnitTagsEnabled === true,
  };
}

function normalizePersistedFeedEntries(
  entries: unknown,
): [string, RerDutyFeedFilterState, DutyFeedFilterOptions?][] {
  if (!Array.isArray(entries) || entries.length === 0) return [['mf-0', emptyFilter()]];
  return entries.map((entry) => {
    const [id, filter] = normalizeFeedEntry(entry);
    const options = Array.isArray(entry) ? normalizePersistedFeedOptions(entry[2]) : undefined;
    return options ? [id, filter, options] : [id, filter];
  });
}

function parsePersistedDutyState(): RerDutyState | null {
  const persistedState = readPersistedDutyFilterState();
  if (!persistedState || typeof persistedState !== 'object' || Array.isArray(persistedState)) {
    return null;
  }
  const raw = persistedState as Record<string, unknown>;
  const messageFeeds = raw.messageFeeds ?? raw.waterfalls ?? raw.waterfall;
  return messageFeeds == null
    ? null
    : { messageFeeds: normalizePersistedFeedEntries(messageFeeds) };
}

export function readPersistedDutyFeedOptionsById(): Map<string, DutyFeedFilterOptions> {
  const optionsByFeedId = new Map<string, DutyFeedFilterOptions>();
  parsePersistedDutyState()?.messageFeeds.forEach(([id, , options]) => {
    if (options) optionsByFeedId.set(id, options);
  });
  return optionsByFeedId;
}

/** Distinguishes null/undefined from []. Backend treats None (no filter) vs Some([]) (empty filter → no rows) differently. */
function optArrEqual(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  if (isNullOrUndefined(a) && isNullOrUndefined(b)) return true;
  if (isNullOrUndefined(a) || isNullOrUndefined(b)) return false;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** True when both filters are equivalent for request purposes (no need to refetch). */
export function filtersEqual(a: RerDutyFeedFilterState, b: RerDutyFeedFilterState): boolean {
  return (
    optArrEqual(a.groupsSelected, b.groupsSelected) &&
    optArrEqual(a.groupsDenied, b.groupsDenied) &&
    optArrEqual(a.sendersSelected, b.sendersSelected) &&
    optArrEqual(a.deniedSenders, b.deniedSenders) &&
    optArrEqual(a.freqsSelected, b.freqsSelected) &&
    optArrEqual(a.freqsDenied, b.freqsDenied) &&
    optArrEqual(a.postsSelected, b.postsSelected) &&
    optArrEqual(a.postsDenied, b.postsDenied) &&
    optArrEqual(a.unitsSelected, b.unitsSelected) &&
    optArrEqual(a.unitsDenied, b.unitsDenied) &&
    optArrEqual(a.selectedDeviceNames, b.selectedDeviceNames) &&
    optArrEqual(a.deniedDeviceNames, b.deniedDeviceNames) &&
    (a.unitsExactMatchOnly ?? false) === (b.unitsExactMatchOnly ?? false) &&
    a.highlightKeywordSetId === b.highlightKeywordSetId
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
  range: number,
): string[] {
  if (range <= 0) return [];
  return allFrequencies.filter(
    (freq) =>
      !selectedFrequencies.includes(freq) &&
      selectedFrequencies.some((selected) => isInRange(selected, freq, range)),
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
  sortBy?: 'IMSTimestamp' | 'IMSCreatedAt';
}): InboxMessagesReq {
  const f = opts.filter;
  const selectedUnitIds = (f.unitsSelected ?? []).flatMap((value) => {
    const unitId = getCanonicalUnitIdValue(value);
    return unitId === null ? [] : [unitId];
  });
  const deniedUnitIds = (f.unitsDenied ?? []).flatMap((value) => {
    const unitId = getCanonicalUnitIdValue(value);
    return unitId === null ? [] : [unitId];
  });
  const selectedLegacyUnits = (f.unitsSelected ?? []).filter(
    (value) => !isCanonicalUnitIdValue(value),
  );
  const deniedLegacyUnits = (f.unitsDenied ?? []).filter((value) => !isCanonicalUnitIdValue(value));
  // send empty arrays as null (backend treats null/undefined vs [] differently)
  return {
    sinceIdNoninclusive: opts.sinceIdNoninclusive ?? null,
    beforeIdNoninclusive: opts.beforeIdNoninclusive ?? null,
    aroundMessageRef: null,
    sinceDateInclusiveMs: opts.sinceDateInclusiveMs ?? null,
    tillDateInclusiveMs: opts.tillDateInclusiveMs ?? null,
    onlyShowUnprocessed: null,
    checkedOnly: null,
    selectedGroups: emptyArrToNull(f.groupsSelected),
    deniedGroups: emptyArrToNull(f.groupsDenied),
    selectedSenders: emptyArrToNull(f.sendersSelected),
    deniedSenders: emptyArrToNull(f.deniedSenders),
    selectedFreqs: emptyArrToNull(opts.expandedFreqsSelected ?? f.freqsSelected ?? null),
    selectedPosts: emptyArrToNull(f.postsSelected),
    deniedPosts: emptyArrToNull(f.postsDenied),
    deniedFreqs: emptyArrToNull(opts.expandedFreqsDenied ?? f.freqsDenied ?? null),
    selectedCallsigns: null,
    selectedUnits: emptyArrToNull(selectedLegacyUnits),
    selectedUnitIds: emptyArrToNull(selectedUnitIds),
    selectedDeviceNames: emptyArrToNull(f.selectedDeviceNames),
    deniedDeviceNames: emptyArrToNull(f.deniedDeviceNames),
    deniedUnits: emptyArrToNull(deniedLegacyUnits),
    deniedUnitIds: emptyArrToNull(deniedUnitIds),
    selectedLocations: null,
    nolimit: opts.nolimit ?? null,
    orWithExtendedForm: null,
    loadLatest: opts.loadLatest ?? null,
    returnDuplicates: true,
    orBookmarked: null,
    orImportant: null,
    orWithCoords: null,
    orWithoutCoords: null,
    newestFirst: null,
    search: null,
    highlightCallsigns: true,
    highlightKeywords: f.highlightKeywordSetId != null,
    highlightKeywordSetId: f.highlightKeywordSetId ?? null,
    highlightSearchres: true,
    highlightSignals: opts.highlightSignals ?? false,
    highlightPoints: true,
    selectedTags: null,
    deniedTags: null,
    tagPresence: null,
    selectedAors: null,
    selectedNetworks: null,
    withoutNetwork: null,
    metadataCc: null,
    metadataSender: null,
    metadataReceiver: null,
    metadataHash: null,
    onlyWithMetadata: null,
    withoutMetadata: null,
    sortBy: opts.sortBy ?? 'IMSTimestamp',
    reportTagsOnlyThisUnit: opts.reportTagsOnlyThisUnit ?? null,
    ignoreImportedCoords: true,
    includePelengLocations: null,
    unitsExactMatchOnly:
      selectedLegacyUnits.length + deniedLegacyUnits.length > 0
        ? (f.unitsExactMatchOnly ?? null)
        : null,
    calculateFreqPelengsSummary: null,
    skipGroupStats: true,
    filterTagsOption: null,
    pageId: PAGE_ID,
    withoutModelTags: null,
    onlyWithMedia: false,
  };
}

export const normalizeFeed = normalizeRerDutyQueryStateWf;

export function parseStateFromUrl(): RerDutyState {
  const params = new URLSearchParams(window.location.search);
  const stateStr = params.get('state');
  if (!stateStr) {
    if (params.has('state-short')) return { messageFeeds: [['mf-0', emptyFilter()]] };
    if (parseDutyMessageUidFromWindow() !== null) {
      return { messageFeeds: [['mf-0', emptyFilter()]] };
    }
    const persistedState = parsePersistedDutyState();
    if (persistedState) return persistedState;
    return { messageFeeds: [['mf-0', emptyFilter()]] };
  }
  try {
    const raw = JSON.parse(decodeURIComponent(stateStr)) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return { messageFeeds: [['mf-0', emptyFilter()]] };
    const wfs = raw.messageFeeds ?? raw.waterfalls ?? raw.waterfall;
    return { messageFeeds: normalizePersistedFeedEntries(wfs) };
  } catch {
    return { messageFeeds: [['mf-0', emptyFilter()]] };
  }
}

export function getShortStateIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('state-short');
}

export function pushStateToUrl(state: RerDutyState) {
  const q = new URLSearchParams(window.location.search);
  q.set('state', encodeURIComponent(JSON.stringify(state)));
  q.delete('state-short');
  const url = `${window.location.pathname}?${q.toString()}`;
  window.history.replaceState({}, '', url);
}

export function pushShortStateToUrl(id: string) {
  const q = new URLSearchParams(window.location.search);
  q.set('state-short', id);
  q.delete('state');
  const url = `${window.location.pathname}?${q.toString()}`;
  window.history.replaceState({}, '', url);
}

function stableStringifyValue(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringifyValue).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringifyValue(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stableStringify(state: unknown): string {
  return stableStringifyValue(state);
}

export function toShortQueryState(messageFeeds: MessageFeedState[]): RerDutyQueryState {
  return {
    waterfalls: messageFeeds.map((f) => [f.id, f.filter]),
  };
}

export function toRerDutyStateFromShort(state: RerDutyQueryState): RerDutyState {
  return {
    messageFeeds: normalizeFeedEntries(state.waterfalls ?? []),
  };
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
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

export function formatTime(time: string | null): string {
  if (isNullOrUndefined(time) || time === '') return '—';
  const parts = time.trim().split(':');
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  return time;
}

export function formatDateNoYear(date: string | null): string {
  if (isNullOrUndefined(date) || date === '') return '—';
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
  const hasFreq = isPresent(msg.freq) && String(msg.freq).trim() !== '';
  if (!hasFreq) return null;
  const strict = options?.featureStrictNetworks ?? false;
  if (strict) return 'Не встановлена';
  const unit = msg.unit?.trim();
  return isPresent(unit) && unit !== '' ? unit : 'Не встановлена';
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

/**
 * Flat query state for `/rer-analysis-neo` (same window as legacy Elm duty links: date range, freq, search).
 * `search` is message UID or comma-joined map point etalons.
 */
function rerAnalysisNeoQueryStateFromMessage(
  msg: InboxMessage,
  search: string,
): RerAnalysisQueryState {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - 15);
  const to = new Date(now);
  to.setDate(to.getDate() + 1);
  const freqStr = isPresent(msg.freq) ? String(msg.freq).trim() : '';
  const state: RerAnalysisQueryState = {
    // Neo deep links must use the combined datetime keys; the legacy split keys are no longer parsed.
    fromDateTimeStr: `${toDateStr(from)}T00:00`,
    toDateTimeStr: `${toDateStr(to)}T00:00`,
    search,
    includePelengLocations: false,
    orWithoutCoords: false,
  };
  if (freqStr !== '') {
    state.freqsSelected = [freqStr];
  }
  return state;
}

function buildRerAnalysisNeoHref(state: RerAnalysisQueryState, showMap: boolean): string {
  const params = new URLSearchParams();
  writeRerAnalysisQueryStateToSearchParams(params, state);
  if (showMap) {
    params.set('showMap', 'true');
  }
  const qs = params.toString();
  return qs ? `/rer-analysis-neo?${qs}` : `/rer-analysis-neo${showMap ? '?showMap=true' : ''}`;
}

function buildClassicRerAnalysisHref(state: RerAnalysisQueryState, showMap: boolean): string {
  const params = new URLSearchParams();
  params.set('state', JSON.stringify(toLegacyRerAnalysisQueryState(state)));
  if (showMap) {
    params.set('showMap', 'true');
  }
  const qs = params.toString();
  return qs ? `/rer-analysis?${qs}` : '/rer-analysis';
}

export function buildAnalysisHref(msg: InboxMessage, showMap: boolean): string {
  return buildRerAnalysisNeoHref(
    rerAnalysisNeoQueryStateFromMessage(msg, msg.messageUid ?? ''),
    showMap,
  );
}

export function buildClassicAnalysisHref(msg: InboxMessage, showMap: boolean): string {
  return buildClassicRerAnalysisHref(
    rerAnalysisNeoQueryStateFromMessage(msg, msg.messageUid ?? ''),
    showMap,
  );
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

/**
 * Map-focused analysis URL for `/rer-analysis-neo`. When `msg` is passed, includes the same date range
 * and `freqs` as other analysis links from this message.
 */
export function buildAnalysisMapHrefWithSearch(
  etalons: string | string[],
  msg?: InboxMessage,
): string {
  const searchStr = Array.isArray(etalons)
    ? uniquePointEtalonsForMapSearch(etalons).join(',')
    : String(etalons).trim();
  if (!searchStr) {
    if (isPresent(msg)) return buildAnalysisHref(msg, true);
    return '/rer-analysis-neo?showMap=true';
  }
  if (isPresent(msg)) {
    return buildRerAnalysisNeoHref(rerAnalysisNeoQueryStateFromMessage(msg, searchStr), true);
  }
  return buildRerAnalysisNeoHref({ search: searchStr }, true);
}

export function buildClassicAnalysisMapHrefWithSearch(
  etalons: string | string[],
  msg?: InboxMessage,
): string {
  const searchStr = Array.isArray(etalons)
    ? uniquePointEtalonsForMapSearch(etalons).join(',')
    : String(etalons).trim();
  if (!searchStr) {
    if (isPresent(msg)) return buildClassicAnalysisHref(msg, true);
    return '/rer-analysis?showMap=true';
  }
  if (isPresent(msg)) {
    return buildClassicRerAnalysisHref(rerAnalysisNeoQueryStateFromMessage(msg, searchStr), true);
  }
  return buildClassicRerAnalysisHref({ search: searchStr }, true);
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

export function getPointEtalonsFromMessage(
  msg: InboxMessage,
  tagsMap?: Record<number, Tag>,
): string[] {
  if (isPresent(tagsMap) && !messageHasPalitraTag(msg, tagsMap)) {
    return [];
  }
  const fromTokens = (msg.pointTokens ?? [])
    .map((p) => p.etalon)
    .filter((e) => isPresent(e) && String(e).trim() !== '');
  if (fromTokens.length > 0) return uniquePointEtalonsForMapSearch(fromTokens.map(String));
  const nodes = msg.textMarked ?? [];
  const etalons: string[] = [];
  for (const n of nodes) {
    if (
      typeof n !== 'string' &&
      'CNPointC' in n &&
      isPresent((n as { CNPointC?: { etalon?: string } }).CNPointC?.etalon)
    ) {
      const e = String((n as { CNPointC: { etalon: string } }).CNPointC.etalon).trim();
      if (e !== '') etalons.push(e);
    }
  }
  return uniquePointEtalonsForMapSearch(etalons);
}

export type MessageItem = [number, InboxMessage];
export type MessageCursor = { id: number; timestamp: number | null };

export function messageOrderTimestamp(
  message: InboxMessage,
  messageSortBy: 'IMSTimestamp' | 'IMSCreatedAt',
): number | null | undefined {
  return messageSortBy === 'IMSCreatedAt'
    ? (message.createdAtOrder ?? (message.createdAt == null ? null : message.createdAt * 1000))
    : message.timestamp;
}

export function messageOrderCursor(
  id: number,
  message: InboxMessage,
  messageSortBy: 'IMSTimestamp' | 'IMSCreatedAt',
): MessageCursor {
  return { id, timestamp: messageOrderTimestamp(message, messageSortBy) ?? null };
}

export function compareMessageTuple(
  a: { timestamp: number | null | undefined; id: number },
  b: { timestamp: number | null | undefined; id: number },
): number {
  const timestampDiff = (a.timestamp ?? 0) - (b.timestamp ?? 0);
  return timestampDiff !== 0 ? timestampDiff : a.id - b.id;
}

export const DUTY_FEED_MESSAGE_PAGE_SIZE = 20;
export const DUTY_FEED_MESSAGE_WINDOW_LIMIT = 40;
/** Keep at least this many loaded-unread messages (after last-seen) when near the live tail. */
export const DUTY_FEED_UNREAD_PREFETCH_MIN = 10;
/** Multi-feed: after this idle time, off-viewport MessageCards become height placeholders. */
export const DUTY_FEED_IDLE_OFFLOAD_MS = 10_000;
/** Extra viewport margin kept live while idle-offload is active. */
export const DUTY_FEED_IDLE_OFFLOAD_OVERSCAN_PX = 240;
/** Fallback row height when an idle placeholder has no measured size yet. */
export const DUTY_FEED_IDLE_PLACEHOLDER_HEIGHT_PX = 120;

export type WindowedMessageItemsResult = {
  items: MessageItem[];
  addedItems: MessageItem[];
  removedItems: MessageItem[];
};

function normalizeWindowLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DUTY_FEED_MESSAGE_WINDOW_LIMIT;
  return Math.max(1, Math.floor(limit));
}

function itemIds(items: MessageItem[]): Set<number> {
  return new Set(items.map(([id]) => id));
}

function trimMessageWindow(
  items: MessageItem[],
  limit: number,
  trimFrom: 'start' | 'end',
): { items: MessageItem[]; removedItems: MessageItem[] } {
  const normalizedLimit = normalizeWindowLimit(limit);
  if (items.length <= normalizedLimit) return { items, removedItems: [] };
  const removeCount = items.length - normalizedLimit;
  if (trimFrom === 'start') {
    return {
      items: items.slice(removeCount),
      removedItems: items.slice(0, removeCount),
    };
  }
  return {
    items: items.slice(0, normalizedLimit),
    removedItems: items.slice(normalizedLimit),
  };
}

export function windowInitialMessageItems(
  items: MessageItem[],
  limit: number = DUTY_FEED_MESSAGE_WINDOW_LIMIT,
  messageSortBy: 'IMSTimestamp' | 'IMSCreatedAt' = 'IMSTimestamp',
): MessageItem[] {
  const sorted = sortMessageItemsByTime(dedupeMessageItems(items), messageSortBy);
  return trimMessageWindow(sorted, limit, 'start').items;
}

export function prependWindowedMessageItems(
  existing: MessageItem[],
  incomingOlder: MessageItem[],
  limit: number = DUTY_FEED_MESSAGE_WINDOW_LIMIT,
  messageSortBy: 'IMSTimestamp' | 'IMSCreatedAt' = 'IMSTimestamp',
): WindowedMessageItemsResult {
  const existingIds = itemIds(existing);
  const addedItems = dedupeMessageItems(incomingOlder).filter(([id]) => !existingIds.has(id));
  const combined = sortMessageItemsByTime(
    dedupeMessageItems([...addedItems, ...existing]),
    messageSortBy,
  );
  const trimmed = trimMessageWindow(combined, limit, 'end');
  return { items: trimmed.items, addedItems, removedItems: trimmed.removedItems };
}

export function appendWindowedMessageItems(
  existing: MessageItem[],
  incomingNewer: MessageItem[],
  limit: number = DUTY_FEED_MESSAGE_WINDOW_LIMIT,
  messageSortBy: 'IMSTimestamp' | 'IMSCreatedAt' = 'IMSTimestamp',
): WindowedMessageItemsResult {
  const existingIds = itemIds(existing);
  const addedItems = dedupeMessageItems(incomingNewer).filter(([id]) => !existingIds.has(id));
  const combined = sortMessageItemsByTime(
    dedupeMessageItems([...existing, ...addedItems]),
    messageSortBy,
  );
  const trimmed = trimMessageWindow(combined, limit, 'start');
  return { items: trimmed.items, addedItems, removedItems: trimmed.removedItems };
}

/**
 * Returns the largest ordered pending prefix that can enter a bounded window
 * without evicting a currently visible row. Callers retain the remainder.
 */
export function safePendingNewerPrefix(
  items: MessageItem[],
  pending: MessageItem[],
  protectedItemIds: readonly number[],
  messageSortBy: 'IMSTimestamp' | 'IMSCreatedAt' = 'IMSTimestamp',
): MessageItem[] {
  if (protectedItemIds.length === 0) return pending;
  const protectedIds = new Set(protectedItemIds);
  let safeLength = 0;
  for (let length = 1; length <= pending.length; length += 1) {
    const preview = appendWindowedMessageItems(
      items,
      pending.slice(0, length),
      undefined,
      messageSortBy,
    );
    if (preview.removedItems.some(([id]) => protectedIds.has(id))) break;
    safeLength = length;
  }
  return pending.slice(0, safeLength);
}

export function retainReadIdsForItems(
  readIds: ReadonlySet<number>,
  items: MessageItem[],
): Set<number> {
  const visibleIds = itemIds(items);
  return new Set([...readIds].filter((id) => visibleIds.has(id)));
}

function extractCallsignsFromNodes(nodes: ContentNode[] | null | undefined): string[] {
  if (!nodes || nodes.length === 0) return [];
  const callsigns: string[] = [];
  for (const node of nodes) {
    if (typeof node !== 'string' && 'CNCallsignC' in node) {
      const callsign = normalizeCallsignLookupValue(node.CNCallsignC.text);
      if (callsign !== '') callsigns.push(callsign);
    }
  }
  return callsigns;
}

export function collectUniqueCallsignsFromMessages(
  feeds: Array<{ items: MessageItem[] }>,
): string[] {
  const callsigns = new Set<string>();
  feeds.forEach((feed) => {
    feed.items.forEach(([, msg]) => {
      extractCallsignsFromNodes(msg.textMarked).forEach((callsign) => {
        callsigns.add(callsign);
      });
    });
  });
  return [...callsigns];
}

export function mergeCallsignInfoResponses(
  prev: Record<string, CallsignInfoRes>,
  nextItems: CallsignInfoRes[],
): Record<string, CallsignInfoRes> {
  if (nextItems.length === 0) return prev;
  const next = { ...prev };
  nextItems.forEach((item) => {
    const callsign = normalizeCallsignLookupValue(item.callsign);
    if (callsign !== '') {
      next[callsign] = item;
    }
  });
  return next;
}

/** Sort message items by time ascending (oldest first). Uses timestamp then id as tiebreaker. */
export function sortMessageItemsByTime(
  items: MessageItem[],
  messageSortBy: 'IMSTimestamp' | 'IMSCreatedAt' = 'IMSTimestamp',
): MessageItem[] {
  return [...items].sort(([idA, a], [idB, b]) =>
    compareMessageTuple(
      { id: idA, timestamp: messageOrderTimestamp(a, messageSortBy) },
      { id: idB, timestamp: messageOrderTimestamp(b, messageSortBy) },
    ),
  );
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

export type MessageFeedState = {
  id: string;
  messageSortBy: 'IMSTimestamp' | 'IMSCreatedAt';
  filter: RerDutyFeedFilterState;
  items: MessageItem[];
  loading: boolean;
  loadingOlder: boolean;
  /** True after "load older" returned 0 new items — nothing older to fetch */
  hasReachedStart: boolean;
  /** Reference time (ms) for relative "time ago" in message cards; set when feed items are loaded. */
  referenceTimeMs: number | null;
  /** Message IDs that have been "read" (entered viewport). Unread count = items not in this set. */
  readIds: Set<number>;
  windowedUnreadItems: Map<number, number>;
  /** Unread identities retained across a sort reload when their new ordering value is not loaded. */
  unresolvedUnreadIds?: Set<number>;
  /** Count of retained unread messages without an individual identity. */
  unresolvedUnreadCount?: number;
  unreadCount: number;
  /**
   * Newer pages held off the DOM while not following (Elm `notRenderedMessagesYet`).
   * Flushed into `items` on follow / arrow / reach-bottom.
   */
  pendingNewerItems?: MessageItem[];
  /** Auto-add freqs in range (MHz); 0 = off. */
  adjacentFreqsRange: DutyFeedFilterOptions['adjacentFreqsRange'];
  /** Підсвічувати сигнали (додатково). */
  highlightSignalsEnabled: DutyFeedFilterOptions['highlightSignalsEnabled'];
  /** Лише теги мого підрозділу (додатково). */
  onlyMyUnitTagsEnabled: DutyFeedFilterOptions['onlyMyUnitTagsEnabled'];
};

/** Single source of truth for displayed unread count on a feed. */
export function feedUnreadDisplayCount(feed: MessageFeedState): number {
  return Math.max(0, feed.unreadCount);
}

export function feedLoadedUnreadCount(feed: MessageFeedState): number {
  let count = 0;
  for (const [id] of feed.items) {
    if (!feed.readIds.has(id)) count += 1;
  }
  return count;
}

export function feedPendingNewerItems(feed: MessageFeedState): MessageItem[] {
  return feed.pendingNewerItems ?? [];
}

export function feedPendingNewerUnreadCount(feed: MessageFeedState): number {
  let count = 0;
  for (const [id] of feedPendingNewerItems(feed)) {
    if (!feed.readIds.has(id)) count += 1;
  }
  return count;
}

/** Merge fetched newer rows into the off-DOM pending buffer (deduped vs window + pending). */
export function mergePendingNewerItems(
  feed: MessageFeedState,
  incomingNewer: MessageItem[],
): MessageItem[] {
  const existingIds = itemIds(feed.items);
  const pending = feedPendingNewerItems(feed);
  const pendingIds = itemIds(pending);
  const added = dedupeMessageItems(incomingNewer).filter(
    ([id]) => !existingIds.has(id) && !pendingIds.has(id),
  );
  if (added.length === 0) return pending;
  return sortMessageItemsByTime(dedupeMessageItems([...pending, ...added]), feed.messageSortBy);
}

/** Effective since-id for newer fetches: pending tail when buffering, else window tail. */
export function feedNewerSinceId(feed: MessageFeedState): number | null {
  const pendingTail = feedPendingNewerItems(feed).at(-1)?.[0];
  if (pendingTail != null) return pendingTail;
  return feed.items.at(-1)?.[0] ?? null;
}

/**
 * True when a newer page should stay off the DOM (near-bottom ManualScroll / not following).
 * Follow / mark-all-read apply immediately. Physical bottom also applies immediately —
 * the user is already on the live edge and expects pending pages to mount.
 */
export function shouldBufferNewerMessages(options: {
  nearBottom: boolean;
  physicallyAtBottom: boolean;
  followTail: boolean;
  markAllRead: boolean;
}): boolean {
  return (
    options.nearBottom && !options.physicallyAtBottom && !options.followTail && !options.markAllRead
  );
}

function reconcileWindowedUnreadIdsForAppend(
  feed: MessageFeedState,
  windowed: WindowedMessageItemsResult,
): Map<number, number> {
  const windowedUnreadItems = new Map(feed.windowedUnreadItems);
  windowed.removedItems.forEach(([id, message]) => {
    if (!feed.readIds.has(id)) {
      windowedUnreadItems.set(id, messageOrderTimestamp(message, feed.messageSortBy) ?? 0);
    }
  });
  windowed.items.forEach(([id]) => windowedUnreadItems.delete(id));
  return windowedUnreadItems;
}

/**
 * Append newer rows into the 40-window and clear pending.
 * Shared by live newer commits and pending flush.
 */
export function appendNewerItemsToFeed(
  feed: MessageFeedState,
  incomingNewer: MessageItem[],
  options?: { markAllRead?: boolean },
): MessageFeedState {
  const markAllRead = options?.markAllRead === true;
  const windowed = appendWindowedMessageItems(
    feed.items,
    incomingNewer,
    undefined,
    feed.messageSortBy,
  );
  if (windowed.addedItems.length === 0) {
    if (markAllRead) {
      return {
        ...feed,
        readIds: new Set<number>([...feed.readIds, ...feed.items.map(([id]) => id)]),
        windowedUnreadItems: new Map<number, number>(),
        unresolvedUnreadIds: new Set<number>(),
        unresolvedUnreadCount: 0,
        unreadCount: 0,
        pendingNewerItems: [],
      };
    }
    if ((feed.pendingNewerItems?.length ?? 0) === 0) return feed;
    return { ...feed, pendingNewerItems: [] };
  }
  const previousIds = new Set(feed.items.map(([id]) => id));
  const trimmedPreviousUnreadIds = windowed.removedItems
    .filter(([id]) => previousIds.has(id) && !feed.readIds.has(id))
    .map(([id]) => id);
  const readIds =
    markAllRead || trimmedPreviousUnreadIds.length > 0
      ? new Set<number>([
          ...feed.readIds,
          ...(markAllRead ? windowed.items.map(([id]) => id) : []),
          ...trimmedPreviousUnreadIds,
        ])
      : feed.readIds;
  const unreadAddedCount = windowed.addedItems.filter(([id]) => !readIds.has(id)).length;
  const windowedUnreadItems = reconcileWindowedUnreadIdsForAppend({ ...feed, readIds }, windowed);
  return {
    ...feed,
    items: windowed.items,
    readIds: markAllRead
      ? new Set<number>([...readIds, ...windowed.items.map(([id]) => id)])
      : readIds,
    unreadCount: markAllRead
      ? 0
      : Math.max(0, Math.max(feed.unreadCount, unreadAddedCount) - trimmedPreviousUnreadIds.length),
    windowedUnreadItems: markAllRead ? new Map<number, number>() : windowedUnreadItems,
    hasReachedStart: windowed.removedItems.length > 0 ? false : feed.hasReachedStart,
    pendingNewerItems: [],
  };
}

/** Flush off-DOM pending newer rows into the visible window. */
export function flushPendingNewerItems(
  feed: MessageFeedState,
  options?: { markAllRead?: boolean },
): MessageFeedState {
  const pending = feedPendingNewerItems(feed);
  if (pending.length === 0) {
    if (options?.markAllRead === true) {
      return appendNewerItemsToFeed(feed, [], { markAllRead: true });
    }
    return feed;
  }
  return appendNewerItemsToFeed(feed, pending, options);
}

/** True when the window still needs newer pages to refill the unread runway after last-seen. */
export function feedNeedsUnreadPrefetch(feed: MessageFeedState): boolean {
  return (
    feedLoadedUnreadCount(feed) + feedPendingNewerUnreadCount(feed) < DUTY_FEED_UNREAD_PREFETCH_MIN
  );
}

/**
 * Poll/badge metadata (`unreadCount`, `readIds`, `windowedUnreadItems`, `pendingNewerItems`)
 * must not invalidate the message-list render path — those fields change on every counter tick
 * while `items` stay put.
 */
export function feedListRenderStateEqual(prev: MessageFeedState, next: MessageFeedState): boolean {
  return (
    prev === next ||
    (prev.id === next.id &&
      prev.items === next.items &&
      prev.loading === next.loading &&
      prev.loadingOlder === next.loadingOlder &&
      prev.hasReachedStart === next.hasReachedStart &&
      prev.referenceTimeMs === next.referenceTimeMs &&
      prev.filter === next.filter &&
      prev.onlyMyUnitTagsEnabled === next.onlyMyUnitTagsEnabled)
  );
}

/**
 * Badge = loadedUnread + pendingUnread + trimmedUnread + beyondTailPending.
 * Matching tail preview is the beyond-tail term (covers pending while tail id unchanged).
 * Residual `unreadCount` above local loaded+pending+trimmed is only used when
 * `includeBeyondTailResidual` is true (scrolled up). Near the live tail it
 * must stay off — otherwise a stale poll stock sticks as a phantom badge.
 */
export function feedIndicatorUnreadCount(
  feed: MessageFeedState,
  preview?: { tailId: number; count: number },
  options?: { includeBeyondTailResidual?: boolean },
): number {
  const loadedUnread = feedLoadedUnreadCount(feed);
  const pendingUnread = feedPendingNewerUnreadCount(feed);
  const windowedUnreadItems = feed.windowedUnreadItems ?? new Map<number, number>();
  const loadedIds = new Set(feed.items.map(([id]) => id));
  const pendingIds = new Set(feed.pendingNewerItems?.map(([id]) => id) ?? []);
  const comparableWindowedUnread = [...windowedUnreadItems].filter(
    ([id]) => !loadedIds.has(id) && !pendingIds.has(id),
  );
  const currentTailId = feed.items.at(-1)?.[0];
  const hasMatchingPreview = currentTailId != null && preview?.tailId === currentTailId;
  if (hasMatchingPreview) {
    const tail = feed.items.at(-1);
    const windowedUnreadBeforeOrAtTail = comparableWindowedUnread.filter(
      ([id, timestamp]) =>
        compareMessageTuple(
          { timestamp, id },
          {
            timestamp: tail == null ? null : messageOrderTimestamp(tail[1], feed.messageSortBy),
            id: currentTailId,
          },
        ) <= 0,
    ).length;
    // Preview already counts beyond the loaded tail (includes buffered pending).
    return loadedUnread + windowedUnreadBeforeOrAtTail + Math.max(0, preview.count);
  }

  const trimmedUnread = comparableWindowedUnread.length;
  const includeResidual = options?.includeBeyondTailResidual !== false;
  const beyondTailPending = includeResidual
    ? Math.max(0, feed.unreadCount - loadedUnread - pendingUnread - trimmedUnread)
    : 0;
  return loadedUnread + pendingUnread + trimmedUnread + beyondTailPending;
}

/** Sum of {@link feedUnreadDisplayCount} across all feeds. */
export function feedsUnreadDisplayTotal(feeds: MessageFeedState[]): number {
  return feeds.reduce((sum, feed) => sum + feedUnreadDisplayCount(feed), 0);
}

/** Backward-compatible alias for the column “new messages” FAB chip. */
export function feedColumnUnreadDisplayed(feed: MessageFeedState): number {
  return feedUnreadDisplayCount(feed);
}

export function toQueryState(messageFeeds: MessageFeedState[]): RerDutyState {
  return {
    messageFeeds: messageFeeds.map((f) => [
      f.id,
      f.filter,
      {
        adjacentFreqsRange: f.adjacentFreqsRange,
        highlightSignalsEnabled: f.highlightSignalsEnabled,
        onlyMyUnitTagsEnabled: f.onlyMyUnitTagsEnabled,
      },
    ]),
  };
}

export function parseDutyMessageUidFromWindow(): string | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const param =
    url.searchParams.get('m') || url.searchParams.get('mid') || url.searchParams.get('messageUid');
  const trimmed = param?.trim();
  return trimmed && trimmed !== '' ? trimmed : null;
}

export function resolveDutyTargetMessageIds(
  identifier: string,
  contextMessageIds: number[],
): number[] {
  if (!/^\d+$/.test(identifier)) return contextMessageIds;
  const exactId = Number(identifier);
  return Number.isSafeInteger(exactId) && contextMessageIds.includes(exactId)
    ? [exactId]
    : contextMessageIds;
}
