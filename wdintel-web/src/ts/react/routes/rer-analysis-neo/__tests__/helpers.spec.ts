import { describe, expect, it } from 'vitest';

import { createInitialQueryState, emptyQueryState, parseQueryStateFromWindow } from '../helpers';

describe('rer-analysis-neo URL state', () => {
  it('treats managed URL parameters as authoritative', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { href: 'https://example.test/rer-analysis-neo?search=uid-1' } },
    });

    expect(parseQueryStateFromWindow()).toMatchObject({
      search: 'uid-1',
      freqsSelected: [],
      tags: [],
    });

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
