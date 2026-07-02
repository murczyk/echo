import { useEffect, useMemo, useState } from 'react';
import { Box, CircularProgress, Typography, useTheme } from '@mui/material';

import { buildDocxHtmlDocument } from '../docx/build-docx-html-document';
import { sanitizeDocxHtml } from '../docx/sanitize-docx-html';
import { runWorkerTask } from '../workers/worker-client';

type DocxPreviewResult = {
  html: string;
};

const MAX_DOCX_FILE_MB = 10;
const MAX_DOCX_FILE_BYTES = MAX_DOCX_FILE_MB * 1024 * 1024;

function formatDocxPreviewErrorMessage(error: string | null): string {
  if (error === 'DOCX_FILE_TOO_LARGE') {
    return `Файл DOCX завеликий для попереднього перегляду. Максимум: ${MAX_DOCX_FILE_MB} МБ.`;
  }
  return error ?? 'DOCX недоступний';
}

export function DocxDocumentPreview({
  href,
  zoom,
  sizeBytes,
}: {
  href: string;
  zoom: number;
  sizeBytes?: number | null;
}) {
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
        if (sizeBytes != null && sizeBytes > MAX_DOCX_FILE_BYTES) {
          throw new Error('DOCX_FILE_TOO_LARGE');
        }

        const response = await fetch(href, { signal: abortController.signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const contentLength = response.headers.get('content-length');
        if (
          contentLength != null &&
          Number.isFinite(Number(contentLength)) &&
          Number(contentLength) > MAX_DOCX_FILE_BYTES
        ) {
          throw new Error('DOCX_FILE_TOO_LARGE');
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_DOCX_FILE_BYTES) {
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
        if (disposed) return;
        const sanitizedHtml = sanitizeDocxHtml(result.html);
        setHtml(sanitizedHtml);
        setStatus('ready');
      } catch (error) {
        if (disposed || abortController.signal.aborted) return;
        setError(formatDocxPreviewErrorMessage(error instanceof Error ? error.message : null));
        setStatus('error');
      }
    };

    void load();

    return () => {
      disposed = true;
      abortController.abort();
    };
  }, [href, sizeBytes]);

  const srcDoc = useMemo(() => buildDocxHtmlDocument(html, zoom), [html, zoom]);

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
          }}
        />
      ) : null}
    </Box>
  );
}
