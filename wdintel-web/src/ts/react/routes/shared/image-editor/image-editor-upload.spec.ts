/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';

import { replacePendingImageFile } from './image-editor-upload';

describe('replacePendingImageFile', () => {
  it('keeps the Uppy ID and updates payload and upload metadata together', () => {
    const setFileState = vi.fn();
    const replacement = new File(['edited'], 'photo.webp', { type: 'image/webp' });

    replacePendingImageFile({
      uppy: { setFileState } as never,
      fileId: 'pending-id',
      pending: { meta: { retained: 'value', name: 'photo.jpg', type: 'image/jpeg' } } as never,
      replacement,
    });

    expect(setFileState).toHaveBeenCalledOnce();
    expect(setFileState).toHaveBeenCalledWith(
      'pending-id',
      expect.objectContaining({
        data: replacement,
        name: 'photo.webp',
        type: 'image/webp',
        size: replacement.size,
        extension: 'webp',
        meta: expect.objectContaining({
          retained: 'value',
          name: 'photo.webp',
          type: 'image/webp',
          filename: 'photo.webp',
          fileName: 'photo.webp',
          file_type: 'image/webp',
          fileType: 'image/webp',
          extension: 'webp',
        }),
      }),
    );
  });
});
