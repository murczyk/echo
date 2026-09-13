import type Uppy from '@uppy/core';
import type { UppyFile } from '@uppy/core';

import { emitUnauthorizedEvent } from '../../../auth-redirect';

export const MESSAGE_UPLOAD_FALLBACK_ENDPOINT = '/api/sigint/file-upload/fallback';
const MESSAGE_UPLOAD_FALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

type UploadFailure = {
  message: string;
  status?: number;
};

type FallbackUploadResponse = {
  upload_url: string;
};

class FallbackUploadError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const uploadFailures = new WeakMap<Uppy<any, any>, Map<string, UploadFailure>>();

export function rememberMessageUploadFailure(
  uppy: Uppy<any, any>,
  file: UppyFile<any, any>,
  error: unknown,
  responseStatus?: number,
) {
  const failures = uploadFailures.get(uppy) ?? new Map<string, UploadFailure>();
  failures.set(file.id, {
    message: errorMessage(error),
    status: responseStatus ?? errorStatus(error),
  });
  uploadFailures.set(uppy, failures);
}

export function forgetMessageUploadFailure(uppy: Uppy<any, any>, fileId: string) {
  uploadFailures.get(uppy)?.delete(fileId);
}

export function messageUploadFailure(
  uppy: Uppy<any, any>,
  fileId: string,
): UploadFailure | undefined {
  return uploadFailures.get(uppy)?.get(fileId);
}

export async function fallbackFailedMessageUploads(
  uppy: Uppy<any, any>,
  files: UppyFile<any, any>[],
  signal?: AbortSignal,
): Promise<UppyFile<any, any>[]> {
  const terminalFailures = files.filter((file) => !shouldFallback(uppy, file));
  const fallbackFiles = files.filter((file) => shouldFallback(uppy, file));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const removed = (file: UppyFile<any, any>) => {
    if (fallbackFiles.some((candidate) => candidate.id === file.id)) cancel();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  uppy.on('cancel-all', cancel);
  uppy.on('file-removed', removed);
  try {
    if (signal?.aborted) cancel();
    for (let offset = 0; offset < fallbackFiles.length; offset += 3) {
      controller.signal.throwIfAborted();
      const batch = fallbackFiles.slice(offset, offset + 3);
      const results = await Promise.allSettled(
        batch.map((file) => uploadFallbackFile(uppy, file, controller.signal)),
      );
      controller.signal.throwIfAborted();
      results.forEach((result, index) => {
        if (result.status === 'rejected') terminalFailures.push(batch[index]!);
      });
    }
    return terminalFailures;
  } finally {
    signal?.removeEventListener('abort', cancel);
    uppy.off('cancel-all', cancel);
    uppy.off('file-removed', removed);
  }
}

function shouldFallback(uppy: Uppy<any, any>, file: UppyFile<any, any>) {
  const status = messageUploadFailure(uppy, file.id)?.status ?? file.response?.status;
  return status !== 401 && status !== 403 && status !== 413;
}

async function uploadFallbackFile(
  uppy: Uppy<any, any>,
  failedFile: UppyFile<any, any>,
  signal: AbortSignal,
) {
  const file = uppy.getFile(failedFile.id);
  if (!(file?.data instanceof Blob)) {
    throw new Error('Браузер більше не має доступу до файлу. Додайте його повторно.');
  }

  resetFileForFallback(uppy, file);
  try {
    const uploadURL = await sendFallbackUpload(file, signal, (bytesUploaded, bytesTotal) => {
      const currentFile = uppy.getFile(file.id);
      if (!currentFile) return;
      uppy.emit('upload-progress', currentFile, {
        uploadStarted: currentFile.progress.uploadStarted ?? Date.now(),
        uploadComplete: false,
        bytesUploaded,
        bytesTotal,
      });
    });
    signal.throwIfAborted();
    const currentFile = uppy.getFile(file.id);
    if (!currentFile) return;
    forgetMessageUploadFailure(uppy, file.id);
    uppy.emit('upload-success', currentFile, {
      status: 201,
      body: { fallback: true },
      uploadURL,
    });
  } catch (error) {
    if (signal.aborted || !uppy.getFile(file.id)) throw error;
    const status = error instanceof FallbackUploadError ? error.status : 0;
    const message = error instanceof FallbackUploadError ? error.message : fallbackErrorMessage(0);
    rememberMessageUploadFailure(uppy, file, new Error(message), status);
    uppy.setFileState(file.id, {
      error: message,
      response: status > 0 ? ({ status, body: {} } as never) : undefined,
    });
    throw error;
  }
}

function resetFileForFallback(uppy: Uppy<any, any>, file: UppyFile<any, any>) {
  uppy.setFileState(file.id, {
    error: null,
    response: undefined,
    tus: file.tus ? { ...file.tus, uploadUrl: null } : undefined,
    uploadURL: undefined,
    progress: {
      ...file.progress,
      uploadStarted: Date.now(),
      uploadComplete: false,
      percentage: 0,
      bytesUploaded: 0,
      bytesTotal: file.size,
    },
  });
}

function sendFallbackUpload(
  file: UppyFile<any, any>,
  signal: AbortSignal,
  onProgress: (bytesUploaded: number, bytesTotal: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const body = new FormData();
    body.append('file', file.data as Blob, file.name);
    const request = new XMLHttpRequest();
    let settled = false;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let bytesUploaded = 0;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(inactivityTimer);
      signal.removeEventListener('abort', cancel);
      request.upload.onprogress = null;
      request.onload = null;
      request.onerror = null;
      request.onabort = null;
      request.ontimeout = null;
      finish();
    };
    const fail = (error: unknown) => settle(() => reject(error));
    const cancel = () => {
      request.abort();
      fail(signal.reason);
    };
    const timeout = () => {
      fail(
        new FallbackUploadError(
          0,
          'Резервне завантаження перевищило час очікування. Повторіть спробу.',
        ),
      );
      request.abort();
    };
    const resetInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(timeout, MESSAGE_UPLOAD_FALLBACK_TIMEOUT_MS);
    };
    request.open('POST', MESSAGE_UPLOAD_FALLBACK_ENDPOINT);
    request.withCredentials = true;
    signal.addEventListener('abort', cancel, { once: true });
    request.upload.onprogress = (event) => {
      if (event.loaded > bytesUploaded) {
        bytesUploaded = event.loaded;
        resetInactivityTimer();
      }
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    request.onerror = () => fail(new FallbackUploadError(0, fallbackErrorMessage(0)));
    request.onabort = () => fail(new DOMException('Завантаження скасовано', 'AbortError'));
    request.ontimeout = timeout;
    request.onload = () => {
      try {
        const uploadURL = readFallbackUploadURL(request);
        settle(() => resolve(uploadURL));
      } catch (error) {
        fail(error);
      }
    };
    try {
      resetInactivityTimer();
      request.send(body);
    } catch (error) {
      fail(error);
    }
  });
}

function readFallbackUploadURL(request: XMLHttpRequest): string {
  if (request.status === 401) emitUnauthorizedEvent();
  if (request.status < 200 || request.status >= 300) {
    throw new FallbackUploadError(request.status, fallbackErrorMessage(request.status));
  }
  const response = parseFallbackResponse(request.responseText);
  if (!response) {
    throw new FallbackUploadError(
      request.status,
      'Резервне завантаження повернуло некоректну відповідь сервера.',
    );
  }
  return response.upload_url;
}

function parseFallbackResponse(value: string): FallbackUploadResponse | null {
  try {
    const response: unknown = JSON.parse(value);
    if (
      !response ||
      typeof response !== 'object' ||
      !('upload_url' in response) ||
      typeof response.upload_url !== 'string' ||
      !response.upload_url.trim()
    )
      return null;
    return { upload_url: response.upload_url };
  } catch (_) {
    return null;
  }
}

function fallbackErrorMessage(status: number): string {
  if (status === 401) return 'Сеанс завершився. Оновіть сторінку та увійдіть знову.';
  if (status === 403) return 'Недостатньо прав для завантаження файлу.';
  if (status === 413) return 'Файл завеликий для завантаження.';
  if (status > 0) return `Резервне завантаження не вдалося (HTTP ${status}).`;
  return 'Резервне завантаження не вдалося через мережеву помилку.';
}

function errorStatus(error: unknown, depth = 0): number | undefined {
  if (!error || typeof error !== 'object' || depth > 3) return undefined;
  const candidate = error as {
    cause?: unknown;
    originalResponse?: { getStatus?: () => number };
    response?: { status?: number };
    status?: number;
  };
  return (
    candidate.status ??
    candidate.response?.status ??
    candidate.originalResponse?.getStatus?.() ??
    errorStatus(candidate.cause, depth + 1)
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'Unknown upload error';
}
