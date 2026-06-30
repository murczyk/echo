import { useEffect, useMemo, useState } from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';

import { XlsxGrid } from '../xlsx/XlsxGrid';
import { XlsxSheetTabs } from '../xlsx/XlsxSheetTabs';
import { formatXlsxPreviewErrorMessage, type XlsxPreviewResult } from '../xlsx/xlsx-preview-utils';
import { runWorkerTask } from '../workers/worker-client';

export function XlsxDocumentPreview({ href, zoom }: { href: string; zoom: number }) {
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
        const response = await fetch(href, { signal: abortController.signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        const result = await runWorkerTask<{ buffer: ArrayBuffer }, XlsxPreviewResult>(
          () => new Worker(new URL('../xlsx/xlsx-preview.worker.ts', import.meta.url), { type: 'module' }),
          { buffer },
          abortController.signal,
        );
        if (disposed) return;
        setWorkbook(result);
        setStatus('ready');
      } catch (error) {
        if (disposed || abortController.signal.aborted) return;
        setError(error instanceof Error ? formatXlsxPreviewErrorMessage(error.message) : 'Не вдалося відкрити XLSX');
        setStatus('error');
      }
    };

    void load();

    return () => {
      disposed = true;
      abortController.abort();
    };
  }, [href]);

  const sheet = workbook?.sheets[selectedSheetIndex] ?? null;
  const sheetNames = useMemo(() => workbook?.sheets.map((currentSheet) => currentSheet.name) ?? [], [workbook]);

  if (status === 'error') {
    return (
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="h6" sx={{ mb: 1, color: 'rgba(244, 247, 251, 0.92)' }}>
          Помилка перегляду
        </Typography>
        <Typography variant="body2" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
          {formatXlsxPreviewErrorMessage(error)}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {status === 'loading' ? (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <CircularProgress size={22} />
        </Box>
      ) : null}
      {sheetNames.length > 1 ? (
        <XlsxSheetTabs sheetNames={sheetNames} selectedIndex={selectedSheetIndex} onSelectIndex={setSelectedSheetIndex} />
      ) : null}
      {sheet != null ? (
        <Box sx={{ flex: '1 1 auto', minHeight: 0, height: '100%', display: 'flex' }}>
          <XlsxGrid rows={sheet.rows} zoom={zoom} truncated={sheet.truncated} />
        </Box>
      ) : null}
    </Box>
  );
}
