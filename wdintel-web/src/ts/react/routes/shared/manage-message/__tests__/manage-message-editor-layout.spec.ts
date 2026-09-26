import { describe, expect, it } from 'vitest';

import { resolveManageMessageEmbeddedFormLayout } from '../manage-message-editor-layout';

describe('resolveManageMessageEmbeddedFormLayout', () => {
  it.each([
    {
      width: null,
      expected: { density: 'single', mainColumns: 1, sectionColumns: 1, metadataColumns: 1 },
    },
    {
      width: 719,
      expected: { density: 'single', mainColumns: 1, sectionColumns: 1, metadataColumns: 1 },
    },
    {
      width: 720,
      expected: { density: 'compact', mainColumns: 2, sectionColumns: 1, metadataColumns: 2 },
    },
    {
      width: 899,
      expected: { density: 'compact', mainColumns: 2, sectionColumns: 1, metadataColumns: 2 },
    },
    {
      width: 900,
      expected: { density: 'wide', mainColumns: 2, sectionColumns: 2, metadataColumns: 2 },
    },
    {
      width: 1520,
      expected: { density: 'wide', mainColumns: 2, sectionColumns: 2, metadataColumns: 2 },
    },
  ])('resolves the form at an editor width of $width', ({ width, expected }) => {
    expect(resolveManageMessageEmbeddedFormLayout(width)).toEqual(expected);
  });
});
