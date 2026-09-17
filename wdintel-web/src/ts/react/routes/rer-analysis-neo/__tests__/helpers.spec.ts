import { describe, expect, it } from 'vitest';

import { emptyQueryState, parseQueryStateFromWindow } from '../helpers';

describe('rer-analysis-neo URL state', () => {
  // @test-scope parser: reads managed analysis URL query state
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

  // @test-scope parser: rejects unsupported legacy analysis URL state
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
});
