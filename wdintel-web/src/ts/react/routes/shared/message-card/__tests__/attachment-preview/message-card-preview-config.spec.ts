import { describe, expect, it } from 'vitest';

import { getMessageCardAttachmentPreviewConfig } from '../../attachment-preview/message-card-preview-config';

describe('message-card-preview-config', () => {
  it.each([
    [
      'image',
      {
        layout: 'media',
        disableRestoreFocus: true,
      },
    ],
    [
      'video',
      {
        layout: 'media',
        disableRestoreFocus: false,
      },
    ],
    [
      'coordinate-map',
      {
        layout: 'media',
        disableRestoreFocus: true,
      },
    ],
    [
      'pdf',
      {
        layout: 'document',
        disableRestoreFocus: true,
      },
    ],
    [
      'docx',
      {
        layout: 'document',
        disableRestoreFocus: true,
      },
    ],
    [
      'xlsx',
      {
        layout: 'document',
        disableRestoreFocus: true,
      },
    ],
    [
      'csv',
      {
        layout: 'document',
        disableRestoreFocus: true,
      },
    ],
    [
      'txt',
      {
        layout: 'document',
        disableRestoreFocus: true,
      },
    ],
    [
      'md',
      {
        layout: 'document',
        disableRestoreFocus: true,
      },
    ],
    [
      'unsupported',
      {
        layout: 'document',
        disableRestoreFocus: true,
      },
    ],
  ] as const)('resolves %s to the expected shell config', (kind, expected) => {
    expect(getMessageCardAttachmentPreviewConfig(kind)).toEqual(expected);
  });
});
