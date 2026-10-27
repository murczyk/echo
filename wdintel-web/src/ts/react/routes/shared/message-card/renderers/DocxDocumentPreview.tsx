import { useEffect, useMemo, useState } from 'react';
import { Box, CircularProgress, Typography, useTheme } from '@mui/material';

import { buildDocxHtmlDocument } from '../docx/build-docx-html-document';
import type { DocxPageSize, DocxPreviewResult } from '../docx/docx-preview.types';
import { sanitizeDocxHtml } from '../docx/sanitize-docx-html';
import { fetchCachedDocumentResponse } from '../document-preview-utils';
import { runWorkerTask } from '../workers/worker-client';

const MAX_DOCX_FILE_MB = 10;
const MAX_DOCX_FILE_BYTES = MAX_DOCX_FILE_MB * 1024 * 1024;

export function formatDocxPreviewErrorMessage(error: string | null): string {
  if (error === 'DOCX_FILE_TOO_LARGE') {
    return `Файл DOCX завеликий для попереднього перегляду. Максимум: ${MAX_DOCX_FILE_MB} МБ.`;
  }
  return error ?? 'DOCX недоступний';
}

export function DocxDocumentPreview({
  href,
  zoom,
  sizeBytes,
  maxBytes = MAX_DOCX_FILE_BYTES,
  onError,
  signal,
}: {
  href: string;
  zoom: number;
  sizeBytes?: number | null;
  maxBytes?: number;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
}) {
  const theme = useTheme();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [html, setHtml] = useState('');
  const [pageSize, setPageSize] = useState<DocxPageSize | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let disposed = false;

    const load = async () => {
      setStatus('loading');
      setError(null);
      setHtml('');
      setPageSize(null);
      if (abortController.signal.aborted) return;

      try {
        if (sizeBytes != null && sizeBytes > maxBytes) {
          throw new Error('DOCX_FILE_TOO_LARGE');
        }

        const { buffer, contentLength } = await fetchCachedDocumentResponse(
          href,
          maxBytes,
          'DOCX_FILE_TOO_LARGE',
          abortController.signal,
        );

        if (contentLength != null && contentLength > maxBytes) {
          throw new Error('DOCX_FILE_TOO_LARGE');
        }

        if (buffer.byteLength > maxBytes) {
          throw new Error('DOCX_FILE_TOO_LARGE');
        }
        const result = await runWorkerTask<{ buffer: ArrayBuffer }, DocxPreviewResult>(
          () =>
            new Worker(new URL('../docx/docx-preview.worker.ts', import.meta.url), {
              type: 'module',
            }),
          { buffer },
          abortController.signal,
          [buffer],
        );
        if (disposed || abortController.signal.aborted) return;
        setHtml(sanitizeDocxHtml(result.html));
        setPageSize(result.pageSize);
        setStatus('ready');
      } catch (error) {
        if (disposed || abortController.signal.aborted) return;
        onError?.(error);
        setError(formatDocxPreviewErrorMessage(error instanceof Error ? error.message : null));
        setStatus('error');
      }
    };

    void load();

    return () => {
      disposed = true;
      signal?.removeEventListener('abort', abort);
      abortController.abort();
    };
  }, [href, sizeBytes, maxBytes, onError, signal]);

  const srcDoc = useMemo(
    () => buildDocxHtmlDocument(html, pageSize, zoom, theme.palette.mode),
    [html, pageSize, zoom, theme.palette.mode],
  );

  if (status === 'error') {
    return (
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="h6" sx={{ mb: 1, color: 'text.primary' }}>
          Помилка перегляду
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {error ?? 'DOCX недоступний'}
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        minHeight: 0,
        borderRadius: 1,
        backgroundColor: 'transparent',
      }}
    >
      {status === 'loading' ? (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 2,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <CircularProgress size={22} />
        </Box>
      ) : null}
      {status === 'ready' ? (
        <iframe
          title="DOCX preview"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          style={{
            width: '100%',
            height: '100%',
            border: 0,
            background: 'transparent',
            colorScheme: theme.palette.mode,
          }}
        />
      ) : null}
    </Box>
  );
}
