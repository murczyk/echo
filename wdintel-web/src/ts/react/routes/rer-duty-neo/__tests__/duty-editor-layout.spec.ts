import { describe, expect, it } from 'vitest';

import { dutyEditorLayoutColumns, shouldUseActiveFeedLayout } from '../duty-editor-layout';

describe('dutyEditorLayoutColumns', () => {
  it('matches the Analysis right dock width and collapses its closed track', () => {
    expect(dutyEditorLayoutColumns(true)).toBe('minmax(0, 1fr) clamp(640px, 48%, 800px)');
    expect(dutyEditorLayoutColumns(false)).toBe('minmax(0, 1fr) minmax(0, 0fr)');
  });
});

describe('shouldUseActiveFeedLayout', () => {
  it.each([
    { feeds: 1, width: 360, expected: false },
    { feeds: 2, width: 736, expected: false },
    { feeds: 2, width: 735, expected: true },
    { feeds: 3, width: 1112, expected: false },
    { feeds: 4, width: 1487, expected: true },
    { feeds: 4, width: 1488, expected: false },
  ])('resolves $feeds feeds in $width px', ({ feeds, width, expected }) => {
    expect(
      shouldUseActiveFeedLayout({
        narrowScreen: false,
        editorEmbeddedOpen: true,
        availableWidth: width,
        feedCount: feeds,
      }),
    ).toBe(expected);
  });

  it('keeps all columns mounted until the embedded width is measured', () => {
    expect(
      shouldUseActiveFeedLayout({
        narrowScreen: false,
        editorEmbeddedOpen: true,
        availableWidth: null,
        feedCount: 4,
      }),
    ).toBe(false);
  });

  it('keeps desktop all-column mode when the editor is closed', () => {
    expect(
      shouldUseActiveFeedLayout({
        narrowScreen: false,
        editorEmbeddedOpen: false,
        availableWidth: 500,
        feedCount: 4,
      }),
    ).toBe(false);
  });
});
