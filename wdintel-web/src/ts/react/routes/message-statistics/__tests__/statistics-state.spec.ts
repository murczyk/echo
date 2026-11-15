// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildStatsRequest,
  initialState,
  periodError,
  readState,
  senderValue,
  stateHref,
} from '../state';
import { facetFilter } from '../facet-request';
import { StatsResourceCache } from '../use-stats-resource';

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState({}, '', '/');
});
describe('#3873 statistics URL and calendar input', () => {
  it('round-trips filters, unknown sender, child choice and pagination through the URL', () => {
    const state = {
      ...initialState(),
      groups: ['a&b', 'same-name-other-key'],
      senders: [senderValue(null), senderValue('sender&uuid')],
      units: ['unit-id:10'],
      children: false,
      cursors: [null, 'opaque&cursor'],
      grouping: 'Senders' as const,
    };
    window.history.replaceState({}, '', stateHref(state));
    expect(readState()).toEqual(state);
    expect(
      buildStatsRequest(state, {
        revision: 'v1',
        groups: [],
        units: [{ id: 10, name: 'unit', groupIndex: null }],
      }),
    ).toMatchObject({
      selectedGroups: state.groups,
      selectedUnitIds: [10],
      selectedSenders: [{ sender: null }, { sender: 'sender&uuid' }],
      cursor: 'opaque&cursor',
    });
  });
  it('rejects calendar overflow, future dates and periods over ninety days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    const state = initialState();
    expect(state).toMatchObject({ from: '2026-11-05', to: '2026-11-11' });
    expect(periodError({ ...state, from: '2026-01-01', to: '2026-03-31' })).toBeNull();
    for (const [from, to] of [
      ['2026-01-01', '2026-04-01'],
      ['2026-02-30', '2026-03-01'],
      ['2026-11-11', '2026-11-12'],
      ['2026-11-11', '2026-11-10'],
    ])
      expect(buildStatsRequest({ ...state, from, to }, null)).toBeNull();
  });
  it('keeps exact unit IDs when children are off and expands when enabled', () => {
    const tree = {
      revision: 'v1',
      groups: [
        { id: 'group:2:army', label: 'Army', level: 2, parentIndex: null },
        { id: 'group:2:army|3:child', label: 'Child', level: 3, parentIndex: 0 },
      ],
      units: [
        { id: 10, name: 'Army', groupIndex: 0 },
        { id: 11, name: 'Child', groupIndex: 1 },
      ],
    };
    const state = { ...initialState(), units: ['unit-id:10'] };
    expect(buildStatsRequest(state, null)).toBeNull();
    expect(buildStatsRequest({ ...state, children: false }, tree)?.selectedUnitIds).toEqual([10]);
    expect(buildStatsRequest(state, tree)?.selectedUnitIds?.sort()).toEqual([10, 11]);
  });

  it('canonicalizes facet scopes while preserving explicit empty and unknown filters', () => {
    const request = {
      ...buildStatsRequest(initialState(), null)!,
      grouping: 'Senders' as const,
      cursor: 'chart-page',
      selectedGroups: ['b', 'a', 'a'],
      selectedUnitIds: [],
      selectedSenders: [{ sender: 'sender' }, { sender: null }, { sender: 'sender' }],
    };
    expect(facetFilter(request, 'Groups')).toMatchObject({
      grouping: 'Groups',
      cursor: null,
      selectedGroups: null,
      selectedUnitIds: [],
      selectedSenders: [{ sender: null }, { sender: 'sender' }],
    });
    expect(facetFilter(request, 'Units')).toMatchObject({
      selectedGroups: ['a', 'b'],
      selectedUnitIds: null,
    });
    expect(facetFilter(request, 'Senders')).toMatchObject({
      selectedUnitIds: [],
      selectedSenders: null,
    });
    expect(request.selectedGroups).toEqual(['b', 'a', 'a']);
  });

  it('expires cached counters from their original generation time rather than receipt or reads', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    let monotonic = 1_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const cache = new StatsResourceCache();
    const response = {
      counts: [],
      accessRevision: 'a',
      hierarchyRevision: null,
      generatedAtMs: Date.now() - 4_000,
    };
    cache.put('key', response);
    monotonic += 900;
    expect(cache.get('key')).toBe(response);
    monotonic += 101;
    expect(cache.get('key')).toBeNull();
    cache.put('expired', { ...response, generatedAtMs: Date.now() - 6_000 });
    expect(cache.get('expired')).toBeNull();
    clock.mockRestore();
  });
});
