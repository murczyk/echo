/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RER_ANALYSIS_LEGACY_QUERY_STATE_KEY } from '../../rer-analysis-query-state-legacy';
import { parseStateFromUrl, updateStateUrl } from './url-state';

describe('analysis map url state', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => {
          storage.delete(key);
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    });
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('rewrites legacy tag filters to values the classic decoder can restore', () => {
    const currentUrl =
      'https://example.test/rer-analysis?state=%7B%22filter_tags_option%22%3A%22AllOfTags%22%2C%22report_tags_only_this_unit%22%3Atrue%2C%22tags%22%3A%5B7%5D%7D';

    const nextUrl = new URL(updateStateUrl(currentUrl, 'uid-1'));
    const stateParam = nextUrl.searchParams.get('state');
    expect(stateParam).not.toBeNull();
    expect(stateParam).toContain('{');
    expect(stateParam).not.toContain('%7B');

    const nextState = JSON.parse(stateParam ?? '');
    expect(nextState.filter_tags_option).toBe('AllTags');
    expect(nextState.report_tags_only_this_unit).toBe(true);
    expect(nextState.search).toBe('uid-1');

    expect(parseStateFromUrl(stateParam)).toMatchObject({
      search: 'uid-1',
      tags: [7],
      unitsExactMatchOnly: null,
      filterTagsOption: 'AllTags',
      reportTagsOnlyThisUnit: true,
    });
  });

  it('uses only flat query params when rebuilding neo analysis urls', () => {
    const currentUrl =
      'https://example.test/rer-analysis-neo?state=%7B%22search%22%3A%22legacy%22%2C%22freqs_selected%22%3A%5B%22123.4%22%5D%7D&freqs=432.1';

    const nextUrl = new URL(updateStateUrl(currentUrl, 'uid-1'));

    expect(nextUrl.searchParams.get('state')).toBeNull();
    expect(nextUrl.searchParams.getAll('freqs')).toEqual(['432.1']);
    expect(nextUrl.searchParams.get('search')).toBe('uid-1');
  });

  it('persists classic rebuilt urls into legacy storage and keeps neo urls query-param only', () => {
    updateStateUrl('https://example.test/rer-analysis?state=%7B%22search%22%3A%22old%22%7D', 'classic-uid');
    updateStateUrl('https://example.test/rer-analysis-neo?search=neo-old', 'neo-uid');

    expect(globalThis.localStorage.getItem(RER_ANALYSIS_LEGACY_QUERY_STATE_KEY)).toContain('classic-uid');
    expect(globalThis.localStorage.getItem('rer-analysis-neo-query-state')).toBeNull();
  });
});
