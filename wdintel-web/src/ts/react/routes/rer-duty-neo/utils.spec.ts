/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';

import {
  PAGE_ID,
  buildAnalysisMapHrefWithSearch,
  buildInboxReq,
  createMasterUnitText,
  emptyFilter,
  etalonFallbackWhenNoNetworks,
  filtersEqual,
  findAllAdjacentFreqs,
  getPointEtalonsFromMessage,
  messageHasPalitraTag,
  uniquePointEtalonsForMapSearch,
  getStoredMessageCardLayout,
  parseStateFromUrl,
  pushStateToUrl,
  setStoredMessageCardLayout,
} from './utils';
import type { InboxMessage, Network, Tag, Unit } from '../../../../Bindings';

describe('rer-duty utils', () => {
  it('etalon fallback when no networks: unit vs strict', () => {
    const base = { freq: '100.0' } as InboxMessage;
    expect(etalonFallbackWhenNoNetworks({ ...base, unit: '  1-й танк  ' })).toBe('1-й танк');
    expect(etalonFallbackWhenNoNetworks({ ...base, unit: null })).toBe('Не встановлена');
    expect(etalonFallbackWhenNoNetworks({ ...base, unit: 'x' }, { featureStrictNetworks: true })).toBe('Не встановлена');
    expect(etalonFallbackWhenNoNetworks({ freq: null, unit: 'unit' } as InboxMessage)).toBe(null);
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

  it('distinguishes null and empty arrays when comparing filters', () => {
    expect(filtersEqual(emptyFilter(), emptyFilter())).toBe(true);
    expect(filtersEqual(emptyFilter(), { ...emptyFilter(), groupsSelected: [] })).toBe(false);
    expect(filtersEqual({ ...emptyFilter(), freqsSelected: ['100.1'] }, { ...emptyFilter(), freqsSelected: ['100.1'] })).toBe(
      true,
    );
  });

  it('expands adjacent frequencies without repeating already selected ones', () => {
    expect(findAllAdjacentFreqs(['100.000', '100.001', '100.004', '101.000'], ['100.000'], 0.002)).toEqual(['100.001']);
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
      messageFeeds: [
        ['mf-1', { ...emptyFilter(), groups_selected: ['legacy-group'], last_viewed_message_id: 42 }],
      ],
    };

    window.history.replaceState({}, '', `/?state=${encodeURIComponent(JSON.stringify(state))}`);
    expect(parseStateFromUrl()).toEqual({
      messageFeeds: [['mf-1', { ...emptyFilter(), groupsSelected: ['legacy-group'], lastViewedMessageId: 42 }]],
    });

    pushStateToUrl({ messageFeeds: [['mf-2', { ...emptyFilter(), sendersSelected: ['sender'] }]] });
    expect(window.location.search).toContain('state=');
    expect(parseStateFromUrl()).toEqual({
      messageFeeds: [['mf-2', { ...emptyFilter(), sendersSelected: ['sender'] }]],
    });
  });

  it('builds map search hrefs from deduplicated etalons and extracts point etalons', () => {
    expect(buildAnalysisMapHrefWithSearch(['A1', 'A1', '', 'B2'])).toBe(
      `/rer-analysis?state=${encodeURIComponent(JSON.stringify({ search: 'A1,B2' }))}&showMap=true`,
    );

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

  it('stores message card layout preference in localStorage', () => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage.set(key, value);
        }),
      },
    });

    expect(getStoredMessageCardLayout()).toBe('dividers');
    setStoredMessageCardLayout('fluid');
    expect(getStoredMessageCardLayout()).toBe('fluid');
  });
});
