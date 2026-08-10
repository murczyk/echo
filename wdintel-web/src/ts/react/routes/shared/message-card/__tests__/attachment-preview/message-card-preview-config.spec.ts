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
        disableEscapeKeyDownInFullscreen: true,
      },
    ],
    [
      'video',
      {
        layout: 'media',
        disableRestoreFocus: false,
        supportsFullscreen: true,
        disableEscapeKeyDownInFullscreen: true,
      },
    ],
    [
      'coordinate-map',
      {
        layout: 'media',
        disableRestoreFocus: true,
        supportsFullscreen: true,
        disableEscapeKeyDownInFullscreen: false,
      },
    ],
    [
      'pdf',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: true,
        disableEscapeKeyDownInFullscreen: false,
      },
    ],
    [
      'docx',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: true,
        disableEscapeKeyDownInFullscreen: false,
      },
    ],
    [
      'xlsx',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: true,
        disableEscapeKeyDownInFullscreen: false,
      },
    ],
    [
      'csv',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: true,
        disableEscapeKeyDownInFullscreen: false,
      },
    ],
    [
      'txt',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: false,
        disableEscapeKeyDownInFullscreen: false,
      },
    ],
    [
      'md',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: false,
        disableEscapeKeyDownInFullscreen: false,
      },
    ],
    [
      'unsupported',
      {
        layout: 'document',
        disableRestoreFocus: true,
        supportsFullscreen: false,
        disableEscapeKeyDownInFullscreen: false,
      },
    ],
  ] as const)('resolves %s to the expected shell config', (kind, expected) => {
    expect(getMessageCardAttachmentPreviewConfig(kind)).toEqual(expected);
  });
});
