import { describe, expect, it } from 'vitest';

import { getMessageCardAttachmentPreviewConfig } from '../../attachment-preview/message-card-preview-config';

describe('message-card-preview-config', () => {
  it.each([
    ['image', true],
    ['video', false],
    ['coordinate-map', true],
    ['pdf', true],
    ['docx', true],
    ['xlsx', true],
    ['csv', true],
    ['txt', true],
    ['md', true],
    ['unsupported', true],
  ] as const)('resolves restore-focus behavior for %s', (kind, disableRestoreFocus) => {
    expect(getMessageCardAttachmentPreviewConfig(kind)).toEqual({ disableRestoreFocus });
  });
});
