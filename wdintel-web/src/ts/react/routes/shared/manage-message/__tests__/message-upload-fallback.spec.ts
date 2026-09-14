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

class PendingXMLHttpRequest extends SuccessfulXMLHttpRequest {
  static requests: PendingXMLHttpRequest[] = [];
  timeout = 0;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  abort = vi.fn(() => this.onabort?.());

  send() {
    PendingXMLHttpRequest.requests.push(this);
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  PendingXMLHttpRequest.requests = [];
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

  it.each(['{', '{}', 'null', '{"upload_url":42}', '{"upload_url":{}}', '{"upload_url":"  "}'])(
    'keeps an attachment retryable when the upload response cannot supply a URL: %s',
    async (responseText) => {
      vi.stubGlobal('XMLHttpRequest', PendingXMLHttpRequest);
      const { uppy, file } = uppyFile();
      const result = fallbackFailedMessageUploads(uppy, [file]);
      const request = PendingXMLHttpRequest.requests[0]!;
      request.responseText = responseText;
      request.onload?.();

      expect(await result).toEqual([file]);
      expect(uppy.getFile(file.id).uploadURL).toBeUndefined();
      expect(uppy.getFile(file.id).progress.uploadComplete).toBe(false);
      expect(messageUploadFailure(uppy, file.id)?.message).toContain('некоректну відповідь');
      uppy.destroy();
    },
  );

  it.each(['cancel-all', 'remove-file', 'unmount-signal'])(
    'aborts pending requests and prevents queued uploads after %s',
    async (cancellation) => {
      vi.useFakeTimers();
      vi.stubGlobal('XMLHttpRequest', PendingXMLHttpRequest);
      const { uppy, file } = uppyFile();
      for (let index = 0; index < 3; index += 1) {
        uppy.addFile({ name: `queued-${index}.bin`, data: new Blob(['data']) });
      }
      const controller = new AbortController();
      const result = fallbackFailedMessageUploads(uppy, uppy.getFiles(), controller.signal);
      const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(PendingXMLHttpRequest.requests).toHaveLength(3);

      if (cancellation === 'cancel-all') uppy.cancelAll();
      else if (cancellation === 'remove-file') uppy.removeFile(file.id);
      else controller.abort();

      await rejected;
      expect(PendingXMLHttpRequest.requests).toHaveLength(3);
      for (const request of PendingXMLHttpRequest.requests) {
        expect(request.abort).toHaveBeenCalledTimes(1);
        expect(request.onload).toBeNull();
      }
      expect(uppy.getFiles().every((candidate) => !candidate.progress.uploadComplete)).toBe(true);
      vi.advanceTimersByTime(20 * 60 * 1000);
      for (const request of PendingXMLHttpRequest.requests) {
        expect(request.abort).toHaveBeenCalledTimes(1);
      }
      uppy.destroy();
    },
  );

  it.each(['timeout', 'abort', 'error'])(
    'settles a request %s and allows retry without duplicating a completed request',
    async (failure) => {
      vi.useFakeTimers();
      vi.stubGlobal('XMLHttpRequest', PendingXMLHttpRequest);
      const { uppy, file } = uppyFile();
      const result = fallbackFailedMessageUploads(uppy, [file]);
      const request = PendingXMLHttpRequest.requests[0]!;
      if (failure === 'timeout') vi.advanceTimersByTime(10 * 60 * 1000);
      else if (failure === 'abort') request.onabort?.();
      else request.onerror?.();
      expect(await result).toEqual([file]);
      expect(uppy.getFile(file.id).progress.uploadComplete).toBe(false);
      if (failure === 'timeout') {
        expect(messageUploadFailure(uppy, file.id)?.message).toContain('час очікування');
        expect(request.abort).toHaveBeenCalledTimes(1);
      }
      vi.advanceTimersByTime(20 * 60 * 1000);
      expect(request.abort).toHaveBeenCalledTimes(failure === 'timeout' ? 1 : 0);

      const retry = fallbackFailedMessageUploads(uppy, [uppy.getFile(file.id)]);
      const retriedRequest = PendingXMLHttpRequest.requests[1]!;
      retriedRequest.onload?.();
      expect(await retry).toEqual([]);
      expect(uppy.getFile(file.id).uploadURL).toBe('/api/sigint/file-upload/tus/fallback-upload.4');
      expect(uppy.getFile(file.id).progress.uploadComplete).toBe(true);
      expect(messageUploadFailure(uppy, file.id)).toBeUndefined();
      vi.advanceTimersByTime(20 * 60 * 1000);
      uppy.cancelAll();
      expect(retriedRequest.abort).not.toHaveBeenCalled();
      uppy.destroy();
    },
  );

  it.each([true, false])(
    'allows a slow upload to progress for more than ten minutes with lengthComputable=%s',
    async (lengthComputable) => {
      vi.useFakeTimers();
      vi.stubGlobal('XMLHttpRequest', PendingXMLHttpRequest);
      const { uppy, file } = uppyFile();
      const result = fallbackFailedMessageUploads(uppy, [file]);
      const request = PendingXMLHttpRequest.requests[0]!;
      expect(request.timeout).toBe(0);

      for (let minute = 1; minute <= 17; minute += 1) {
        vi.advanceTimersByTime(60 * 1000);
        request.upload.onprogress?.({
          lengthComputable,
          loaded: minute * 30 * 1024 * 1024,
          total: 512 * 1024 * 1024,
        } as ProgressEvent);
      }
      expect(request.abort).not.toHaveBeenCalled();
      request.onload?.();

      expect(await result).toEqual([]);
      expect(uppy.getFile(file.id).progress.uploadComplete).toBe(true);
      vi.advanceTimersByTime(20 * 60 * 1000);
      expect(request.abort).not.toHaveBeenCalled();
      uppy.destroy();
    },
  );

  it('times out after ten minutes without new bytes despite repeated progress events', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('XMLHttpRequest', PendingXMLHttpRequest);
    const { uppy, file } = uppyFile();
    const result = fallbackFailedMessageUploads(uppy, [file]);
    const request = PendingXMLHttpRequest.requests[0]!;
    vi.advanceTimersByTime(9 * 60 * 1000);
    for (let minute = 0; minute < 10; minute += 1) {
      request.upload.onprogress?.({
        lengthComputable: true,
        loaded: 1,
        total: 4,
      } as ProgressEvent);
      expect(request.abort).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60 * 1000);
    }

    expect(await result).toEqual([file]);
    expect(request.abort).toHaveBeenCalledTimes(1);
    expect(messageUploadFailure(uppy, file.id)?.message).toContain('час очікування');
    expect(uppy.getFile(file.id).progress.uploadComplete).toBe(false);
    uppy.destroy();
  });
});
