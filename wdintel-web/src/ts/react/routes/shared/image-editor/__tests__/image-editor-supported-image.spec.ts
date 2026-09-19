import { describe, expect, it } from 'vitest';

import { normalizedEditableImageMimeType } from '../image-editor-supported-image';

// Regression: https://github.com/echoua/echo/issues/3099
describe('normalizedEditableImageMimeType', () => {
  it.each([
    ['image/jpg', 'photo.jpg', 'image/jpeg'],
    ['IMAGE/JPG; charset=binary', 'photo.jpg', 'image/jpeg'],
  ])('normalizes %s to %s', (contentType, fileName, expected) => {
    expect(normalizedEditableImageMimeType(contentType, fileName)).toBe(expected);
  });
});
