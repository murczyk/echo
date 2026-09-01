import type Uppy from '@uppy/core';
import type { UppyFile } from '@uppy/core';

import { emitUnauthorizedEvent } from '../../../auth-redirect';

export const MESSAGE_UPLOAD_FALLBACK_ENDPOINT = '/api/sigint/file-upload/fallback';

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
): Promise<UppyFile<any, any>[]> {
  const terminalFailures = files.filter((file) => !shouldFallback(uppy, file));
  const fallbackFiles = files.filter((file) => shouldFallback(uppy, file));

  for (let offset = 0; offset < fallbackFiles.length; offset += 3) {
    const batch = fallbackFiles.slice(offset, offset + 3);
    const results = await Promise.allSettled(batch.map((file) => uploadFallbackFile(uppy, file)));
    results.forEach((result, index) => {
      if (result.status === 'rejected') terminalFailures.push(batch[index]!);
    });
  }

  return terminalFailures;
}

function shouldFallback(uppy: Uppy<any, any>, file: UppyFile<any, any>) {
  const status = messageUploadFailure(uppy, file.id)?.status ?? file.response?.status;
  return status !== 401 && status !== 403 && status !== 413;
}

async function uploadFallbackFile(uppy: Uppy<any, any>, failedFile: UppyFile<any, any>) {
  const file = uppy.getFile(failedFile.id);
  if (!(file.data instanceof Blob)) {
    throw new Error('Браузер більше не має доступу до файлу. Додайте його повторно.');
  }

  resetFileForFallback(uppy, file);
  try {
    const uploadURL = await sendFallbackUpload(file, (bytesUploaded, bytesTotal) => {
      const currentFile = uppy.getFile(file.id);
      if (!currentFile) return;
      uppy.emit('upload-progress', currentFile, {
        uploadStarted: currentFile.progress.uploadStarted ?? Date.now(),
        uploadComplete: false,
        bytesUploaded,
        bytesTotal,
      });
    });
    const currentFile = uppy.getFile(file.id);
    if (!currentFile) return;
    forgetMessageUploadFailure(uppy, file.id);
    uppy.emit('upload-success', currentFile, {
      status: 201,
      body: { fallback: true },
      uploadURL,
    });
  } catch (error) {
    const status = error instanceof FallbackUploadError ? error.status : 0;
    const message = fallbackErrorMessage(status);
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
  onProgress: (bytesUploaded: number, bytesTotal: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.append('file', file.data as Blob, file.name);
    const request = new XMLHttpRequest();
    request.open('POST', MESSAGE_UPLOAD_FALLBACK_ENDPOINT);
    request.withCredentials = true;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    request.onerror = () => reject(new FallbackUploadError(0, 'Network error'));
    request.onload = () => {
      if (request.status === 401) emitUnauthorizedEvent();
      if (request.status < 200 || request.status >= 300) {
        reject(new FallbackUploadError(request.status, request.statusText));
        return;
      }
      const response = parseFallbackResponse(request.responseText);
      if (!response?.upload_url) {
        reject(new FallbackUploadError(request.status, 'Missing upload URL'));
        return;
      }
      resolve(response.upload_url);
    };
    request.send(body);
  });
}

function parseFallbackResponse(value: string): FallbackUploadResponse | null {
  try {
    return JSON.parse(value) as FallbackUploadResponse;
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
