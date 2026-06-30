import { useEffect, useMemo, useState } from 'react';
import { Box, CircularProgress, Typography, useTheme } from '@mui/material';

import { buildDocxHtmlDocument } from '../docx/build-docx-html-document';
import { sanitizeDocxHtml } from '../docx/sanitize-docx-html';
import { runWorkerTask } from '../workers/worker-client';

type DocxPreviewResult = {
  html: string;
};

export function DocxDocumentPreview({ href, zoom }: { href: string; zoom: number }) {
  const theme = useTheme();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [html, setHtml] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abortController = new AbortController();
    let disposed = false;

    const load = async () => {
      setStatus('loading');
      setError(null);
      setHtml('');

      try {
        const response = await fetch(href, { signal: abortController.signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        const result = await runWorkerTask<{ buffer: ArrayBuffer }, DocxPreviewResult>(
          () => new Worker(new URL('../docx/docx-preview.worker.ts', import.meta.url), { type: 'module' }),
          { buffer },
          abortController.signal,
        );
        if (disposed) return;
        const sanitizedHtml = sanitizeDocxHtml(result.html);
        setHtml(sanitizedHtml);
        setStatus('ready');
      } catch (error) {
        if (disposed || abortController.signal.aborted) return;
        setError(error instanceof Error ? error.message : 'Не вдалося відкрити DOCX');
        setStatus('error');
      }
    };

    void load();

    return () => {
      disposed = true;
      abortController.abort();
    };
  }, [href]);

  const srcDoc = useMemo(() => buildDocxHtmlDocument(html, zoom), [html, zoom]);

  if (status === 'error') {
    return (
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="h6" sx={{ mb: 1, color: 'rgba(244, 247, 251, 0.92)' }}>
          Помилка перегляду
        </Typography>
        <Typography variant="body2" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
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
        position: 'relative',
        backgroundColor: theme.palette.background.default,
      }}
    >
      {status === 'loading' ? (
        <Box sx={{ position: 'absolute', inset: 0, zIndex: 2, display: 'grid', placeItems: 'center' }}>
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
            background: theme.palette.background.paper,
          }}
        />
      ) : null}
    </Box>
  );
}
