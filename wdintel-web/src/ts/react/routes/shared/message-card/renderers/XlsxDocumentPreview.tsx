import { useEffect, useMemo, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';

import { XlsxGrid } from '../xlsx/XlsxGrid';
import { XlsxSheetTabs } from '../xlsx/XlsxSheetTabs';
import {
  formatXlsxPreviewErrorMessage,
  MAX_XLSX_FILE_BYTES,
  type XlsxPreviewResult,
} from '../xlsx/xlsx-preview-utils';
import { runWorkerTask } from '../workers/worker-client';
import { debugDocumentPreview } from '../document-preview-debug';

export function XlsxDocumentPreview({
  href,
  zoom,
  sizeBytes,
}: {
  href: string;
  zoom: number;
  sizeBytes?: number | null;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [workbook, setWorkbook] = useState<XlsxPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSheetIndex, setSelectedSheetIndex] = useState(0);

  useEffect(() => {
    const abortController = new AbortController();
    let disposed = false;

    const load = async () => {
      setStatus('loading');
      setWorkbook(null);
      setError(null);
      setSelectedSheetIndex(0);

      try {
        if (sizeBytes != null && sizeBytes > MAX_XLSX_FILE_BYTES) {
          throw new Error('XLSX_FILE_TOO_LARGE');
        }

        const response = await fetch(href, { signal: abortController.signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const contentLength = response.headers.get('content-length');
        if (
          contentLength != null &&
          Number.isFinite(Number(contentLength)) &&
          Number(contentLength) > MAX_XLSX_FILE_BYTES
        ) {
          throw new Error('XLSX_FILE_TOO_LARGE');
        }

        const buffer = await response.arrayBuffer();
        debugDocumentPreview('xlsx', 'fetched workbook', {
          href,
          sizeBytes,
          contentLength: response.headers.get('content-length'),
          bufferByteLength: buffer.byteLength,
        });
        if (buffer.byteLength > MAX_XLSX_FILE_BYTES) {
          throw new Error('XLSX_FILE_TOO_LARGE');
        }
        const result = await runWorkerTask<{ buffer: ArrayBuffer }, XlsxPreviewResult>(
          () =>
            new Worker(new URL('../xlsx/xlsx-preview.worker.ts', import.meta.url), {
              type: 'module',
            }),
          { buffer },
          abortController.signal,
          [buffer],
        );
        if (disposed) return;
        setWorkbook(result);
        setStatus('ready');
      } catch (error) {
        if (disposed || abortController.signal.aborted) return;
        debugDocumentPreview(
          'xlsx',
          'preview failed',
          {
            href,
            sizeBytes,
            message: error instanceof Error ? error.message : String(error),
            rawError: error,
          },
          'error',
        );
        setError(
          error instanceof Error
            ? formatXlsxPreviewErrorMessage(error.message)
            : 'Не вдалося відкрити XLSX',
        );
        setStatus('error');
      }
    };

    void load();

    return () => {
      disposed = true;
      abortController.abort();
    };
  }, [href, sizeBytes]);

  const sheet = workbook?.sheets[selectedSheetIndex] ?? null;
  const sheetNames = useMemo(
    () => workbook?.sheets.map((currentSheet) => currentSheet.name) ?? [],
    [workbook],
  );

  if (status === 'error') {
    return (
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="h6" sx={{ mb: 1, color: 'text.primary' }}>
          Помилка перегляду
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {formatXlsxPreviewErrorMessage(error)}
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
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {status === 'loading' ? (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <CircularProgress size={22} />
        </Box>
      ) : null}
      {sheet != null ? (
        <Box
          sx={{
            flex: '1 1 auto',
            minHeight: 0,
            height: '100%',
            display: 'flex',
          }}
        >
          <XlsxGrid rows={sheet.rows} zoom={zoom} truncated={sheet.truncated} />
        </Box>
      ) : null}
      {sheetNames.length > 1 ? (
        <XlsxSheetTabs
          sheetNames={sheetNames}
          selectedIndex={selectedSheetIndex}
          onSelectIndex={setSelectedSheetIndex}
        />
      ) : null}
    </Box>
  );
}
