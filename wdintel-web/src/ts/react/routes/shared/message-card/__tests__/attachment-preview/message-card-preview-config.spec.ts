import { describe, expect, it } from 'vitest';

import { getMessageCardAttachmentPreviewConfig } from '../../attachment-preview/message-card-preview-config';

describe('message-card-preview-config', () => {
  it.each([
    [
      'image',
      {
        layout: 'media',
        disableRestoreFocus: true,
        supportsFullscreen: true,
      },
    ],
    [
      'video',
      {
        layout: 'media',
        disableRestoreFocus: false,
        supportsFullscreen: true,
      },
    ],
    [
      'coordinate-map',
      {
        layout: 'media',
        disableRestoreFocus: true,
        supportsFullscreen: true,
      },
    ],
    [
      'pdf',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: true,
      },
    ],
    [
      'docx',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: true,
      },
    ],
    [
      'xlsx',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: true,
      },
    ],
    [
      'csv',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: true,
      },
    ],
    [
      'txt',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: true,
      },
    ],
    [
      'md',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: true,
      },
    ],
    [
      'unsupported',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: true,
      },
    ],
  ] as const)('resolves %s to the expected shell config', (kind, expected) => {
    expect(getMessageCardAttachmentPreviewConfig(kind)).toEqual(expected);
  });
});
