import DownloadIcon from '@mui/icons-material/Download';
import { CircularProgress, IconButton, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  FilePreviewLifecycleProps,
  FilePreviewSource,
} from '../attachment-preview/file-preview-source';
import { FilePreviewRenderError } from '../attachment-preview/file-preview-source';
import { HttpRequestError } from '../../../../services/api/client';
import type { MessageCardDocument } from '../document-preview.types';
import { fetchCachedDocumentResponse } from '../document-preview-utils';
import { deriveDocumentDownloadName, deriveDocumentFileName } from '../message-card-document-utils';
import { formatSizeBytes } from '../message-card-image-utils';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import type { MessageCardPreviewNavigation } from '../attachment-preview/message-card-preview.types';
import { runWorkerTask, WorkerTaskTimeoutError } from '../workers/worker-client';
import type { ZipEntry, ZipListing } from '../zip-preview.types';
import { ArchivePreviewList, ArchivePreviewRow } from './ArchivePreviewList';

const ZIP_FETCH_TIMEOUT_MS = 20_000;
const ZIP_WORKER_TIMEOUT_MS = 10_000;
const ZIP_MAX_BYTES = 25 * 1024 * 1024;
const ZIP_TOO_LARGE_ERROR = 'ZIP перевищує ліміт 25 МіБ для попереднього перегляду.';
const ZIP_FETCH_TIMEOUT_ERROR = 'Час очікування завантаження ZIP вичерпано.';
const ZIP_DOWNLOAD_URL_CLEANUP_DELAY_MS = 1_000;
const activeDownloadUrls = new Map<string, number>();

function revokeDownloadUrl(url: string): void {
  const timer = activeDownloadUrls.get(url);
  if (timer != null) window.clearTimeout(timer);
  if (activeDownloadUrls.delete(url) || timer == null) URL.revokeObjectURL(url);
}

function messageForZipError(error: unknown): string {
  if (error instanceof WorkerTaskTimeoutError) return 'Час очікування обробки ZIP вичерпано.';
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  if (error instanceof Error && /^HTTP 401/.test(error.message))
    return 'Потрібна повторна авторизація для завантаження ZIP.';
  if (error instanceof Error && /^HTTP/.test(error.message))
    return 'Не вдалося завантажити ZIP через помилку мережі.';
  return error instanceof Error ? error.message : 'Не вдалося відкрити ZIP.';
}
function safeBasename(path: string, fallback: string): string {
  const name = path
    .split('/')
    .filter(Boolean)
    .at(-1)
    ?.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim();
  return name && name !== '.' && name !== '..' ? name.slice(0, 240) : fallback;
}

function ZipRow({
  entry,
  onDownload,
  busy,
}: {
  entry: ZipEntry;
  onDownload: (entry: ZipEntry) => void;
  busy: boolean;
}) {
  return (
    <li data-zip-entry-index={entry.index}>
      <ArchivePreviewRow
        name={entry.path}
        directory={entry.directory}
        sizeBytes={entry.uncompressedSize}
        unavailableReason={entry.unavailableReason}
        action={
          !entry.directory ? (
            <IconButton
              aria-label={`Скачати ${entry.path}`}
              disabled={busy || Boolean(entry.unavailableReason)}
              onClick={(event) => {
                event.stopPropagation();
                onDownload(entry);
              }}
              size="small"
              className="shrink-0"
            >
              {busy ? <CircularProgress size={16} /> : <DownloadIcon fontSize="small" />}
            </IconButton>
          ) : undefined
        }
      />
    </li>
  );
}

export function ZipFilePreview({
  source,
  lifecycle,
  checkAccess,
}: {
  source: FilePreviewSource;
  lifecycle?: FilePreviewLifecycleProps;
  checkAccess?: () => Promise<boolean>;
}) {
  const signal = lifecycle?.signal;
  const onError = lifecycle?.onError;
  const isCurrent = lifecycle?.isCurrent;
  const registerCleanup = lifecycle?.registerCleanup;
  const downloadUrls = useRef(new Set<string>());
  const [listing, setListing] = useState<ZipListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const archiveRef = useRef<ArrayBuffer | null>(null);
  const memberControllerRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  const activeDocumentHrefRef = useRef(source.originalHref);
  activeDocumentHrefRef.current = source.originalHref;
  useEffect(() => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => {
      controller.abort();
      memberControllerRef.current?.abort();
      archiveRef.current = null;
      if (signal || registerCleanup) for (const url of downloadUrls.current) revokeDownloadUrl(url);
      downloadUrls.current.clear();
    };
    const unregister = registerCleanup?.(cleanup);
    const requestGeneration = ++requestGenerationRef.current;
    memberControllerRef.current?.abort();
    memberControllerRef.current = null;
    let fetchTimedOut = false;
    const timeout = window.setTimeout(() => {
      fetchTimedOut = true;
      controller.abort();
    }, ZIP_FETCH_TIMEOUT_MS);
    archiveRef.current = null;
    setListing(null);
    setError(null);
    setMemberError(null);
    setBusyIndex(null);
    void (async () => {
      try {
        if (controller.signal.aborted || isCurrent?.() === false) return;
        if (source.sizeBytes != null && source.sizeBytes > ZIP_MAX_BYTES)
          throw new Error(ZIP_TOO_LARGE_ERROR);
        const response = await fetchCachedDocumentResponse(
          source.originalHref,
          ZIP_MAX_BYTES,
          ZIP_TOO_LARGE_ERROR,
          controller.signal,
        );
        window.clearTimeout(timeout);
        archiveRef.current = response.buffer.slice(0);
        const result = await runWorkerTask<{ type: 'list'; buffer: ArrayBuffer }, ZipListing>(
          () =>
            new Worker(new URL('../zip-preview.worker.ts', import.meta.url), { type: 'module' }),
          { type: 'list', buffer: response.buffer },
          controller.signal,
          [response.buffer],
          ZIP_WORKER_TIMEOUT_MS,
        );
        if (!controller.signal.aborted && requestGenerationRef.current === requestGeneration)
          setListing(result);
      } catch (cause) {
        if (
          requestGenerationRef.current !== requestGeneration ||
          signal?.aborted ||
          isCurrent?.() === false
        )
          return;
        if (!controller.signal.aborted || fetchTimedOut)
          onError?.(
            cause instanceof HttpRequestError
              ? cause
              : new FilePreviewRenderError(
                  fetchTimedOut ? ZIP_FETCH_TIMEOUT_ERROR : messageForZipError(cause),
                  fetchTimedOut || cause instanceof WorkerTaskTimeoutError,
                ),
          );
        const nextError = fetchTimedOut ? ZIP_FETCH_TIMEOUT_ERROR : messageForZipError(cause);
        if (nextError) setError(nextError);
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => {
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      cleanup();
      unregister?.();
      memberControllerRef.current = null;
    };
  }, [source.originalHref, source.sizeBytes, signal, onError, isCurrent, registerCleanup]);
  const downloadMember = useCallback(
    async (entry: ZipEntry) => {
      const archive = archiveRef.current;
      if (!archive || busyIndex != null || signal?.aborted || isCurrent?.() === false) return;
      const requestGeneration = requestGenerationRef.current;
      const controller = new AbortController();
      memberControllerRef.current?.abort();
      memberControllerRef.current = controller;
      setBusyIndex(entry.index);
      setMemberError(null);
      try {
        const workerBuffer = archive.slice(0);
        const output = await runWorkerTask<
          { type: 'extract'; buffer: ArrayBuffer; entry: ZipEntry },
          ArrayBuffer
        >(
          () =>
            new Worker(new URL('../zip-preview.worker.ts', import.meta.url), { type: 'module' }),
          { type: 'extract', buffer: workerBuffer, entry },
          controller.signal,
          [workerBuffer],
          ZIP_WORKER_TIMEOUT_MS,
        );
        if (
          controller.signal.aborted ||
          requestGenerationRef.current !== requestGeneration ||
          activeDocumentHrefRef.current !== source.originalHref
        )
          return;
        if (checkAccess && !(await checkAccess())) return;
        if (signal?.aborted || isCurrent?.() === false) return;
        const url = URL.createObjectURL(new Blob([output]));
        const anchor = window.document.createElement('a');
        try {
          if (
            controller.signal.aborted ||
            requestGenerationRef.current !== requestGeneration ||
            activeDocumentHrefRef.current !== source.originalHref
          )
            return;
          anchor.href = url;
          anchor.download = safeBasename(entry.path, `zip-member-${entry.index + 1}`);
          anchor.style.display = 'none';
          window.document.body.append(anchor);
          anchor.click();
          const timer = window.setTimeout(() => {
            revokeDownloadUrl(url);
            downloadUrls.current.delete(url);
          }, ZIP_DOWNLOAD_URL_CLEANUP_DELAY_MS);
          activeDownloadUrls.set(url, timer);
          downloadUrls.current.add(url);
        } finally {
          anchor.remove();
          if (!activeDownloadUrls.has(url)) revokeDownloadUrl(url);
        }
      } catch (cause) {
        if (
          !controller.signal.aborted &&
          requestGenerationRef.current === requestGeneration &&
          activeDocumentHrefRef.current === source.originalHref
        ) {
          onError?.(cause);
          setMemberError(messageForZipError(cause) || 'Не вдалося розпакувати файл.');
        }
      } finally {
        if (
          requestGenerationRef.current === requestGeneration &&
          activeDocumentHrefRef.current === source.originalHref
        )
          setBusyIndex(null);
        if (memberControllerRef.current === controller) memberControllerRef.current = null;
      }
    },
    [busyIndex, source.originalHref, signal, isCurrent, onError, checkAccess],
  );
  const loading = !listing && !error;
  const stage = (
    <div
      className={`min-h-0 flex-1 overflow-auto px-3 ${loading ? 'grid place-items-center' : ''}`}
      style={{
        paddingTop: 'calc(var(--attachment-preview-content-inset, 0px) + 1rem)',
        paddingBottom: 'max(1rem, var(--attachment-preview-content-bottom-inset, 0px))',
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {loading ? (
        <div role="status" className="flex flex-col items-center gap-3 text-center">
          <CircularProgress size={22} aria-label="Читання ZIP" />
          <Typography variant="body2" color="text.secondary">
            Читання структури ZIP…
          </Typography>
        </div>
      ) : (
        <>
          {listing ? (
            <Typography variant="body2" color="text.secondary" className="mb-2">
              {`Файлів: ${listing.entries.length}; розпаковано: ${formatSizeBytes(listing.totalUncompressedSize)}`}
            </Typography>
          ) : null}
          {error ? <Typography color="error.main">{error}</Typography> : null}
          {memberError ? (
            <Typography color="error.main" className="mb-2">
              {memberError}
            </Typography>
          ) : null}
          {listing?.entries.length === 0 ? <Typography>Архів порожній.</Typography> : null}
          {listing ? (
            <ArchivePreviewList>
              {listing.entries.map((entry) => (
                <ZipRow
                  key={entry.index}
                  entry={entry}
                  busy={busyIndex === entry.index}
                  onDownload={downloadMember}
                />
              ))}
            </ArchivePreviewList>
          ) : null}
        </>
      )}
    </div>
  );
  return stage;
}

export function ZipDocumentPreview({
  document,
  navigation,
  onClose,
  isDownloadStarting,
  onDownloadStart,
}: {
  document: MessageCardDocument;
  navigation: MessageCardPreviewNavigation;
  onClose: () => void;
  isDownloadStarting: (key: string) => boolean;
  onDownloadStart: (key: string) => boolean;
}) {
  const fileName = deriveDocumentFileName(document, navigation.index);
  const downloadName = deriveDocumentDownloadName(document, navigation.index);
  return (
    <MessageCardAttachmentPreviewLayout
      mobileChrome="toggle"
      navigation={navigation}
      swipeEnabled={false}
      onScrollBoundaryDismiss={onClose}
      header={
        <MessageCardAttachmentPreviewHeader
          fileName={fileName}
          openHref={document.href}
          download={{ href: document.href, fileName: downloadName }}
          downloadKey={document.href}
          navigation={navigation}
          onClose={onClose}
          isDownloadStarting={isDownloadStarting}
          onDownloadStart={onDownloadStart}
        />
      }
      stage={
        <ZipFilePreview
          source={{
            key: document.href,
            fileName,
            extension: 'zip',
            contentType: document.contentType ?? '',
            sizeBytes: document.sizeBytes ?? null,
            originalHref: document.href,
          }}
        />
      }
    />
  );
}
