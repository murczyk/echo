import DownloadIcon from '@mui/icons-material/Download';
import { CircularProgress, IconButton, Typography } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MessageCardDocument } from '../document-preview.types';
import { fetchCachedDocumentResponse } from '../document-preview-utils';
import { deriveDocumentDownloadName, deriveDocumentFileName } from '../message-card-document-utils';
import { formatSizeBytes } from '../message-card-image-utils';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import type { MessageCardPreviewNavigation } from '../attachment-preview/message-card-preview.types';
import { runWorkerTask, WorkerTaskTimeoutError } from '../workers/worker-client';
import type { ZipEntry, ZipListing } from '../zip-preview.types';

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
  error,
}: {
  entry: ZipEntry;
  onDownload: (entry: ZipEntry) => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <li
      className="flex items-center gap-2 border-b border-divider px-3 py-2 last:border-b-0"
      data-zip-entry-index={entry.index}
    >
      <div className="min-w-0 flex-1">
        <Typography noWrap title={entry.path}>
          {entry.directory ? `📁 ${entry.path}` : `📄 ${entry.path}`}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {entry.directory ? 'Папка' : `${formatSizeBytes(entry.uncompressedSize)} розпаковано`}
          {entry.unavailableReason ? ` · ${entry.unavailableReason}` : ''}
        </Typography>
        {error ? (
          <Typography variant="caption" color="error.main" display="block">
            {error}
          </Typography>
        ) : null}
      </div>
      {!entry.directory ? (
        <IconButton
          aria-label={`Скачати ${entry.path}`}
          disabled={busy || Boolean(entry.unavailableReason)}
          onClick={(event) => {
            event.stopPropagation();
            onDownload(entry);
          }}
          size="small"
        >
          {busy ? <CircularProgress size={16} /> : <DownloadIcon fontSize="small" />}
        </IconButton>
      ) : null}
    </li>
  );
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
  const [listing, setListing] = useState<ZipListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const archiveRef = useRef<ArrayBuffer | null>(null);
  const memberControllerRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  const activeDocumentHrefRef = useRef(document.href);
  activeDocumentHrefRef.current = document.href;
  const fileName = useMemo(
    () => deriveDocumentFileName(document, navigation.index),
    [document, navigation.index],
  );
  const downloadName = useMemo(
    () => deriveDocumentDownloadName(document, navigation.index),
    [document, navigation.index],
  );
  useEffect(() => {
    const controller = new AbortController();
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
        if (document.sizeBytes != null && document.sizeBytes > ZIP_MAX_BYTES)
          throw new Error(ZIP_TOO_LARGE_ERROR);
        const response = await fetchCachedDocumentResponse(
          document.href,
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
        if (requestGenerationRef.current !== requestGeneration) return;
        const nextError = fetchTimedOut ? ZIP_FETCH_TIMEOUT_ERROR : messageForZipError(cause);
        if (nextError) setError(nextError);
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
      memberControllerRef.current?.abort();
      memberControllerRef.current = null;
      archiveRef.current = null;
    };
  }, [document.href, document.sizeBytes]);
  const downloadMember = useCallback(
    async (entry: ZipEntry) => {
      const archive = archiveRef.current;
      if (!archive || busyIndex != null) return;
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
          activeDocumentHrefRef.current !== document.href
        )
          return;
        const url = URL.createObjectURL(new Blob([output]));
        const anchor = window.document.createElement('a');
        try {
          if (
            controller.signal.aborted ||
            requestGenerationRef.current !== requestGeneration ||
            activeDocumentHrefRef.current !== document.href
          )
            return;
          anchor.href = url;
          anchor.download = safeBasename(entry.path, `zip-member-${entry.index + 1}`);
          anchor.style.display = 'none';
          window.document.body.append(anchor);
          anchor.click();
          const timer = window.setTimeout(() => {
            revokeDownloadUrl(url);
          }, ZIP_DOWNLOAD_URL_CLEANUP_DELAY_MS);
          activeDownloadUrls.set(url, timer);
        } finally {
          anchor.remove();
          if (!activeDownloadUrls.has(url)) revokeDownloadUrl(url);
        }
      } catch (cause) {
        if (
          !controller.signal.aborted &&
          requestGenerationRef.current === requestGeneration &&
          activeDocumentHrefRef.current === document.href
        )
          setMemberError(messageForZipError(cause) || 'Не вдалося розпакувати файл.');
      } finally {
        if (
          requestGenerationRef.current === requestGeneration &&
          activeDocumentHrefRef.current === document.href
        )
          setBusyIndex(null);
        if (memberControllerRef.current === controller) memberControllerRef.current = null;
      }
    },
    [busyIndex, document.href],
  );
  const stage = (
    <div
      className="min-h-0 flex-1 overflow-auto p-3"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Typography variant="body2" color="text.secondary" className="mb-2">
        {listing
          ? `Файлів: ${listing.entries.length}; розпаковано: ${formatSizeBytes(listing.totalUncompressedSize)}`
          : 'Читання структури ZIP…'}
      </Typography>
      {error ? <Typography color="error.main">{error}</Typography> : null}
      {memberError ? (
        <Typography color="error.main" className="mb-2">
          {memberError}
        </Typography>
      ) : null}
      {!error && !listing ? <CircularProgress aria-label="Читання ZIP" /> : null}
      {listing?.entries.length === 0 ? <Typography>Архів порожній.</Typography> : null}
      {listing ? (
        <ul className="m-0 list-none overflow-hidden rounded border border-divider p-0">
          {listing.entries.map((entry) => (
            <ZipRow
              key={entry.index}
              entry={entry}
              busy={busyIndex === entry.index}
              error={null}
              onDownload={downloadMember}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
  return (
    <MessageCardAttachmentPreviewLayout
      navigation={navigation}
      swipeEnabled={false}
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
      stage={stage}
    />
  );
}
