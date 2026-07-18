import { useEffect, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';

import { XlsxGrid } from '../xlsx/XlsxGrid';
import { runWorkerTask } from '../workers/worker-client';
import {
  formatCsvPreviewErrorMessage,
  MAX_CSV_FILE_BYTES,
  type CsvPreviewResult,
} from '../csv/csv-preview-utils';

export function CsvDocumentPreview({
  href,
  zoom,
  sizeBytes,
  contentType,
}: {
  href: string;
  zoom: number;
  sizeBytes?: number | null;
  contentType?: string | null;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [preview, setPreview] = useState<CsvPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    const load = async () => {
      setStatus('loading');
      setPreview(null);
      setError(null);
      try {
        if (sizeBytes != null && sizeBytes > MAX_CSV_FILE_BYTES)
          throw new Error('CSV_FILE_TOO_LARGE');
        const response = await fetch(href, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_CSV_FILE_BYTES) {
          throw new Error('CSV_FILE_TOO_LARGE');
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_CSV_FILE_BYTES) throw new Error('CSV_FILE_TOO_LARGE');
        const responseContentType = response.headers.get('content-type');
        const effectiveContentType =
          responseContentType?.match(/charset\s*=/i) != null
            ? responseContentType
            : (contentType ?? responseContentType);
        const result = await runWorkerTask<
          { buffer: ArrayBuffer; contentType: string | null },
          CsvPreviewResult
        >(
          () =>
            new Worker(new URL('../csv/csv-preview.worker.ts', import.meta.url), {
              type: 'module',
            }),
          { buffer, contentType: effectiveContentType },
          controller.signal,
          [buffer],
        );
        if (disposed) return;
        setPreview(result);
        setStatus('ready');
      } catch (loadError) {
        if (disposed || controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : null);
        setStatus('error');
      }
    };
    void load();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [contentType, href, sizeBytes]);

  if (status === 'error') {
    return (
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="h6" sx={{ mb: 1, color: 'text.primary' }}>
          Помилка перегляду
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {formatCsvPreviewErrorMessage(error)}
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{ width: '100%', height: '100%', minHeight: 0, display: 'flex', position: 'relative' }}
    >
      {status === 'loading' ? (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <CircularProgress size={22} />
        </Box>
      ) : null}
      {preview != null ? (
        <Box sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex' }}>
          <XlsxGrid
            rows={preview.rows}
            zoom={zoom}
            truncated={preview.truncated}
            truncationNotice="Показано перші 5000 рядків або 100 колонок."
          />
        </Box>
      ) : null}
    </Box>
  );
}
