/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { shouldShowPalitrasControl } from './palitra-manager';

describe('shouldShowPalitrasControl', () => {
  it('keeps the palitras control visible after an empty successful load', () => {
    expect(
      shouldShowPalitrasControl({ enabled: true, loadState: 'success', palitrasCount: 0 }),
    ).toBe(true);
  });

  it('hides the palitras control while idle without data', () => {
    expect(shouldShowPalitrasControl({ enabled: true, loadState: 'idle', palitrasCount: 0 })).toBe(
      false,
    );
  });
});
