/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { updateStateUrl } from './url-state';

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

  it('preserves supported tag filters when rebuilding classic analysis urls', () => {
    const currentUrl =
      'https://example.test/rer-analysis?state=%7B%22filter_tags_option%22%3A%22AllOfTags%22%2C%22report_tags_only_this_unit%22%3Atrue%2C%22tags%22%3A%5B7%5D%7D';

    const nextUrl = new URL(updateStateUrl(currentUrl, 'uid-1'));
    const stateParam = nextUrl.searchParams.get('state');
    expect(stateParam).not.toBeNull();

    const nextState = JSON.parse(decodeURIComponent(stateParam ?? ''));
    expect(nextState.filter_tags_option).toBe('AllOfTags');
    expect(nextState.report_tags_only_this_unit).toBe(true);
    expect(nextState.search).toBe('uid-1');
  });
});
