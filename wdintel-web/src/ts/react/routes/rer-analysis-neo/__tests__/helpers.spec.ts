import { describe, expect, it, vi } from 'vitest';

import {
  adjustQueryDateRangeForDirectMessage,
  createInitialQueryState,
  emptyQueryState,
  hasQueryStateInWindow,
  parseQueryStateFromWindow,
  readAnalysisGroupScopeFromUrl,
  writeAnalysisGroupScopeToUrl,
} from '../helpers';
import type { AnalysisQueryState } from '../types';

function createQueryState(overrides: Partial<AnalysisQueryState> = {}): AnalysisQueryState {
  return {
    ...emptyQueryState(),
    fromDateTimeStr: '2026-03-30T08:00',
    toDateTimeStr: '2026-03-31T08:00',
    groupsSelected: ['Alpha'],
    search: 'signal',
    ...overrides,
  };
}

describe('rer-analysis-neo URL state', () => {
  it('round-trips a dedicated group separately from the aggregate filter state', () => {
    const pushState = vi.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { href: 'https://example.test/rer-analysis-neo?groups_selected=Alpha' },
        history: { pushState },
      },
    });

    expect(readAnalysisGroupScopeFromUrl()).toEqual({ kind: 'all' });
    writeAnalysisGroupScopeToUrl({ kind: 'group', masterKey: 'group-b' });
    expect(pushState).toHaveBeenCalledWith(
      {},
      '',
      '/rer-analysis-neo?groups_selected=Alpha&group=group-b',
    );

    Object.defineProperty(window.location, 'href', {
      configurable: true,
      value: 'https://example.test/rer-analysis-neo?groups_selected=Alpha&group=group-b',
    });
    expect(readAnalysisGroupScopeFromUrl()).toEqual({ kind: 'group', masterKey: 'group-b' });
    delete (globalThis as { window?: Window }).window;
  });

  it('treats managed URL parameters as authoritative', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          href: 'https://example.test/rer-analysis-neo?search=uid-1&onlyWithNetwork=true',
        },
      },
    });

    expect(parseQueryStateFromWindow()).toMatchObject({
      search: 'uid-1',
      onlyWithNetwork: true,
      freqsSelected: [],
      tags: [],
    });

    delete (globalThis as { window?: Window }).window;
  });

  it('treats the media-only URL parameter as authoritative', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { href: 'https://example.test/rer-analysis-neo?only_with_media=true' },
      },
    });

    expect(hasQueryStateInWindow()).toBe(true);

    delete (globalThis as { window?: Window }).window;
  });
  it('ignores unsupported legacy state parameters when managed URL parameters are absent', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          href: 'https://example.test/rer-analysis-neo?state=%7B%22search%22%3A%22legacy%22%2C%22freqs_selected%22%3A%5B%22123.4%22%5D%7D',
        },
      },
    });

    expect(parseQueryStateFromWindow()).toEqual(emptyQueryState());

    delete (globalThis as { window?: Window }).window;
  });

  // Regression: https://github.com/echoua/echo/issues/3568
  it('defaults bare non-Rer Analysis to 90 calendar days in the app timezone', () => {
    const state = createInitialQueryState(
      emptyQueryState(),
      new Date(Date.UTC(2026, 0, 15, 22, 30, 0)),
    );

    expect(state.fromDateTimeStr).toBe('2025-10-19T00:00');
    expect(state.toDateTimeStr).toBe('2026-01-17T00:00');
  });

  // Regression: https://github.com/echoua/echo/issues/3568
  it('defaults bare Rer Analysis to today in the app timezone', () => {
    const state = createInitialQueryState(
      emptyQueryState(),
      new Date(Date.UTC(2026, 0, 15, 22, 30, 0)),
      true,
    );

    expect(state.fromDateTimeStr).toBe('2026-01-16T00:00');
    expect(state.toDateTimeStr).toBe('2026-01-17T00:00');
  });
});

describe('rer-analysis-neo direct-link dates', () => {
  // Regression: https://github.com/echoua/echo/issues/2726
  it.each([
    ['2026-08-28', '2026-08-29', '2026-08-20', '2026-08-20', '2026-08-21'],
    ['2026-08-28', '2026-08-29', '2026-09-20', '2026-09-20', '2026-09-21'],
    ['2026-03-28', '2026-03-29', '2026-03-29', '2026-03-29', '2026-03-30'],
    ['2026-10-24', '2026-10-25', '2026-10-25', '2026-10-25', '2026-10-26'],
    ['2026-07-01', '2026-09-29', '2026-03-29', '2026-02-12', '2026-05-13'],
    ['2026-01-01', '2026-04-01', '2026-10-25', '2026-09-10', '2026-12-09'],
  ])(
    'recenters %s–%s around %s without changing calendar-day count',
    (from, to, date, nextFrom, nextTo) => {
      const state = createQueryState({
        fromDateTimeStr: `${from}T00:00`,
        toDateTimeStr: `${to}T00:00`,
      });
      const next = adjustQueryDateRangeForDirectMessage(state, {
        date,
        time: '12:00',
        timestamp: null,
        isTimeNull: null,
        createdAt: null,
      });
      expect(next).toEqual({
        ...state,
        fromDateTimeStr: `${nextFrom}T00:00`,
        toDateTimeStr: `${nextTo}T00:00`,
      });
    },
  );

  it.each(['00:00', '23:59'])(
    'keeps the range when a linked message is inside it at %s',
    (time) => {
      const state = createQueryState({
        fromDateTimeStr: '2026-08-20T00:00',
        toDateTimeStr: '2026-08-21T00:00',
      });
      expect(
        adjustQueryDateRangeForDirectMessage(state, {
          date: '2026-08-20',
          time,
          timestamp: null,
          isTimeNull: null,
          createdAt: null,
        }),
      ).toBe(state);
    },
  );

  it('uses the exclusive upper bound and preserves a custom hourly duration', () => {
    const state = createQueryState({
      fromDateTimeStr: '2026-08-20T12:35',
      toDateTimeStr: '2026-08-20T14:35',
    });
    expect(
      adjustQueryDateRangeForDirectMessage(state, {
        date: '20.08.2026',
        time: '14:35:45',
        timestamp: Date.UTC(2026, 0, 1),
        isTimeNull: null,
        createdAt: null,
      }),
    ).toEqual({ ...state, fromDateTimeStr: '2026-08-20T13:35', toDateTimeStr: '2026-08-20T15:35' });
  });

  it('keeps the elapsed duration of an hourly range crossing the DST change', () => {
    const state = createQueryState({
      fromDateTimeStr: '2026-03-29T02:00',
      toDateTimeStr: '2026-03-29T05:00',
    });
    expect(
      adjustQueryDateRangeForDirectMessage(state, {
        date: null,
        time: null,
        timestamp: Date.UTC(2026, 7, 20, 11, 35),
        isTimeNull: null,
        createdAt: null,
      }),
    ).toEqual({ ...state, fromDateTimeStr: '2026-08-20T13:35', toDateTimeStr: '2026-08-20T15:35' });
  });

  it('uses the creation date in the application timezone instead of the interception date', () => {
    const state = createQueryState({
      messageTimeBasis: 'creation',
      fromDateTimeStr: '2026-08-28T00:00',
      toDateTimeStr: '2026-08-29T00:00',
    });
    expect(
      adjustQueryDateRangeForDirectMessage(state, {
        date: '2026-01-01',
        time: '10:00',
        timestamp: Date.UTC(2026, 0, 1),
        isTimeNull: null,
        createdAt: Date.UTC(2026, 7, 28, 21),
      }),
    ).toEqual({ ...state, fromDateTimeStr: '2026-08-29T00:00', toDateTimeStr: '2026-08-30T00:00' });
  });

  it('keeps a creation timestamp with seconds inside a one-minute replacement range', () => {
    const state = createQueryState({
      messageTimeBasis: 'creation',
      fromDateTimeStr: '2026-08-28T12:00',
      toDateTimeStr: '2026-08-28T12:01',
    });
    expect(
      adjustQueryDateRangeForDirectMessage(state, {
        date: null,
        time: null,
        timestamp: null,
        isTimeNull: null,
        createdAt: Date.UTC(2026, 7, 20, 9, 35, 10),
      }),
    ).toEqual({ ...state, fromDateTimeStr: '2026-08-20T12:35', toDateTimeStr: '2026-08-20T12:36' });
  });

  it('does not fall back to interception time when creation time is unavailable', () => {
    const state = createQueryState({ messageTimeBasis: 'creation' });
    expect(
      adjustQueryDateRangeForDirectMessage(state, {
        date: '2026-01-01',
        time: '10:00',
        timestamp: Date.UTC(2026, 0, 1),
        isTimeNull: null,
        createdAt: null,
      }),
    ).toBe(state);
  });

  it('ignores legacy placeholder times for date-only messages in custom ranges', () => {
    const state = createQueryState({
      fromDateTimeStr: '2026-08-28T10:00',
      toDateTimeStr: '2026-08-28T14:00',
    });
    expect(
      adjustQueryDateRangeForDirectMessage(state, {
        date: '2026-08-20',
        time: '12:00:00',
        isTimeNull: true,
        timestamp: Date.UTC(2026, 7, 20, 9),
        createdAt: null,
      }),
    ).toEqual({ ...state, fromDateTimeStr: '2026-08-19T22:00', toDateTimeStr: '2026-08-20T02:00' });
  });

  it('uses midnight for a date-only linked message and retains invalid ranges', () => {
    const message = {
      date: '2026-08-20',
      time: null,
      timestamp: null,
      isTimeNull: null,
      createdAt: null,
    };
    const state = createQueryState({
      fromDateTimeStr: '2026-08-28T00:00',
      toDateTimeStr: '2026-08-29T00:00',
    });
    expect(adjustQueryDateRangeForDirectMessage(state, message)).toEqual({
      ...state,
      fromDateTimeStr: '2026-08-20T00:00',
      toDateTimeStr: '2026-08-21T00:00',
    });
    for (const toDateTimeStr of ['', '2026-08-28T00:00', '2026-08-27T00:00']) {
      const invalid = { ...state, toDateTimeStr };
      expect(adjustQueryDateRangeForDirectMessage(invalid, message)).toBe(invalid);
    }
    expect(adjustQueryDateRangeForDirectMessage(state, { ...message, date: null })).toBe(state);
  });
});
