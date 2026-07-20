/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildAnalysisHref,
  buildClassicAnalysisHref,
  buildClassicAnalysisMapHrefWithSearch,
  buildVisibleExcludeMenuOptions,
  excludeMessageEntityFromFilters,
  PAGE_ID,
  appendWindowedMessageItems,
  buildAnalysisMapHrefWithSearch,
  buildSenderOptions,
  buildInboxReq,
  createMasterUnitText,
  emptyFilter,
  etalonFallbackWhenNoNetworks,
  filtersEqual,
  findAllAdjacentFreqs,
  feedIndicatorUnreadCount,
  feedUnreadDisplayCount,
  feedLoadedUnreadCount,
  feedsUnreadDisplayTotal,
  getPointEtalonsFromMessage,
  getShortStateIdFromUrl,
  isMessageEntityExcluded,
  messageHasPalitraTag,
  normalizeFeed,
  prependWindowedMessageItems,
  retainReadIdsForItems,
  uniquePointEtalonsForMapSearch,
  parseStateFromUrl,
  pushShortStateToUrl,
  pushStateToUrl,
  toRerDutyStateFromShort,
  toShortQueryState,
  windowInitialMessageItems,
} from './utils';
import type { MessageFeedState } from './utils';
import type { InboxMessage, Network, SignalProfileEntry, Tag, Unit } from '../../../../Bindings';

function indicatorFeed(overrides: Partial<MessageFeedState>): MessageFeedState {
  return {
    id: 'mf-0',
    filter: emptyFilter(),
    items: [],
    loading: false,
    loadingOlder: false,
    hasReachedStart: false,
    referenceTimeMs: null,
    readIds: new Set<number>(),
    unreadCount: 0,
    adjacentFreqsRange: 0,
    highlightSignalsEnabled: false,
    onlyMyUnitTagsEnabled: false,
    ...overrides,
  };
}

describe('rer-duty utils', () => {
  it('etalon fallback when no networks: unit vs strict', () => {
    const base = { freq: '100.0' } as InboxMessage;
    expect(etalonFallbackWhenNoNetworks({ ...base, unit: '  1-й танк  ' })).toBe('1-й танк');
    expect(etalonFallbackWhenNoNetworks({ ...base, unit: null })).toBe('Не встановлена');
    expect(
      etalonFallbackWhenNoNetworks({ ...base, unit: 'x' }, { featureStrictNetworks: true }),
    ).toBe('Не встановлена');
    expect(etalonFallbackWhenNoNetworks({ freq: null, unit: 'unit' } as InboxMessage)).toBe(null);
  });

  it('writes short state ids and clears the long state param', () => {
    const state = { messageFeeds: [['mf-1', { ...emptyFilter(), groupsSelected: ['g-1'] }]] };
    pushStateToUrl(state);
    expect(window.location.search).toContain('state=');

    pushShortStateToUrl('short-123');
    const params = new URLSearchParams(window.location.search);
    expect(params.get('state')).toBeNull();
    expect(params.get('state-short')).toBe('short-123');
    expect(getShortStateIdFromUrl()).toBe('short-123');
  });

  it('returns null when no short state id is present', () => {
    window.history.replaceState({}, '', '/');
    expect(getShortStateIdFromUrl()).toBeNull();
  });

  it('converts between short query state and rer-duty state', () => {
    const feeds = [
      {
        id: 'mf-1',
        filter: {
          ...emptyFilter(),
          freqsSelected: ['100.1'],
          groupsDenied: ['group-a'],
          freqsDenied: ['200.1'],
        },
        items: [],
        loading: false,
        loadingOlder: false,
        hasReachedStart: false,
        referenceTimeMs: null,
        readIds: new Set<number>(),
        unreadCount: 0,
        adjacentFreqsRange: 0,
        highlightSignalsEnabled: false,
        onlyMyUnitTagsEnabled: false,
      },
    ];
    const shortState = toShortQueryState(feeds);
    const restored = toRerDutyStateFromShort(shortState);
    expect(restored.messageFeeds).toEqual([
      [
        'mf-1',
        {
          ...emptyFilter(),
          freqsSelected: ['100.1'],
          groupsDenied: ['group-a'],
          freqsDenied: ['200.1'],
        },
      ],
    ]);
  });

  it('keeps default feeds when short waterfalls are empty or invalid', () => {
    expect(toRerDutyStateFromShort({ waterfalls: [] }).messageFeeds).toEqual([
      ['mf-0', emptyFilter()],
    ]);
    expect(toRerDutyStateFromShort({ waterfalls: [null as any] }).messageFeeds).toHaveLength(1);
  });

  it('serializes short query state with nulls and arrays', () => {
    const feeds = [
      {
        id: 'mf-1',
        filter: {
          ...emptyFilter(),
          groupsSelected: null,
          groupsDenied: ['group-a'],
          sendersSelected: ['sender-1'],
          freqsDenied: ['200.0'],
        },
        items: [],
        loading: false,
        loadingOlder: false,
        hasReachedStart: false,
        referenceTimeMs: null,
        readIds: new Set<number>(),
        unreadCount: 0,
        adjacentFreqsRange: 0,
        highlightSignalsEnabled: false,
        onlyMyUnitTagsEnabled: false,
      },
    ];
    expect(toShortQueryState(feeds)).toEqual({
      waterfalls: [
        [
          'mf-1',
          {
            ...emptyFilter(),
            groupsSelected: null,
            groupsDenied: ['group-a'],
            sendersSelected: ['sender-1'],
            freqsDenied: ['200.0'],
          },
        ],
      ],
    });
  });

  it('normalizes camelCase and snake_case feed payload keys', () => {
    const expected = {
      ...emptyFilter(),
      groupsSelected: ['group-a'],
      groupsDenied: ['group-b'],
      sendersSelected: ['sender-a'],
      deniedSenders: ['sender-b'],
      freqsSelected: ['100.0'],
      freqsDenied: ['200.0'],
      postsSelected: ['post-a'],
      postsDenied: ['post-b'],
      lastViewedMessageId: 42,
    };

    expect(
      normalizeFeed({
        groupsSelected: ['group-a'],
        groupsDenied: ['group-b'],
        sendersSelected: ['sender-a'],
        deniedSenders: ['sender-b'],
        freqsSelected: ['100.0'],
        freqsDenied: ['200.0'],
        postsSelected: ['post-a'],
        postsDenied: ['post-b'],
        lastViewedMessageId: 42,
      }),
    ).toEqual(expected);

    expect(
      normalizeFeed({
        groups_selected: ['group-a'],
        groups_denied: ['group-b'],
        senders_selected: ['sender-a'],
        denied_senders: ['sender-b'],
        freqs_selected: ['100.0'],
        freqs_denied: ['200.0'],
        posts_selected: ['post-a'],
        posts_denied: ['post-b'],
        last_viewed_message_id: 42,
      }),
    ).toEqual(expected);
  });

  it('builds network text with unit names and normalized location', () => {
    const network = {
      name: 'Alpha',
      unitIds: [1, 2],
      location: ' kyiv ',
    } as Network;
    const unitsMap = {
      1: { id: 1, name: 'Unit One' },
      2: { id: 2, name: 'Unit Two' },
    } as Record<number, Unit>;

    expect(createMasterUnitText(network, unitsMap)).toBe('р/м Alpha Unit One, Unit Two (KYIV)');
  });

  it('builds analysis deep links with combined datetime params', () => {
    const now = new Date('2026-04-21T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const msg = { freq: '154.845', messageUid: 'uid-1' } as InboxMessage;
      const href = buildAnalysisHref(msg, false);
      const url = new URL(href, 'https://example.test');

      expect(url.pathname).toBe('/rer-analysis-neo');
      expect(url.searchParams.get('fromDateTime')).toBe('2026-04-06T00:00');
      expect(url.searchParams.get('toDateTime')).toBe('2026-04-22T00:00');
      expect(url.searchParams.has('dateFrom')).toBe(false);
      expect(url.searchParams.has('timeFrom')).toBe(false);
      expect(url.searchParams.has('dateTo')).toBe(false);
      expect(url.searchParams.has('timeTo')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('builds classic analysis deep links with legacy state payloads', () => {
    const msg = { freq: '154.845', messageUid: 'uid-1' } as InboxMessage;

    const analysisHref = buildClassicAnalysisHref(msg, false);
    const analysisUrl = new URL(analysisHref, 'https://example.test');
    expect(analysisUrl.pathname).toBe('/rer-analysis');
    expect(analysisUrl.searchParams.get('showMap')).toBeNull();
    expect(JSON.parse(analysisUrl.searchParams.get('state') ?? '')).toMatchObject({
      search: 'uid-1',
      freqs_selected: ['154.845'],
    });

    const mapHref = buildClassicAnalysisMapHrefWithSearch(['P-1', 'P-1', 'P-2'], msg);
    const mapUrl = new URL(mapHref, 'https://example.test');
    expect(mapUrl.pathname).toBe('/rer-analysis');
    expect(mapUrl.searchParams.get('showMap')).toBe('true');
    expect(JSON.parse(mapUrl.searchParams.get('state') ?? '')).toMatchObject({
      search: 'P-1,P-2',
      freqs_selected: ['154.845'],
    });
  });

  it('distinguishes null and empty arrays when comparing filters', () => {
    expect(filtersEqual(emptyFilter(), emptyFilter())).toBe(true);
    expect(filtersEqual(emptyFilter(), { ...emptyFilter(), groupsSelected: [] })).toBe(false);
    expect(
      filtersEqual(
        { ...emptyFilter(), freqsSelected: ['100.1'] },
        { ...emptyFilter(), freqsSelected: ['100.1'] },
      ),
    ).toBe(true);
  });

  it('compares keyword highlight by set id in filtersEqual', () => {
    const base = emptyFilter();
    expect(
      filtersEqual(
        { ...base, highlightKeywordsEnabled: true, highlightKeywordSetId: 2 },
        { ...base, highlightKeywordsEnabled: false, highlightKeywordSetId: 2 },
      ),
    ).toBe(true);
    expect(
      filtersEqual({ ...base, highlightKeywordSetId: 1 }, { ...base, highlightKeywordSetId: 2 }),
    ).toBe(false);
  });

  it('buildInboxReq highlights when a keyword set is selected', () => {
    const req = buildInboxReq({
      filter: { ...emptyFilter(), highlightKeywordSetId: 5 },
    });
    expect(req.highlightKeywords).toBe(true);
    expect(req.highlightKeywordSetId).toBe(5);
  });

  it('buildInboxReq does not highlight when no keyword set is selected', () => {
    const req = buildInboxReq({
      filter: { ...emptyFilter(), highlightKeywordsEnabled: true, highlightKeywordSetId: null },
    });
    expect(req.highlightKeywords).toBe(false);
    expect(req.highlightKeywordSetId).toBeNull();
  });

  it('parseStateFromUrl reads keyword fields from wf state', () => {
    const state = {
      messageFeeds: [
        [
          'mf-1',
          {
            highlight_keywords_enabled: false,
            highlight_keyword_set_id: 3,
          },
        ],
      ],
    };
    window.history.replaceState({}, '', `/?state=${encodeURIComponent(JSON.stringify(state))}`);
    const parsed = parseStateFromUrl();
    expect(parsed.messageFeeds[0][1].highlightKeywordsEnabled).toBe(false);
    expect(parsed.messageFeeds[0][1].highlightKeywordSetId).toBe(3);
  });

  it('moves group filters from include to exclude and replaces the list', () => {
    const next = excludeMessageEntityFromFilters(
      { ...emptyFilter(), groupsSelected: ['group-a', 'group-b'], postsSelected: ['post-a'] },
      'group',
      'group-c',
    );

    expect(next.groupsSelected).toBeNull();
    expect(next.groupsDenied).toEqual(['group-c']);
    expect(next.postsSelected).toEqual(['post-a']);
    expect(next.postsDenied).toBeNull();
  });

  it('appends to existing sender excludes and avoids duplicates', () => {
    const initial = { ...emptyFilter(), deniedSenders: ['sender-a'] };
    const appended = excludeMessageEntityFromFilters(initial, 'sender', 'sender-b');
    const deduped = excludeMessageEntityFromFilters(appended, 'sender', 'sender-b');

    expect(appended.deniedSenders).toEqual(['sender-a', 'sender-b']);
    expect(deduped.deniedSenders).toEqual(['sender-a', 'sender-b']);
  });

  it('creates a fresh exclude filter from an empty state', () => {
    const next = excludeMessageEntityFromFilters(emptyFilter(), 'freq', '153.6250');

    expect(next.freqsSelected).toBeNull();
    expect(next.freqsDenied).toEqual(['153.6250']);
  });

  it('preserves unrelated filters while excluding a post', () => {
    const next = excludeMessageEntityFromFilters(
      {
        ...emptyFilter(),
        groupsSelected: ['group-a'],
        deniedSenders: ['sender-a'],
        freqsSelected: ['153.6250'],
      },
      'post',
      'post-a',
    );

    expect(next.groupsSelected).toEqual(['group-a']);
    expect(next.deniedSenders).toEqual(['sender-a']);
    expect(next.freqsSelected).toEqual(['153.6250']);
    expect(next.postsSelected).toBeNull();
    expect(next.postsDenied).toEqual(['post-a']);
  });

  it('reports whether a value is already excluded', () => {
    const filters = {
      ...emptyFilter(),
      groupsDenied: ['group-a'],
      deniedSenders: ['sender-a'],
      freqsDenied: ['153.6250'],
      postsDenied: ['post-a'],
    };

    expect(isMessageEntityExcluded(filters, 'group', 'group-a')).toBe(true);
    expect(isMessageEntityExcluded(filters, 'sender', 'sender-a')).toBe(true);
    expect(isMessageEntityExcluded(filters, 'freq', '153.6250')).toBe(true);
    expect(isMessageEntityExcluded(filters, 'post', 'post-a')).toBe(true);
    expect(isMessageEntityExcluded(filters, 'group', 'group-b')).toBe(false);
  });

  it('builds only visible exclude menu options', () => {
    const options = buildVisibleExcludeMenuOptions(
      {
        ...emptyFilter(),
        groupsDenied: ['group-a'],
        freqsDenied: ['153.6250'],
      },
      {
        group: { value: 'group-a', label: 'Група A' },
        sender: { value: 'sender-a', label: 'Відправник A' },
        freq: { value: '153.6250', label: '153.6250' },
        post: { value: 'post-a', label: 'Пост A' },
      },
    );

    expect(options).toEqual([
      { entity: 'sender', value: 'sender-a', label: 'Відправник A' },
      { entity: 'post', value: 'post-a', label: 'Пост A' },
    ]);
  });

  it('hides all exclude options when every visible entity is already excluded', () => {
    const options = buildVisibleExcludeMenuOptions(
      {
        ...emptyFilter(),
        groupsDenied: ['group-a'],
        deniedSenders: ['sender-a'],
        freqsDenied: ['153.6250'],
        postsDenied: ['post-a'],
      },
      {
        group: { value: 'group-a', label: 'Група A' },
        sender: { value: 'sender-a', label: 'Відправник A' },
        freq: { value: '153.6250', label: '153.6250' },
        post: { value: 'post-a', label: 'Пост A' },
      },
    );

    expect(options).toEqual([]);
  });

  it('expands adjacent frequencies without repeating already selected ones', () => {
    expect(
      findAllAdjacentFreqs(['100.000', '100.001', '100.004', '101.000'], ['100.000'], 0.002),
    ).toEqual(['100.001']);
    expect(findAllAdjacentFreqs(['100.000', '100.001'], ['100.000'], 0)).toEqual([]);
  });

  it('builds inbox requests with expanded frequencies and shared defaults', () => {
    const req = buildInboxReq({
      filter: { ...emptyFilter(), groupsSelected: ['g1'], freqsSelected: ['100.0'] },
      expandedFreqsSelected: ['100.0', '100.1'],
      expandedFreqsDenied: ['200.0'],
      highlightSignals: true,
      reportTagsOnlyThisUnit: true,
      loadLatest: true,
    });

    expect(req.selectedGroups).toEqual(['g1']);
    expect(req.selectedFreqs).toEqual(['100.0', '100.1']);
    expect(req.deniedFreqs).toEqual(['200.0']);
    expect(req.highlightSignals).toBe(true);
    expect(req.highlightCallsigns).toBe(true);
    expect(req.pageId).toBe(PAGE_ID);
    expect(req.reportTagsOnlyThisUnit).toBe(true);
    expect(req.loadLatest).toBe(true);
  });

  it('parses and writes query state in the url', () => {
    const state = {
      messageFeeds: [['mf-1', { groups_selected: ['legacy-group'], last_viewed_message_id: 42 }]],
    };

    window.history.replaceState({}, '', `/?state=${encodeURIComponent(JSON.stringify(state))}`);
    expect(parseStateFromUrl()).toEqual({
      messageFeeds: [
        ['mf-1', { ...emptyFilter(), groupsSelected: ['legacy-group'], lastViewedMessageId: 42 }],
      ],
    });

    pushStateToUrl({ messageFeeds: [['mf-2', { ...emptyFilter(), sendersSelected: ['sender'] }]] });
    expect(window.location.search).toContain('state=');
    expect(parseStateFromUrl()).toEqual({
      messageFeeds: [['mf-2', { ...emptyFilter(), sendersSelected: ['sender'] }]],
    });
  });

  it('falls back to default when url state is corrupted', () => {
    window.history.replaceState({}, '', '/?state=%7Bbad-json');
    expect(parseStateFromUrl()).toEqual({ messageFeeds: [['mf-0', emptyFilter()]] });
  });

  it('builds map search hrefs from deduplicated etalons and extracts point etalons', () => {
    const hrefEtalonsOnly = buildAnalysisMapHrefWithSearch(['A1', 'A1', '', 'B2']);
    const urlEtalons = new URL(hrefEtalonsOnly, 'https://example.test');
    expect(urlEtalons.pathname).toBe('/rer-analysis-neo');
    expect(urlEtalons.searchParams.get('search')).toBe('A1,B2');
    expect(urlEtalons.searchParams.get('showMap')).toBe('true');

    const msgWithFreq = { freq: '123.45', messageUid: 'uid-1' } as InboxMessage;
    const hrefWithMsg = buildAnalysisMapHrefWithSearch(['P-1', 'P-2'], msgWithFreq);
    const urlMsg = new URL(hrefWithMsg, 'https://example.test');
    expect(urlMsg.pathname).toBe('/rer-analysis-neo');
    expect(urlMsg.searchParams.get('search')).toBe('P-1,P-2');
    expect(urlMsg.searchParams.getAll('freqs')).toEqual(['123.45']);

    const fromTokens = getPointEtalonsFromMessage({
      pointTokens: [{ etalon: 'P-1' }, { etalon: 'P-2' }],
      textMarked: [],
    } as InboxMessage);
    expect(fromTokens).toEqual(['P-1', 'P-2']);

    const dedupedTokens = getPointEtalonsFromMessage({
      pointTokens: [{ etalon: 'P-1' }, { etalon: 'P-1' }, { etalon: ' P-1 ' }],
      textMarked: [],
    } as InboxMessage);
    expect(dedupedTokens).toEqual(['P-1']);

    const fromMarkedText = getPointEtalonsFromMessage({
      pointTokens: [],
      textMarked: ['x', { CNPointC: { etalon: ' P-3 ' } }, { CNPointC: { etalon: '' } }],
    } as unknown as InboxMessage);
    expect(fromMarkedText).toEqual(['P-3']);

    expect(uniquePointEtalonsForMapSearch(['a', ' a ', 'b', 'a'])).toEqual(['a', 'b']);
  });

  it('messageHasPalitraTag and point etalons respect tagsMap gate', () => {
    const tag = { isPalitra: true } as Tag;
    const msg: InboxMessage = {
      inboxTags: [{ id: 1, tagId: 7, confidence: 1, login: null, model: null, organismId: null }],
      pointTokens: [{ etalon: 'X' }],
    } as InboxMessage;
    expect(messageHasPalitraTag(msg, { 7: tag })).toBe(true);
    expect(getPointEtalonsFromMessage(msg, { 7: tag })).toEqual(['X']);

    expect(messageHasPalitraTag(msg, { 7: { ...tag, isPalitra: false } })).toBe(false);
    expect(getPointEtalonsFromMessage(msg, { 7: { ...tag, isPalitra: false } })).toEqual([]);
  });

  it('keeps sender options from loaded messages and selected filters when profiles are missing', () => {
    expect(
      buildSenderOptions(
        {
          known: { givenName: 'Known', familyName: 'Sender' } as SignalProfileEntry,
        },
        [
          {
            id: 'mf-1',
            filter: {
              ...emptyFilter(),
              sendersSelected: ['selected-only'],
              deniedSenders: ['denied-only'],
            },
            items: [
              [1, { sender: 'feed-only' } as InboxMessage],
              [2, { sender: ' known ' } as InboxMessage],
            ],
            loading: false,
            loadingOlder: false,
            hasReachedStart: false,
            referenceTimeMs: null,
            readIds: new Set<number>(),
            unreadCount: 0,
            adjacentFreqsRange: 0,
            highlightSignalsEnabled: false,
            onlyMyUnitTagsEnabled: false,
          },
        ],
      ),
    ).toEqual([
      { id: 'known', label: 'Known Sender' },
      { id: 'denied-only', label: 'Невідомий' },
      { id: 'feed-only', label: 'Невідомий' },
      { id: 'selected-only', label: 'Невідомий' },
    ]);
  });

  it('uses the tracked unread count for feed and tab unread totals', () => {
    const feed: MessageFeedState = {
      id: 'mf-1',
      filter: emptyFilter(),
      items: [
        [1, {} as InboxMessage],
        [2, {} as InboxMessage],
        [3, {} as InboxMessage],
      ],
      loading: false,
      loadingOlder: false,
      hasReachedStart: false,
      referenceTimeMs: null,
      readIds: new Set<number>([1]),
      unreadCount: 69980,
      adjacentFreqsRange: 0,
      highlightSignalsEnabled: false,
      onlyMyUnitTagsEnabled: false,
    };

    expect(feedUnreadDisplayCount(feed)).toBe(69980);
    expect(
      feedsUnreadDisplayTotal([
        feed,
        { ...feed, unreadCount: 4, readIds: new Set<number>([1, 2, 3]) },
      ]),
    ).toBe(69984);
  });

  it('counts only loaded unread messages for the bottom button', () => {
    const feed = {
      id: 'mf-1',
      filter: emptyFilter(),
      items: [
        [1, {} as InboxMessage],
        [2, {} as InboxMessage],
        [3, {} as InboxMessage],
      ],
      loading: false,
      loadingOlder: false,
      hasReachedStart: false,
      referenceTimeMs: null,
      readIds: new Set([1, 2]),
      unreadCount: 70000,
      adjacentFreqsRange: 0,
      highlightSignalsEnabled: false,
      onlyMyUnitTagsEnabled: false,
    } satisfies MessageFeedState;
    expect(feedLoadedUnreadCount(feed)).toBe(1);
  });

  it('does not expose raw server unread count when all loaded messages are read', () => {
    const feed = {
      id: 'mf-1',
      filter: emptyFilter(),
      items: [
        [1, {} as InboxMessage],
        [2, {} as InboxMessage],
      ],
      loading: false,
      loadingOlder: false,
      hasReachedStart: false,
      referenceTimeMs: null,
      readIds: new Set([1, 2]),
      unreadCount: 1,
      adjacentFreqsRange: 0,
      highlightSignalsEnabled: false,
      onlyMyUnitTagsEnabled: false,
    } satisfies MessageFeedState;
    expect(feedLoadedUnreadCount(feed)).toBe(0);
    expect(feedUnreadDisplayCount(feed)).toBe(1);
  });

  it('lets a matching empty preview clear a stale raw unread count', () => {
    const feed = indicatorFeed({
      items: [[1, {} as InboxMessage]],
      readIds: new Set([1]),
      unreadCount: 1,
    });
    expect(feedIndicatorUnreadCount(feed, { tailId: 1, count: 0 })).toBe(0);
  });

  it('retains the authoritative server total for a large near-bottom unread count', () => {
    const feed = indicatorFeed({
      items: Array.from({ length: 20 }, (_, index) => [index + 1, {} as InboxMessage]),
      readIds: new Set<number>(),
      unreadCount: 70000,
      windowedUnreadItems: new Map<number, number>(),
    });
    expect(feedIndicatorUnreadCount(feed)).toBe(70000);
  });

  it('adds matching confirmed preview unread messages to loaded unread messages', () => {
    const feed = indicatorFeed({
      items: [
        [1, {} as InboxMessage],
        [2, {} as InboxMessage],
      ],
      readIds: new Set([1]),
    });
    expect(feedIndicatorUnreadCount(feed, { tailId: 2, count: 2 })).toBe(3);
  });

  it('does not double count windowed IDs covered by a matching preview', () => {
    const feed = indicatorFeed({
      items: [[20, { timestamp: 200 } as InboxMessage]],
      readIds: new Set([20]),
      windowedUnreadItems: new Map([[1, 300]]),
    });
    expect(feedIndicatorUnreadCount(feed, { tailId: 20, count: 1 })).toBe(1);
  });

  it('counts a hidden unread item before a matching tail preview', () => {
    const feed = indicatorFeed({
      items: [[20, { timestamp: 200 } as InboxMessage]],
      readIds: new Set([20]),
      windowedUnreadItems: new Map([[900, 100]]),
    });
    expect(feedIndicatorUnreadCount(feed, { tailId: 20, count: 0 })).toBe(1);
  });

  it('counts windowed unread IDs at or before a matching preview tail', () => {
    const feed = indicatorFeed({
      items: [[80, { timestamp: 200 } as InboxMessage]],
      readIds: new Set([80]),
      windowedUnreadItems: new Map(Array.from({ length: 20 }, (_, index) => [index + 41, 100])),
    });
    expect(feedIndicatorUnreadCount(feed, { tailId: 80, count: 0 })).toBe(20);
  });

  it('sums loaded unread rows with a matching preview', () => {
    const feed = indicatorFeed({
      items: [
        [1, {} as InboxMessage],
        [2, {} as InboxMessage],
      ],
      readIds: new Set<number>(),
    });
    expect(feedIndicatorUnreadCount(feed, { tailId: 2, count: 3 })).toBe(5);
  });

  it('ignores a confirmed preview for a different tail', () => {
    const feed = indicatorFeed({
      items: [
        [1, {} as InboxMessage],
        [2, {} as InboxMessage],
      ],
      readIds: new Set([1]),
    });
    expect(feedIndicatorUnreadCount(feed, { tailId: 1, count: 2 })).toBe(1);
  });

  it('clamps negative confirmed preview counts to zero', () => {
    const feed = indicatorFeed({
      items: [[1, {} as InboxMessage]],
      readIds: new Set<number>(),
    });
    expect(feedIndicatorUnreadCount(feed, { tailId: 1, count: -2 })).toBe(1);
  });

  it('retains unread IDs evicted from the fixed window without double counting re-entry', () => {
    const feed = indicatorFeed({
      items: [[2, {} as InboxMessage]],
      readIds: new Set<number>(),
      windowedUnreadItems: new Map([[1, 0]]),
    });
    expect(feedIndicatorUnreadCount(feed)).toBe(2);
    const reentered = indicatorFeed({
      items: [
        [1, {} as InboxMessage],
        [2, {} as InboxMessage],
      ],
      readIds: new Set<number>(),
      windowedUnreadItems: new Map<number, number>(),
    });
    expect(feedIndicatorUnreadCount(reentered)).toBe(2);
  });

  it('windows initial messages to the newest items after sorting and dedupe', () => {
    const items = [
      [3, { timestamp: 300 } as InboxMessage],
      [1, { timestamp: 100 } as InboxMessage],
      [2, { timestamp: 200 } as InboxMessage],
      [2, { timestamp: 250 } as InboxMessage],
      [4, { timestamp: 400 } as InboxMessage],
    ] as Array<[number, InboxMessage]>;

    expect(windowInitialMessageItems(items, 3).map(([id]) => id)).toEqual([2, 3, 4]);
  });

  it('prepends older messages and trims the newest side when the window is full', () => {
    const existing = [3, 4, 5].map(
      (id) => [id, { timestamp: id * 100 } as InboxMessage] as [number, InboxMessage],
    );
    const incomingOlder = [1, 2, 3].map(
      (id) => [id, { timestamp: id * 100 } as InboxMessage] as [number, InboxMessage],
    );

    const result = prependWindowedMessageItems(existing, incomingOlder, 4);

    expect(result.items.map(([id]) => id)).toEqual([1, 2, 3, 4]);
    expect(result.addedItems.map(([id]) => id)).toEqual([1, 2]);
    expect(result.removedItems.map(([id]) => id)).toEqual([5]);
  });

  it('appends newer messages and trims the oldest side when the window is full', () => {
    const existing = [1, 2, 3].map(
      (id) => [id, { timestamp: id * 100 } as InboxMessage] as [number, InboxMessage],
    );
    const incomingNewer = [3, 4, 5].map(
      (id) => [id, { timestamp: id * 100 } as InboxMessage] as [number, InboxMessage],
    );

    const result = appendWindowedMessageItems(existing, incomingNewer, 4);

    expect(result.items.map(([id]) => id)).toEqual([2, 3, 4, 5]);
    expect(result.addedItems.map(([id]) => id)).toEqual([4, 5]);
    expect(result.removedItems.map(([id]) => id)).toEqual([1]);
  });

  it('retains read ids only for messages still inside the fixed window', () => {
    const items = [2, 3].map(
      (id) => [id, { timestamp: id * 100 } as InboxMessage] as [number, InboxMessage],
    );

    expect([...retainReadIdsForItems(new Set([1, 2, 4]), items)]).toEqual([2]);
  });
});
