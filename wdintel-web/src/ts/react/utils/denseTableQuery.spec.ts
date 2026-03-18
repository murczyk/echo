/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { readDenseTableFromUrl, setDenseTableQueryParam } from './denseTableQuery';

describe('denseTableQuery', () => {
  it('reads dense mode from the current URL', () => {
    window.history.replaceState({}, '', '/page?dense=1');
    expect(readDenseTableFromUrl()).toBe(true);

    window.history.replaceState({}, '', '/page');
    expect(readDenseTableFromUrl()).toBe(false);
  });

  it('supports custom param names', () => {
    window.history.replaceState({}, '', '/page?compact=1');
    expect(readDenseTableFromUrl('compact')).toBe(true);
  });

  it('sets and removes the dense query param', () => {
    const params = new URLSearchParams();

    setDenseTableQueryParam(params, true);
    expect(params.toString()).toBe('dense=1');

    setDenseTableQueryParam(params, false);
    expect(params.toString()).toBe('');
  });
});
