import dayjs from 'dayjs';

import type {
  AnalysisStatsReq,
  InboxMessage,
  InboxMessagesReq,
  SavedFilter,
} from '../../../../Bindings';
import {
  parseRerAnalysisQueryStateFromSearchParams,
  writeRerAnalysisQueryStateToSearchParams,
} from '../../../rer-analysis-query-state';
import {
  APP_TIME_ZONE,
  combineDateTimeToMs,
  combineDateTimeInputToMs,
  formatDateTimeInputValueInTimeZone,
  isNullOrUndefined,
} from '../../utils/misc';
import { LeftPanelTab } from './types';
import { normalizeUnknownUnitSelections } from '../shared/analysis-unit-filter';
import { normalizeCallsignFilterValues } from '../../utils/callsign-normalization';
import {
  UNIT_FILTER_UNSET_ID,
  getCanonicalUnitIdValue,
  getUnitIdFilterValue,
} from '../../utils/unit-search';
import {
  buildUnitHierarchyIndex,
  expandUnitSelections,
  isUnitParentValue,
} from '../shared/unit-children-filter';
import type { AnalysisQueryState } from './types';
import type { GroupScope } from '../shared/group-navigation';

export const ANALYSIS_ROUTE_PAGE_ID = 'rer-analysis-neo';
export const ANALYSIS_MESSAGES_PAGE_SIZE = 20;
export const ANALYSIS_MESSAGE_WINDOW_LIMIT = 40;

export function getFirstLoadedMessagesPageIndex(
  lastLoadedPageIndex: number,
  messagesCount: number,
): number {
  const loadedPageCount = Math.max(1, Math.ceil(messagesCount / ANALYSIS_MESSAGES_PAGE_SIZE));
  return Math.max(0, lastLoadedPageIndex - loadedPageCount + 1);
}

// Keep old and new analysis pages grouped in session activity while both coexist.
export const ANALYSIS_SESSION_ACTIVITY_PAGE_ID = 'rer-analysis';
export const ADJACENT_FREQS_RANGE_OPTIONS = [0, 0.0005, 0.002, 0.005] as const;
const ONLY_WITH_MEDIA_PARAM = 'only_with_media';
const LEFT_PANEL_OPEN_PARAM = 'leftPanelOpen';
const RIGHT_PANEL_OPEN_PARAM = 'rightPanelOpen';
const FILTER_PANEL_OPEN_PARAM = 'filterPanelOpen';
const MESSAGES_PAGE_PARAM = 'messagesPage';
const GROUP_SCOPE_PARAM = 'group';
const LEFT_PANEL_TAB_PARAM = 'leftPanelTab';
const MESSENGER_ACCOUNT_PARAM = 'messengerAccount';
const MESSENGER_CHAT_PARAM = 'messengerChat';
// The first message the reader has in view in an analysis messenger chat; reopening the URL starts the chat there.
const MESSENGER_ANCHOR_PARAM = 'messengerAnchor';
// A view of the account other than a chat, e.g. `contacts`. The chat and the view exclude each other.
const MESSENGER_VIEW_PARAM = 'messengerView';
const MESSENGER_VIEWS = ['contacts', 'gallery'] as const;
const MESSENGER_PANEL_PARAM = 'messengerPanel';
const MESSENGER_PANEL_TABS = ['media', 'members'] as const;

export type AnalysisPanelQueryState = {
  leftPanelOpen: boolean | null;
  rightPanelOpen: boolean | null;
  filterPanelOpen: boolean | null;
};

function partitionUnitSelections(values: readonly string[]): {
  ids: number[];
  legacy: string[];
} {
  const ids: number[] = [];
  const legacy: string[] = [];
  values.forEach((value) => {
    const unitId = getCanonicalUnitIdValue(value);
    if (unitId !== null) {
      ids.push(unitId);
    } else {
      legacy.push(value);
    }
  });
  return { ids: [...new Set(ids)], legacy: [...new Set(legacy)] };
}

/** Duty / deep links append `?showMap=true` so the map center tab opens (see `buildRerAnalysisNeoHref` in rer-duty-neo). */
export function shouldOpenAnalysisMapFromSearchParams(searchParams: URLSearchParams): boolean {
  const v = searchParams.get('showMap');
  return v === 'true';
}

function parseOptionalBooleanParam(value: string | null): boolean | null {
  if (value == null) return null;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

function findAllAdjacentFreqs(
  allFrequencies: string[],
  selectedFrequencies: string[],
  range: number,
): string[] {
  if (range <= 0) return [];
  return allFrequencies.filter((freq) => {
    if (selectedFrequencies.includes(freq)) return false;
    const freqN = parseFloat(freq);
    if (Number.isNaN(freqN)) return false;
    return selectedFrequencies.some((selected) => {
      const selectedN = parseFloat(selected);
      if (Number.isNaN(selectedN)) return false;
      return freqN >= selectedN - range && freqN <= selectedN + range;
    });
  });
}

export function emptyQueryState(): AnalysisQueryState {
  return {
    fromDateTimeStr: '',
    toDateTimeStr: '',
    includeOnlyNewFreqs: false,
    aorsSelected: [],
    groupsSelected: [],
    sendersSelected: [],
    freqsSelected: [],
    callsignsSelected: [],
    unitsSelected: [],
    unitsIncludeChildren: true,
    deviceNamesSelected: [],
    locationsSelected: [],
    postsSelected: [],
    networksSelected: [],
    withoutNetwork: false,
    onlyWithNetwork: false,
    orWithExtendedForm: false,
    orBookmarked: false,
    orImportant: false,
    orWithCoords: false,
    orWithoutCoords: false,
    search: '',
    searchMode: 'Fuzzy',
    metadataCc: [],
    metadataSender: [],
    metadataReceiver: [],
    metadataHash: [],
    onlyWithMetadata: false,
    withoutMetadata: false,
    tags: [],
    includePelengLocations: true,
    // Important: `null` means "use the server-side default".
    // Neo must preserve this tri-state instead of hard-coding exact-match mode.
    unitsExactMatchOnly: null,
    adjacentFreqsRange: 0,
    withoutModelTags: false,
    filterTagsOption: 'OneOfTags',
    tagsExcludeMode: false,
    reportTagsOnlyThisUnit: false,
    onlyWithMedia: false,
  };
}

function getDefaultAnalysisDateRange(
  now: Date,
  radioFeaturesAllowed: boolean,
): {
  fromDateTimeStr: string;
  toDateTimeStr: string;
} {
  const startOfTodayInAppTz = dayjs(now).tz(APP_TIME_ZONE).startOf('day');
  const startOfTomorrowInAppTz = startOfTodayInAppTz.add(1, 'day');

  return {
    fromDateTimeStr: startOfTomorrowInAppTz
      .subtract(radioFeaturesAllowed ? 1 : 90, 'day')
      .format('YYYY-MM-DDTHH:mm'),
    toDateTimeStr: startOfTomorrowInAppTz.format('YYYY-MM-DDTHH:mm'),
  };
}

export function parseQueryStateFromWindow(): AnalysisQueryState {
  if (typeof window === 'undefined') return emptyQueryState();

  const url = new URL(window.location.href);
  const flatStateFromUrl = parseRerAnalysisQueryStateFromSearchParams(url.searchParams);
  const onlyWithMedia = parseOptionalBooleanParam(url.searchParams.get(ONLY_WITH_MEDIA_PARAM));

  return {
    ...emptyQueryState(),
    ...(flatStateFromUrl ?? {}),
    ...(onlyWithMedia != null ? { onlyWithMedia } : {}),
  };
}

export function parseNewestFirstFromWindow(): boolean {
  if (typeof window === 'undefined') return true;
  const url = new URL(window.location.href);
  const param = url.searchParams.get('newestFirst');
  return param !== 'false';
}

export function parseMessagesPageIndexFromWindow(): number {
  if (typeof window === 'undefined') return 0;
  const value = Number(new URL(window.location.href).searchParams.get(MESSAGES_PAGE_PARAM));
  return Number.isSafeInteger(value) && value >= 1 ? value - 1 : 0;
}

export function writeMessagesPageIndexToWindowUrl(pageIndex: number): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const normalizedPageIndex = Math.max(0, Math.floor(pageIndex));
  if (normalizedPageIndex === 0) {
    url.searchParams.delete(MESSAGES_PAGE_PARAM);
  } else {
    url.searchParams.set(MESSAGES_PAGE_PARAM, String(normalizedPageIndex + 1));
  }
  const query = url.searchParams.toString();
  // Keep the current history state: an open attachment preview owns this entry's overlay layer.
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}${query === '' ? '' : `?${query}`}${url.hash}`,
  );
}

export function parseAnalysisPanelQueryStateFromWindow(): AnalysisPanelQueryState {
  if (typeof window === 'undefined') {
    return { leftPanelOpen: null, rightPanelOpen: null, filterPanelOpen: null };
  }
  const searchParams = new URL(window.location.href).searchParams;
  return {
    leftPanelOpen: parseOptionalBooleanParam(searchParams.get(LEFT_PANEL_OPEN_PARAM)),
    rightPanelOpen: parseOptionalBooleanParam(searchParams.get(RIGHT_PANEL_OPEN_PARAM)),
    filterPanelOpen: parseOptionalBooleanParam(searchParams.get(FILTER_PANEL_OPEN_PARAM)),
  };
}

function writeAnalysisPanelQueryState(
  searchParams: URLSearchParams,
  state: Partial<AnalysisPanelQueryState>,
) {
  if (state.leftPanelOpen != null)
    searchParams.set(LEFT_PANEL_OPEN_PARAM, String(state.leftPanelOpen));
  if (state.rightPanelOpen != null)
    searchParams.set(RIGHT_PANEL_OPEN_PARAM, String(state.rightPanelOpen));
  if (state.filterPanelOpen != null)
    searchParams.set(FILTER_PANEL_OPEN_PARAM, String(state.filterPanelOpen));
}

export function replaceAnalysisPanelQueryStateInUrl(state: Partial<AnalysisPanelQueryState>) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  writeAnalysisPanelQueryState(url.searchParams, state);
  window.history.replaceState({}, '', `${url.pathname}?${url.searchParams.toString()}${url.hash}`);
}

export type MessengerQueryState = {
  leftPanelTab: LeftPanelTab;
  messengerAccountId: string | null;
};

// The account only means something inside the analysis messenger tab, so it is ignored elsewhere.
export function parseMessengerQueryStateFromWindow(): MessengerQueryState {
  if (typeof window === 'undefined') {
    return { leftPanelTab: LeftPanelTab.EchoGroups, messengerAccountId: null };
  }
  const searchParams = new URL(window.location.href).searchParams;
  if (searchParams.get(LEFT_PANEL_TAB_PARAM) !== LeftPanelTab.Messenger) {
    return { leftPanelTab: LeftPanelTab.EchoGroups, messengerAccountId: null };
  }
  return {
    leftPanelTab: LeftPanelTab.Messenger,
    messengerAccountId: searchParams.get(MESSENGER_ACCOUNT_PARAM)?.trim() || null,
  };
}

export function replaceMessengerQueryStateInUrl(state: MessengerQueryState): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (state.leftPanelTab === LeftPanelTab.Messenger) {
    url.searchParams.set(LEFT_PANEL_TAB_PARAM, state.leftPanelTab);
    // The chat belongs to its account, so another account never inherits it.
    if (url.searchParams.get(MESSENGER_ACCOUNT_PARAM) !== state.messengerAccountId) {
      url.searchParams.delete(MESSENGER_CHAT_PARAM);
      url.searchParams.delete(MESSENGER_ANCHOR_PARAM);
      url.searchParams.delete(MESSENGER_VIEW_PARAM);
      url.searchParams.delete(MESSENGER_PANEL_PARAM);
    }
    if (state.messengerAccountId == null) url.searchParams.delete(MESSENGER_ACCOUNT_PARAM);
    else url.searchParams.set(MESSENGER_ACCOUNT_PARAM, state.messengerAccountId);
  } else {
    url.searchParams.delete(LEFT_PANEL_TAB_PARAM);
    url.searchParams.delete(MESSENGER_ACCOUNT_PARAM);
    url.searchParams.delete(MESSENGER_CHAT_PARAM);
    url.searchParams.delete(MESSENGER_ANCHOR_PARAM);
    url.searchParams.delete(MESSENGER_VIEW_PARAM);
    url.searchParams.delete(MESSENGER_PANEL_PARAM);
  }
  const query = url.searchParams.toString();
  const href = `${url.pathname}${query === '' ? '' : `?${query}`}${url.hash}`;
  if (href === `${window.location.pathname}${window.location.search}${url.hash}`) return;
  // Keep the current history state: an open overlay owns this entry's layer.
  window.history.replaceState(window.history.state, '', href);
}

export function readAnalysisGroupScopeFromUrl(): GroupScope {
  if (typeof window === 'undefined') return { kind: 'all' };
  const masterKey = new URL(window.location.href).searchParams.get(GROUP_SCOPE_PARAM)?.trim();
  return masterKey ? { kind: 'group', masterKey } : { kind: 'all' };
}

export function writeAnalysisGroupScopeToUrl(
  scope: GroupScope,
  options: { replace?: boolean } = {},
): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (scope.kind === 'group') url.searchParams.set(GROUP_SCOPE_PARAM, scope.masterKey);
  else url.searchParams.delete(GROUP_SCOPE_PARAM);
  const href = `${url.pathname}${url.search}${url.hash}`;
  if (options.replace) window.history.replaceState({}, '', href);
  else window.history.pushState({}, '', href);
}

export {
  readLinkedMessageReferenceFromWindow as parseMessageUidFromWindow,
  removeLinkedMessageReferenceFromWindowUrl as removeMessageUidFromWindowUrl,
} from '../shared/message-navigation/message-navigation-url';

export function createInitialQueryState(
  parsed: AnalysisQueryState,
  now: Date = new Date(),
  radioFeaturesAllowed: boolean = false,
): AnalysisQueryState {
  if (parsed.fromDateTimeStr !== '' && parsed.toDateTimeStr !== '')
    return normalizeQueryState(parsed);

  const defaultDateRange = getDefaultAnalysisDateRange(now, radioFeaturesAllowed);
  return normalizeQueryState({
    ...emptyQueryState(),
    ...parsed,
    fromDateTimeStr: parsed.fromDateTimeStr || defaultDateRange.fromDateTimeStr,
    toDateTimeStr: parsed.toDateTimeStr || defaultDateRange.toDateTimeStr,
  });
}

export function createResetQueryState(
  now: Date = new Date(),
  radioFeaturesAllowed: boolean = false,
): AnalysisQueryState {
  return createInitialQueryState(emptyQueryState(), now, radioFeaturesAllowed);
}

type DirectLinkMessageTime = Pick<
  InboxMessage,
  'date' | 'time' | 'isTimeNull' | 'timestamp' | 'createdAt'
>;

function directMessageTimeMs(
  message: DirectLinkMessageTime,
  messageTimeBasis: AnalysisQueryState['messageTimeBasis'],
): number | null {
  if (messageTimeBasis === 'creation') {
    return message.createdAt != null && Number.isFinite(message.createdAt)
      ? message.createdAt
      : null;
  }
  if (message.date != null) {
    const date = message.date.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, '$3-$2-$1');
    const timestamp = combineDateTimeToMs(
      date,
      message.isTimeNull === true ? '00:00' : message.time?.slice(0, 5) || '00:00',
      APP_TIME_ZONE,
    );
    if (timestamp != null) return timestamp;
  }
  return message.timestamp != null && Number.isFinite(message.timestamp) ? message.timestamp : null;
}

function centeredDirectMessageRange(
  state: AnalysisQueryState,
  messageTimeMs: number,
  durationMs: number,
): Pick<AnalysisQueryState, 'fromDateTimeStr' | 'toDateTimeStr'> {
  if (state.fromDateTimeStr.endsWith('T00:00') && state.toDateTimeStr.endsWith('T00:00')) {
    const days = dayjs.utc(state.toDateTimeStr).diff(dayjs.utc(state.fromDateTimeStr), 'day');
    const messageDate = dayjs(messageTimeMs).tz(APP_TIME_ZONE).format('YYYY-MM-DD');
    const start = dayjs.utc(messageDate).subtract(Math.floor(days / 2), 'day');
    return {
      fromDateTimeStr: start.format('YYYY-MM-DDTHH:mm'),
      toDateTimeStr: start.add(days, 'day').format('YYYY-MM-DDTHH:mm'),
    };
  }
  const startMs = dayjs(messageTimeMs)
    .startOf('minute')
    .subtract(Math.floor(durationMs / 60_000 / 2), 'minute')
    .valueOf();
  return {
    fromDateTimeStr: formatDateTimeInputValueInTimeZone(new Date(startMs), APP_TIME_ZONE),
    toDateTimeStr: formatDateTimeInputValueInTimeZone(
      new Date(startMs + durationMs),
      APP_TIME_ZONE,
    ),
  };
}

export function adjustQueryDateRangeForDirectMessage(
  state: AnalysisQueryState,
  message: DirectLinkMessageTime,
): AnalysisQueryState {
  const messageTimeMs = directMessageTimeMs(message, state.messageTimeBasis);
  const rangeStartMs = combineDateTimeInputToMs(state.fromDateTimeStr, APP_TIME_ZONE);
  const rangeEndMs = combineDateTimeInputToMs(state.toDateTimeStr, APP_TIME_ZONE);
  if (
    messageTimeMs == null ||
    rangeStartMs == null ||
    rangeEndMs == null ||
    rangeStartMs >= rangeEndMs ||
    (messageTimeMs >= rangeStartMs && messageTimeMs < rangeEndMs)
  ) {
    return state;
  }
  return {
    ...state,
    ...centeredDirectMessageRange(state, messageTimeMs, rangeEndMs - rangeStartMs),
  };
}

export function hasMeaningfulFiltersBeyondDateRange(state: AnalysisQueryState): boolean {
  const stateKey = queryStateComparisonKey(state);
  const defaultKey = queryStateComparisonKey(createResetQueryState());
  if (isNullOrUndefined(stateKey) || isNullOrUndefined(defaultKey)) return false;

  return stateKey !== defaultKey;
}

export function hasMeaningfulUiFiltersBeyondDateRange(state: AnalysisQueryState): boolean {
  const stateKey = queryStateUiComparisonKey(state);
  const defaultKey = queryStateUiComparisonKey(createResetQueryState());
  if (isNullOrUndefined(stateKey) || isNullOrUndefined(defaultKey)) return false;

  return stateKey !== defaultKey;
}

export function pushQueryStateToUrl(
  state: AnalysisQueryState,
  newestFirst: boolean = true,
  panelState?: Partial<AnalysisPanelQueryState>,
) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.delete(GROUP_SCOPE_PARAM);
  writeRerAnalysisQueryStateToSearchParams(url.searchParams, state);
  if (state.onlyWithMedia) {
    url.searchParams.set(ONLY_WITH_MEDIA_PARAM, 'true');
  } else {
    url.searchParams.delete(ONLY_WITH_MEDIA_PARAM);
  }
  if (!newestFirst) {
    url.searchParams.set('newestFirst', 'false');
  } else {
    url.searchParams.delete('newestFirst');
  }
  if (panelState) {
    writeAnalysisPanelQueryState(url.searchParams, panelState);
  }
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}?${url.searchParams.toString()}`,
  );
}

// Compares query states by the filter params they write to the URL, so a history entry
// can be matched against the state that produced it.
export function analysisQueryStateUrlKey(state: AnalysisQueryState): string {
  const searchParams = new URLSearchParams();
  writeRerAnalysisQueryStateToSearchParams(searchParams, state);
  if (state.onlyWithMedia) searchParams.set(ONLY_WITH_MEDIA_PARAM, 'true');
  searchParams.sort();
  return searchParams.toString();
}

export function normalizeQueryState(state: AnalysisQueryState): AnalysisQueryState {
  let next = state;

  if (
    next.searchMode !== 'Exact' &&
    next.searchMode !== 'Substring' &&
    next.searchMode !== 'Fuzzy'
  ) {
    next = { ...next, searchMode: 'Fuzzy' };
  }

  if (state.withoutMetadata) {
    next = {
      ...next,
      metadataCc: [],
      metadataSender: [],
      metadataReceiver: [],
      metadataHash: [],
      onlyWithMetadata: false,
    };
  }

  if (next.onlyWithMetadata) {
    next = { ...next, withoutMetadata: false };
  }

  if (next.withoutNetwork) {
    next = { ...next, networksSelected: [] };
  }

  if (next.orWithCoords && next.orWithoutCoords) {
    next = { ...next, orWithCoords: false, orWithoutCoords: false };
  }

  return {
    ...next,
    unitsIncludeChildren: true,
    callsignsSelected: normalizeCallsignFilterValues(next.callsignsSelected),
    unitsSelected: normalizeUnknownUnitSelections(next.unitsSelected),
  };
}

export function buildAnalysisReq(
  state: AnalysisQueryState,
  allFrequencies: string[] = [],
): AnalysisStatsReq | null {
  const query = normalizeQueryState(state);
  if (!query.unitHierarchy && query.unitsSelected.length > 0) return null;
  const sinceDateInclusiveMs = combineDateTimeInputToMs(query.fromDateTimeStr ?? '', APP_TIME_ZONE);
  const tillDateNoninclusiveMs = combineDateTimeInputToMs(query.toDateTimeStr ?? '', APP_TIME_ZONE);

  if (
    isNullOrUndefined(sinceDateInclusiveMs) ||
    isNullOrUndefined(tillDateNoninclusiveMs) ||
    sinceDateInclusiveMs > tillDateNoninclusiveMs
  ) {
    return null;
  }

  const expandedFreqs =
    query.adjacentFreqsRange > 0
      ? Array.from(
          new Set([
            ...query.freqsSelected,
            ...findAllAdjacentFreqs(allFrequencies, query.freqsSelected, query.adjacentFreqsRange),
          ]),
        )
      : query.freqsSelected;
  const units = partitionUnitSelections(
    expandUnitSelections(query.unitsSelected, true, query.unitHierarchy),
  );

  return {
    sinceDateInclusiveMs,
    tillDateNoninclusiveMs,
    selectedGroups: query.groupsSelected.length ? query.groupsSelected : null,
    selectedSenders: query.sendersSelected.length ? query.sendersSelected : null,
    selectedFreqs: expandedFreqs.length ? expandedFreqs : null,
    selectedPosts: query.postsSelected.length ? query.postsSelected : null,
    selectedCallsigns: query.callsignsSelected.length ? query.callsignsSelected : null,
    selectedUnits: units.legacy.length ? units.legacy : null,
    selectedUnitIds: units.ids.length
      ? units.ids
      : query.unitsSelected.some(isUnitParentValue) && units.legacy.length === 0
        ? [UNIT_FILTER_UNSET_ID]
        : null,
    selectedDeviceNames: query.deviceNamesSelected.length ? query.deviceNamesSelected : null,
    selectedLocations: query.locationsSelected.length ? query.locationsSelected : null,
    selectedAors: query.aorsSelected.length
      ? query.aorsSelected.map((value) => Number(value)).filter(Number.isFinite)
      : null,
    orWithExtendedForm: query.orWithExtendedForm,
    orBookmarked: query.orBookmarked,
    orImportant: query.orImportant,
    orWithCoords: query.orWithCoords,
    orWithoutCoords: query.orWithoutCoords,
    search: query.search.trim() === '' ? null : query.search.trim(),
    searchMode: query.searchMode ?? null,
    selectedTags: query.tags.length && !query.tagsExcludeMode ? query.tags : null,
    deniedTags: query.tags.length && query.tagsExcludeMode ? query.tags : null,
    tagPresence: null,
    selectedNetworks: query.withoutNetwork
      ? null
      : query.networksSelected.map((value) => Number(value)).filter(Number.isFinite),
    withoutNetwork: query.withoutNetwork,
    onlyWithNetwork: null,
    onlyForRerReport: query.onlyWithNetwork,
    metadataCc: query.metadataCc.length ? query.metadataCc : null,
    metadataSender: query.metadataSender.length ? query.metadataSender : null,
    metadataReceiver: query.metadataReceiver.length ? query.metadataReceiver : null,
    metadataHash: query.metadataHash.length ? query.metadataHash : null,
    onlyWithMetadata: query.onlyWithMetadata,
    withoutMetadata: query.withoutMetadata,
    includePelengLocations: query.includePelengLocations,
    unitsExactMatchOnly: units.legacy.length ? query.unitsExactMatchOnly : null,
    filterTagsOption: query.filterTagsOption,
    withoutModelTags: query.withoutModelTags,
    reportTagsOnlyThisUnit: query.reportTagsOnlyThisUnit,
    // Generated TypeScript uses the Rust variant name, while the HTTP contract
    // intentionally serializes this enum as the stable lowercase wire value.
    messageTimeBasis: (query.messageTimeBasis === 'creation'
      ? 'creation'
      : null) as AnalysisStatsReq['messageTimeBasis'],
  };
}

export function buildSavedFilterReq(
  state: AnalysisQueryState,
  allFrequencies: string[] = [],
): AnalysisStatsReq | null {
  const req = buildAnalysisReq(state, allFrequencies);
  return isNullOrUndefined(req) ? null : { ...req, messageTimeBasis: null };
}

export function buildInboxReq(
  state: AnalysisQueryState,
  allFrequencies: string[] = [],
  // `onlyWithMedia` is intentionally opt-in: it filters only the Messages tab,
  // while map/report consumers should keep using the broader analysis request.
  includeOnlyWithMedia = false,
): InboxMessagesReq | null {
  const req = buildAnalysisReq(state, allFrequencies);
  if (isNullOrUndefined(req)) return null;

  return {
    sinceIdNoninclusive: null,
    beforeIdNoninclusive: null,
    aroundMessageRef: null,
    sinceDateInclusiveMs: req.sinceDateInclusiveMs,
    tillDateInclusiveMs: req.tillDateNoninclusiveMs,
    onlyShowUnprocessed: null,
    checkedOnly: false,
    selectedGroups: req.selectedGroups,
    deniedGroups: null,
    selectedSenders: req.selectedSenders,
    deniedSenders: null,
    selectedFreqs: req.selectedFreqs,
    selectedPosts: req.selectedPosts,
    deniedPosts: null,
    deniedFreqs: null,
    selectedCallsigns: req.selectedCallsigns,
    selectedUnits: req.selectedUnits,
    selectedUnitIds: req.selectedUnitIds,
    selectedDeviceNames: req.selectedDeviceNames,
    deniedDeviceNames: null,
    deniedUnits: null,
    deniedUnitIds: null,
    selectedLocations: req.selectedLocations,
    deniedLocations: null,
    nolimit: null,
    orWithExtendedForm: req.orWithExtendedForm,
    loadLatest: null,
    returnDuplicates: null,
    orBookmarked: req.orBookmarked,
    orImportant: req.orImportant,
    orWithCoords: req.orWithCoords,
    orWithoutCoords: req.orWithoutCoords,
    newestFirst: true,
    search: req.search,
    searchMode: req.searchMode,
    highlightCallsigns: true,
    highlightKeywords: true,
    highlightKeywordSetId: null,
    highlightSearchres: true,
    highlightSignals: null,
    highlightPoints: true,
    selectedTags: req.selectedTags,
    deniedTags: req.deniedTags,
    tagPresence: req.tagPresence,
    selectedAors: req.selectedAors,
    selectedNetworks: req.selectedNetworks,
    withoutNetwork: req.withoutNetwork,
    onlyWithNetwork: null,
    onlyForRerReport: req.onlyForRerReport ?? req.onlyWithNetwork,
    metadataCc: req.metadataCc,
    metadataSender: req.metadataSender,
    metadataReceiver: req.metadataReceiver,
    metadataHash: req.metadataHash,
    onlyWithMetadata: req.onlyWithMetadata,
    withoutMetadata: req.withoutMetadata,
    sortBy: state.messageTimeBasis === 'creation' ? 'IMSCreatedAt' : null,
    reportTagsOnlyThisUnit: req.reportTagsOnlyThisUnit,
    ignoreImportedCoords: null,
    includePelengLocations: req.includePelengLocations,
    unitsExactMatchOnly: req.unitsExactMatchOnly,
    calculateFreqPelengsSummary: null,
    skipGroupStats: true,
    filterTagsOption: req.filterTagsOption,
    pageId: ANALYSIS_SESSION_ACTIVITY_PAGE_ID,
    withoutModelTags: req.withoutModelTags,
    onlyWithMedia: includeOnlyWithMedia ? state.onlyWithMedia : false,
  };
}

export function buildInboxOverallCountReq(state: AnalysisQueryState): InboxMessagesReq | null {
  return buildInboxReq({
    ...emptyQueryState(),
    fromDateTimeStr: state.fromDateTimeStr,
    toDateTimeStr: state.toDateTimeStr,
    messageTimeBasis: state.messageTimeBasis,
  });
}

export function shouldRebuildAnalysisRequests(
  state: AnalysisQueryState,
  currentFrequencies: string[] = [],
  nextFrequencies: string[] = [],
): boolean {
  if (
    state.adjacentFreqsRange <= 0 ||
    state.freqsSelected.length === 0 ||
    nextFrequencies.length === 0
  ) {
    return false;
  }

  const currentReq = buildAnalysisReq(state, currentFrequencies);
  const nextReq = buildAnalysisReq(state, nextFrequencies);
  if (isNullOrUndefined(currentReq) || isNullOrUndefined(nextReq)) return false;

  return (
    JSON.stringify(currentReq.selectedFreqs ?? []) !== JSON.stringify(nextReq.selectedFreqs ?? [])
  );
}

export function queryStateFromSavedFilter(
  savedFilter: SavedFilter,
  current: AnalysisQueryState,
): AnalysisQueryState {
  const req = savedFilter.req;
  return normalizeQueryState({
    ...current,
    includeOnlyNewFreqs: false,
    adjacentFreqsRange: 0,
    aorsSelected: (req.selectedAors ?? []).map(String),
    groupsSelected: req.selectedGroups ?? [],
    sendersSelected: req.selectedSenders ?? [],
    freqsSelected: req.selectedFreqs ?? [],
    callsignsSelected: req.selectedCallsigns ?? [],
    unitsIncludeChildren: true,
    unitsSelected: savedFilter.unitFilter?.values ?? [
      ...(req.selectedUnitIds ?? []).map(getUnitIdFilterValue),
      ...(req.selectedUnits ?? []),
    ],
    deviceNamesSelected: req.selectedDeviceNames ?? [],
    locationsSelected: req.selectedLocations ?? [],
    postsSelected: req.selectedPosts ?? [],
    networksSelected: (req.selectedNetworks ?? []).map(String),
    withoutNetwork: req.withoutNetwork ?? false,
    onlyWithNetwork: req.onlyForRerReport ?? req.onlyWithNetwork ?? false,
    orWithExtendedForm: req.orWithExtendedForm ?? false,
    orBookmarked: req.orBookmarked ?? false,
    orImportant: req.orImportant ?? false,
    orWithCoords: req.orWithCoords ?? false,
    orWithoutCoords: req.orWithoutCoords ?? false,
    search: req.search ?? '',
    searchMode: req.searchMode ?? 'Fuzzy',
    metadataCc: req.metadataCc ?? [],
    metadataSender: req.metadataSender ?? [],
    metadataReceiver: req.metadataReceiver ?? [],
    metadataHash: req.metadataHash ?? [],
    onlyWithMetadata: req.onlyWithMetadata ?? false,
    withoutMetadata: req.withoutMetadata ?? false,
    tags: (req.deniedTags?.length ? req.deniedTags : req.selectedTags) ?? [],
    tagsExcludeMode: Boolean(req.deniedTags?.length),
    includePelengLocations: req.includePelengLocations ?? true,
    unitsExactMatchOnly: req.unitsExactMatchOnly,
    withoutModelTags: req.withoutModelTags ?? false,
    filterTagsOption: req.filterTagsOption ?? 'OneOfTags',
    reportTagsOnlyThisUnit: req.reportTagsOnlyThisUnit ?? false,
  });
}

function canonicalizeAnalysisReqToQueryState(req: AnalysisStatsReq): AnalysisQueryState {
  const normalized = { ...req };

  if (isNullOrUndefined(normalized.onlyWithMetadata)) {
    normalized.onlyWithMetadata = false;
  }
  if (isNullOrUndefined(normalized.withoutMetadata)) {
    normalized.withoutMetadata = false;
  }
  if (isNullOrUndefined(normalized.withoutNetwork)) {
    normalized.withoutNetwork = false;
  }
  if (isNullOrUndefined(normalized.onlyWithNetwork)) {
    normalized.onlyWithNetwork = false;
  }
  if (isNullOrUndefined(normalized.orWithExtendedForm)) {
    normalized.orWithExtendedForm = false;
  }
  if (isNullOrUndefined(normalized.orBookmarked)) {
    normalized.orBookmarked = false;
  }
  if (isNullOrUndefined(normalized.orImportant)) {
    normalized.orImportant = false;
  }
  if (isNullOrUndefined(normalized.orWithCoords)) {
    normalized.orWithCoords = false;
  }
  if (isNullOrUndefined(normalized.orWithoutCoords)) {
    normalized.orWithoutCoords = false;
  }
  if (isNullOrUndefined(normalized.includePelengLocations)) {
    normalized.includePelengLocations = true;
  }
  if (isNullOrUndefined(normalized.filterTagsOption)) {
    normalized.filterTagsOption = 'OneOfTags';
  }
  if (isNullOrUndefined(normalized.withoutModelTags)) {
    normalized.withoutModelTags = false;
  }
  if (isNullOrUndefined(normalized.reportTagsOnlyThisUnit)) {
    normalized.reportTagsOnlyThisUnit = false;
  }

  return normalizeQueryState({
    ...emptyQueryState(),
    unitHierarchy: buildUnitHierarchyIndex([]),
    includeOnlyNewFreqs: false,
    fromDateTimeStr: formatDateTimeInputValueInTimeZone(
      new Date(normalized.sinceDateInclusiveMs),
      APP_TIME_ZONE,
    ),
    toDateTimeStr: formatDateTimeInputValueInTimeZone(
      new Date(normalized.tillDateNoninclusiveMs),
      APP_TIME_ZONE,
    ),
    aorsSelected: (normalized.selectedAors ?? []).map(String),
    groupsSelected: normalized.selectedGroups ?? [],
    sendersSelected: normalized.selectedSenders ?? [],
    freqsSelected: normalized.selectedFreqs ?? [],
    callsignsSelected: normalized.selectedCallsigns ?? [],
    unitsSelected: [
      ...(normalized.selectedUnitIds ?? []).map(getUnitIdFilterValue),
      ...(normalized.selectedUnits ?? []),
    ],
    deviceNamesSelected: normalized.selectedDeviceNames ?? [],
    locationsSelected: normalized.selectedLocations ?? [],
    postsSelected: normalized.selectedPosts ?? [],
    networksSelected: (normalized.selectedNetworks ?? []).map(String),
    withoutNetwork: normalized.withoutNetwork,
    onlyWithNetwork: normalized.onlyForRerReport ?? normalized.onlyWithNetwork,
    orWithExtendedForm: normalized.orWithExtendedForm,
    orBookmarked: normalized.orBookmarked,
    orImportant: normalized.orImportant,
    orWithCoords: normalized.orWithCoords,
    orWithoutCoords: normalized.orWithoutCoords,
    search: normalized.search ?? '',
    searchMode: normalized.searchMode ?? 'Fuzzy',
    metadataCc: normalized.metadataCc ?? [],
    metadataSender: normalized.metadataSender ?? [],
    metadataReceiver: normalized.metadataReceiver ?? [],
    metadataHash: normalized.metadataHash ?? [],
    onlyWithMetadata: normalized.onlyWithMetadata,
    withoutMetadata: normalized.withoutMetadata,
    tags: (normalized.deniedTags?.length ? normalized.deniedTags : normalized.selectedTags) ?? [],
    tagsExcludeMode: Boolean(normalized.deniedTags?.length),
    includePelengLocations: normalized.includePelengLocations,
    unitsExactMatchOnly: normalized.unitsExactMatchOnly ?? null,
    withoutModelTags: normalized.withoutModelTags,
    filterTagsOption: normalized.filterTagsOption,
    reportTagsOnlyThisUnit: normalized.reportTagsOnlyThisUnit,
  });
}

function analysisReqComparisonKey(
  req: AnalysisStatsReq,
  allFrequencies: string[] = [],
): string | null {
  const normalized = buildAnalysisReq(canonicalizeAnalysisReqToQueryState(req), allFrequencies);
  if (isNullOrUndefined(normalized)) return null;

  const {
    sinceDateInclusiveMs: _sinceDateInclusiveMs,
    tillDateNoninclusiveMs: _tillDateNoninclusiveMs,
    messageTimeBasis: _messageTimeBasis,
    ...rest
  } = normalized;
  return JSON.stringify(rest);
}

export function queryStateComparisonKey(
  state: AnalysisQueryState,
  allFrequencies: string[] = [],
): string | null {
  const req = buildAnalysisReq(state, allFrequencies);
  if (isNullOrUndefined(req)) return null;

  return analysisReqComparisonKey(req, allFrequencies);
}

export function queryStateUiComparisonKey(
  state: AnalysisQueryState,
  allFrequencies: string[] = [],
): string | null {
  const analysisKey = queryStateComparisonKey(state, allFrequencies);
  if (isNullOrUndefined(analysisKey)) return null;

  return JSON.stringify({
    analysisKey,
    onlyWithMedia: state.onlyWithMedia,
  });
}

export function queryStateReloadKey(
  state: AnalysisQueryState,
  allFrequencies: string[] = [],
): string | null {
  const req = buildAnalysisReq(state, allFrequencies);
  if (isNullOrUndefined(req)) return null;

  return JSON.stringify(req);
}

export function queryStateMatchesSavedFilter(
  state: AnalysisQueryState,
  savedFilter: SavedFilter,
  allFrequencies: string[] = [],
): boolean {
  if (savedFilter.unitFilter) {
    const stateKey = queryStateComparisonKey(state, allFrequencies);
    const savedKey = queryStateComparisonKey(
      queryStateFromSavedFilter(savedFilter, state),
      allFrequencies,
    );
    return (
      stateKey !== null &&
      stateKey === savedKey &&
      JSON.stringify(state.unitsSelected) === JSON.stringify(savedFilter.unitFilter.values)
    );
  }
  const stateKey = queryStateComparisonKey(state, allFrequencies);
  const savedFilterKey = queryStateComparisonKey(
    queryStateFromSavedFilter(savedFilter, state),
    allFrequencies,
  );
  if (isNullOrUndefined(stateKey) || isNullOrUndefined(savedFilterKey)) return false;

  return stateKey === savedFilterKey;
}

export type MessengerChatQueryState = {
  chatId: string | null;
  anchorMessageId: string | null;
};

// The analysis messenger chat only counts for the account it was written with, so a stale link cannot open it elsewhere.
export function parseMessengerChatQueryFromWindow(accountId: string): MessengerChatQueryState {
  const none = { chatId: null, anchorMessageId: null };
  if (typeof window === 'undefined') return none;
  const searchParams = new URL(window.location.href).searchParams;
  if (searchParams.get(MESSENGER_ACCOUNT_PARAM)?.trim() !== accountId) return none;
  const chatId = searchParams.get(MESSENGER_CHAT_PARAM)?.trim() || null;
  if (chatId == null) return none;
  return { chatId, anchorMessageId: searchParams.get(MESSENGER_ANCHOR_PARAM)?.trim() || null };
}

// Position changes while reading, so this only ever replaces the history entry. After a navigation to
// another route the page may still be mounted for a moment, so only its own route is ever written.
export function replaceMessengerChatQueryInUrl(state: MessengerChatQueryState): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (url.pathname.replace(/\/+$/, '') !== `/${ANALYSIS_ROUTE_PAGE_ID}`) return;
  if (!url.searchParams.has(MESSENGER_ACCOUNT_PARAM)) return;
  const entries = [
    [MESSENGER_CHAT_PARAM, state.chatId],
    // Without a chat there is nothing to be positioned in.
    [MESSENGER_ANCHOR_PARAM, state.chatId == null ? null : state.anchorMessageId],
  ] as const;
  for (const [param, value] of entries) {
    if (value == null) url.searchParams.delete(param);
    else url.searchParams.set(param, value);
  }
  // A chat is open instead of a view.
  if (state.chatId != null) url.searchParams.delete(MESSENGER_VIEW_PARAM);
  const query = url.searchParams.toString();
  const href = `${url.pathname}${query === '' ? '' : `?${query}`}${url.hash}`;
  if (href === `${window.location.pathname}${window.location.search}${url.hash}`) return;
  window.history.replaceState(window.history.state, '', href);
}

// The messenger tables keep their sorting, filters and search in the URL (`TableStateProvider`). They are not for the
// echo tab, whose summary table reads the same params, so a messenger table clears them when it is left.
const TABLE_STATE_PARAMS = ['sorting', 'columnFilters', 'globalFilter'] as const;

export function clearTableQueryInUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (url.pathname.replace(/\/+$/, '') !== `/${ANALYSIS_ROUTE_PAGE_ID}`) return;
  for (const param of TABLE_STATE_PARAMS) url.searchParams.delete(param);
  const query = url.searchParams.toString();
  const href = `${url.pathname}${query === '' ? '' : `?${query}`}${url.hash}`;
  if (href === `${window.location.pathname}${window.location.search}${url.hash}`) return;
  window.history.replaceState(window.history.state, '', href);
}

export type MessengerView = (typeof MESSENGER_VIEWS)[number];

// The view of the account in the URL; it only counts for that account, and a chat in the URL wins.
export function parseMessengerViewFromWindow(accountId: string): MessengerView | null {
  if (typeof window === 'undefined') return null;
  const searchParams = new URL(window.location.href).searchParams;
  if (searchParams.get(MESSENGER_ACCOUNT_PARAM)?.trim() !== accountId) return null;
  if (searchParams.get(MESSENGER_CHAT_PARAM)?.trim()) return null;
  const view = searchParams.get(MESSENGER_VIEW_PARAM)?.trim();
  return MESSENGER_VIEWS.find((known) => known === view) ?? null;
}

// Opening a view leaves the chat; closing it leaves the account. Only the analysis route is ever written.
export function replaceMessengerViewInUrl(view: MessengerView | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (url.pathname.replace(/\/+$/, '') !== `/${ANALYSIS_ROUTE_PAGE_ID}`) return;
  if (!url.searchParams.has(MESSENGER_ACCOUNT_PARAM)) return;
  if (view == null) {
    url.searchParams.delete(MESSENGER_VIEW_PARAM);
  } else {
    url.searchParams.set(MESSENGER_VIEW_PARAM, view);
    url.searchParams.delete(MESSENGER_CHAT_PARAM);
    url.searchParams.delete(MESSENGER_ANCHOR_PARAM);
  }
  const query = url.searchParams.toString();
  const href = `${url.pathname}${query === '' ? '' : `?${query}`}${url.hash}`;
  if (href === `${window.location.pathname}${window.location.search}${url.hash}`) return;
  window.history.replaceState(window.history.state, '', href);
}

export type MessengerPanelTab = (typeof MESSENGER_PANEL_TABS)[number];

// The open tab of the messenger right panel; the param only exists while that panel is open.
export function parseMessengerPanelTabFromWindow(): MessengerPanelTab | null {
  if (typeof window === 'undefined') return null;
  const tab = new URL(window.location.href).searchParams.get(MESSENGER_PANEL_PARAM)?.trim();
  return MESSENGER_PANEL_TABS.find((known) => known === tab) ?? null;
}

// Only the analysis route in messenger mode is ever written. `null` removes the param.
export function replaceMessengerPanelTabInUrl(tab: MessengerPanelTab | null): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (url.pathname.replace(/\/+$/, '') !== `/${ANALYSIS_ROUTE_PAGE_ID}`) return;
  if (!url.searchParams.has(MESSENGER_ACCOUNT_PARAM)) return;
  if (tab == null) url.searchParams.delete(MESSENGER_PANEL_PARAM);
  else url.searchParams.set(MESSENGER_PANEL_PARAM, tab);
  const query = url.searchParams.toString();
  const href = `${url.pathname}${query === '' ? '' : `?${query}`}${url.hash}`;
  if (href === `${window.location.pathname}${window.location.search}${url.hash}`) return;
  window.history.replaceState(window.history.state, '', href);
}

// A shareable URL that opens the analysis messenger chat at the given message.
export function buildMessengerChatLink(chatId: string, anchorMessageId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set(MESSENGER_CHAT_PARAM, chatId);
  url.searchParams.set(MESSENGER_ANCHOR_PARAM, anchorMessageId);
  return url.toString();
}
