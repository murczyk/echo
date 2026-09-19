/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import getFingerprint from '@uppy/tus/lib/getFingerprint';

import {
  MESSAGE_TUS_ENDPOINT,
  messageTusFingerprint,
  type MessageTusUrlStorage,
} from '../../message-tus-resume';
import { replacePendingImageFile } from '../image-editor-upload';

function pendingFile() {
  return {
    meta: { retained: 'value', name: 'photo.jpg', type: 'image/jpeg' },
  } as never;
}

// Regression: https://github.com/echoua/echo/issues/3294
describe('replacePendingImageFile', () => {
  it('invalidates fingerprint records before replacement when no URL reached Uppy #3294', async () => {
    const matchingRecords = [
      {
        urlStorageKey: 'matching',
        uploadUrl: 'https://upload.example.test/previous',
      },
      {
        urlStorageKey: 'matching-second',
        uploadUrl: 'https://upload.example.test/previous-second',
      },
    ];
    const records = [
      ...matchingRecords,
      {
        urlStorageKey: 'unrelated',
        uploadUrl: 'https://upload.example.test/unrelated',
      },
    ];
    const urlStorage = {
      findUploadsByFingerprint: vi.fn(async (fingerprint: string) =>
        fingerprint === messageTusFingerprint('pending-id') ? matchingRecords : [],
      ),
      removeUpload: vi.fn(async (key: string) => {
        const index = records.findIndex((record) => record.urlStorageKey === key);
        records.splice(index, 1);
      }),
    } as MessageTusUrlStorage;
    const setFileState = vi.fn(() => {
      expect(records).toEqual([expect.objectContaining({ urlStorageKey: 'unrelated' })]);
    });
    const replacement = new File(['edited'], 'photo.webp', { type: 'image/webp' });

    await replacePendingImageFile({
      uppy: { setFileState } as never,
      fileId: 'pending-id',
      pending: pendingFile(),
      replacement,
      urlStorage,
    });

    expect(urlStorage.findUploadsByFingerprint).toHaveBeenCalledWith(
      messageTusFingerprint('pending-id'),
    );
    expect(urlStorage.removeUpload).toHaveBeenCalledTimes(2);
    expect(urlStorage.removeUpload).toHaveBeenCalledWith('matching');
    expect(urlStorage.removeUpload).toHaveBeenCalledWith('matching-second');
    expect(records).toEqual([expect.objectContaining({ urlStorageKey: 'unrelated' })]);
    expect(setFileState).toHaveBeenCalledWith(
      'pending-id',
      expect.objectContaining({
        data: replacement,
        name: 'photo.webp',
        type: 'image/webp',
        size: replacement.size,
        extension: 'webp',
        tus: undefined,
        uploadURL: undefined,
        response: undefined,
        isPaused: false,
        error: null,
        progress: expect.objectContaining({
          percentage: 0,
          bytesTotal: replacement.size,
          bytesUploaded: 0,
          uploadComplete: false,
          uploadStarted: null,
        }),
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

  it('does not replace bytes when Tus fingerprint cleanup fails #3294', async () => {
    const setFileState = vi.fn();
    const urlStorage = {
      findUploadsByFingerprint: vi.fn(async () => [
        {
          urlStorageKey: 'matching',
          uploadUrl: 'https://upload.example.test/previous',
        },
      ]),
      removeUpload: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
    } as MessageTusUrlStorage;

    await expect(
      replacePendingImageFile({
        uppy: { setFileState } as never,
        fileId: 'pending-id',
        pending: pendingFile(),
        replacement: new File(['edited'], 'photo.webp', { type: 'image/webp' }),
        urlStorage,
      }),
    ).rejects.toThrow('storage unavailable');

    expect(setFileState).not.toHaveBeenCalled();
  });

  it('matches the installed Uppy browser fingerprint contract #3294', async () => {
    const fileId = 'pending-id';
    const fingerprint = getFingerprint({ id: fileId } as never);

    await expect(
      fingerprint(new File(['image'], 'photo.png', { type: 'image/png' }), {
        endpoint: MESSAGE_TUS_ENDPOINT,
      } as never),
    ).resolves.toBe(messageTusFingerprint(fileId));
  });
});
