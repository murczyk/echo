import Uppy from '@uppy/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fallbackFailedMessageUploads,
  messageUploadFailure,
  rememberMessageUploadFailure,
} from '../message-upload-fallback';

class SuccessfulXMLHttpRequest {
  status = 201;
  statusText = 'Created';
  responseText = JSON.stringify({
    upload_url: '/api/sigint/file-upload/tus/fallback-upload.4',
  });
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  withCredentials = false;

  open() {}

  send() {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: 4,
      total: 4,
    } as ProgressEvent);
    this.onload?.();
  }
}

function uppyFile() {
  const uppy = new Uppy();
  const id = uppy.addFile({
    name: 'evidence.png',
    type: 'image/png',
    data: new Blob(['data'], { type: 'image/png' }),
  });
  return { uppy, file: uppy.getFile(id) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('message upload fallback', () => {
  // @test-scope safeguard: prevents terminal authentication failures from being retried through a second upload transport.
  it('keeps terminal authentication failures without attempting fallback', async () => {
    const { uppy, file } = uppyFile();
    rememberMessageUploadFailure(uppy, file, {
      cause: { originalResponse: { getStatus: () => 401 } },
      message: 'unauthorized',
    });

    const failed = await fallbackFailedMessageUploads(uppy, [file]);

    expect(failed).toEqual([file]);
    expect(messageUploadFailure(uppy, file.id)?.status).toBe(401);
  });

  // @test-scope safeguard: prevents a recoverable TUS failure from discarding an attachment instead of preserving its uploaded URL.
  it('uploads a failed TUS file through multipart and records its URL', async () => {
    vi.stubGlobal('XMLHttpRequest', SuccessfulXMLHttpRequest);
    const { uppy, file } = uppyFile();
    rememberMessageUploadFailure(uppy, file, new Error('chunk blocked'));

    const failed = await fallbackFailedMessageUploads(uppy, [file]);

    expect(failed).toEqual([]);
    expect(uppy.getFile(file.id).uploadURL).toBe('/api/sigint/file-upload/tus/fallback-upload.4');
    expect(uppy.getFile(file.id).progress.uploadComplete).toBe(true);
    expect(messageUploadFailure(uppy, file.id)).toBeUndefined();
  });
});
