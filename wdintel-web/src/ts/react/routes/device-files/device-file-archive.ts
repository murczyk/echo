import type { DeviceFileTreeEntry } from '../../../../Bindings';
import { HttpRequestError } from '../../services/api/client';
import { deviceFileContentUrl } from '../../services/api/devices';
import {
  getDeviceFilePreviewContentSize,
  withDevicePreviewDeadline,
} from '../../services/api/device-file-preview';
import {
  FilePreviewRenderError,
  normalizeFilePreviewMetadata,
} from '../shared/message-card/attachment-preview/file-preview-source';
import { fetchCachedDocumentResponse } from '../shared/message-card/document-preview-utils';
import { getFilePreviewKind } from '../shared/message-card/file-preview-kind';
import {
  runWorkerTask,
  WorkerTaskTimeoutError,
} from '../shared/message-card/workers/worker-client';
import type { ZipEntry, ZipListing } from '../shared/message-card/zip-preview.types';

const ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;
const ARCHIVE_MAX_DEPTH = 8;
const ARCHIVE_READ_TIMEOUT_MS = 20_000;
const ARCHIVE_WORKER_TIMEOUT_MS = 10_000;

export type DeviceFileSelection = DeviceFileTreeEntry & {
  archiveMember?: { source: DeviceFileTreeEntry; members: ZipEntry[] };
};

export function isDeviceArchive(file: DeviceFileTreeEntry) {
  return (
    file.kind === 'file' &&
    getFilePreviewKind({
      ...normalizeFilePreviewMetadata({
        fileName: file.name,
        extension: file.extension,
        contentType: file.mimeType,
      }),
      key: file.entryId,
      originalHref: '',
      sizeBytes: null,
    }) === 'zip'
  );
}

export function archiveMemberSelection(
  archive: DeviceFileSelection,
  entry: ZipEntry,
): DeviceFileSelection {
  const segments = entry.path.split('/').filter(Boolean);
  const name = segments.at(-1)!;
  return {
    ...archive,
    entryId: `${archive.entryId}/zip/${entry.index}`,
    parentEntryId: archive.entryId,
    name,
    kind: 'file',
    absolutePath: `${archive.absolutePath ?? archive.pathComponents.join(' / ')} / ${entry.path}`,
    pathComponents: [...archive.pathComponents, ...segments],
    extension: normalizeFilePreviewMetadata({ fileName: name }).extension,
    mimeType: null,
    tags: [],
    archiveMember: {
      source: archive.archiveMember?.source ?? archive,
      members: [...(archive.archiveMember?.members ?? []), entry],
    },
  };
}

export function archiveContentHref(deviceId: string, file: DeviceFileSelection) {
  const source = file.archiveMember?.source ?? file;
  if (!source.hasContent || !source.fileId || source.revision == null)
    throw new FilePreviewRenderError('Вміст архіву ще не завантажено в Echo.');
  return deviceFileContentUrl(deviceId, source.fileId, source.revision);
}

async function zipTask<T>(
  request:
    | { type: 'list'; buffer: ArrayBuffer }
    | { type: 'extract'; buffer: ArrayBuffer; entry: ZipEntry },
  signal: AbortSignal,
) {
  try {
    return await runWorkerTask<typeof request, T>(
      () =>
        new Worker(new URL('../shared/message-card/zip-preview.worker.ts', import.meta.url), {
          type: 'module',
        }),
      request,
      signal,
      [request.buffer],
      ARCHIVE_WORKER_TIMEOUT_MS,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw new FilePreviewRenderError(
      error instanceof WorkerTaskTimeoutError
        ? 'Час очікування обробки ZIP вичерпано.'
        : error instanceof Error
          ? error.message
          : 'Не вдалося прочитати ZIP.',
      error instanceof WorkerTaskTimeoutError,
    );
  }
}

export async function readDeviceArchiveBytes(
  deviceId: string,
  file: DeviceFileSelection,
  signal: AbortSignal,
) {
  const members = file.archiveMember?.members ?? [];
  if (members.length > ARCHIVE_MAX_DEPTH)
    throw new FilePreviewRenderError('Перевищено глибину вкладених ZIP-архівів.');
  const unavailable = members.find((entry) => entry.unavailableReason);
  if (unavailable) throw new FilePreviewRenderError(unavailable.unavailableReason!);
  const response = await withDevicePreviewDeadline(
    signal,
    ARCHIVE_READ_TIMEOUT_MS,
    (requestSignal) =>
      fetchCachedDocumentResponse(
        archiveContentHref(deviceId, file),
        ARCHIVE_MAX_BYTES,
        'ZIP перевищує ліміт 25 МіБ для попереднього перегляду.',
        requestSignal,
      ),
  );
  let buffer = response.buffer;
  for (const entry of members) {
    if (buffer.byteLength > ARCHIVE_MAX_BYTES)
      throw new FilePreviewRenderError('ZIP перевищує ліміт 25 МіБ для попереднього перегляду.');
    buffer = await zipTask<ArrayBuffer>({ type: 'extract', buffer, entry }, signal);
  }
  return buffer;
}

export async function listDeviceArchive(
  deviceId: string,
  file: DeviceFileSelection,
  signal: AbortSignal,
) {
  try {
    const buffer = await readDeviceArchiveBytes(deviceId, file, signal);
    if (buffer.byteLength > ARCHIVE_MAX_BYTES)
      throw new FilePreviewRenderError('ZIP перевищує ліміт 25 МіБ для попереднього перегляду.');
    const listing = await zipTask<ZipListing>({ type: 'list', buffer }, signal);
    await getDeviceFilePreviewContentSize(archiveContentHref(deviceId, file), signal);
    const directories = new Set<string>();
    listing.entries = listing.entries
      .map((entry) => ({
        ...entry,
        path:
          entry.path
            .split('/')
            .filter((part) => part && part !== '.')
            .join('/') + (entry.directory ? '/' : ''),
      }))
      .filter((entry) => {
        if (!entry.directory) {
          if (!entry.path)
            throw new FilePreviewRenderError('Архів містить некоректну назву файлу.');
          return true;
        }
        if (entry.path === '/' || directories.has(entry.path)) return false;
        directories.add(entry.path);
        return true;
      });
    return listing;
  } catch (error) {
    if (
      error instanceof HttpRequestError ||
      signal.aborted ||
      error instanceof FilePreviewRenderError
    )
      throw error;
    throw new FilePreviewRenderError(
      error instanceof Error ? error.message : 'Не вдалося прочитати ZIP.',
    );
  }
}
