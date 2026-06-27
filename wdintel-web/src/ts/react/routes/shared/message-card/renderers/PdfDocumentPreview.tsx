import { useEffect, useMemo, useState } from 'react';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

const PDF_PAGE_MAX_WIDTH_PX = 920;
const PDF_DOCUMENT_OPTIONS = { useWorkerFetch: true };

export function PdfDocumentPreview({ href, zoom }: { href: string; zoom: number }) {
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scale = useMemo(() => zoom / 100, [zoom]);

  useEffect(() => {
    setPageCount(null);
    setError(null);
  }, [href]);

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        minHeight: 0,
        position: 'relative',
        overflow: 'auto',
        borderRadius: 1,
        background: 'linear-gradient(180deg, rgba(8, 12, 18, 0.96) 0%, rgba(14, 19, 27, 0.96) 100%)',
      }}
    >
      {error == null && pageCount == null ? (
        <Box sx={{ position: 'absolute', inset: 0, zIndex: 2, display: 'grid', placeItems: 'center' }}>
          <CircularProgress size={22} />
        </Box>
      ) : null}
      {error != null ? (
        <Box sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="h6" sx={{ mb: 1, color: 'rgba(244, 247, 251, 0.92)' }}>
            Помилка перегляду
          </Typography>
          <Typography variant="body2" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
            {error}
          </Typography>
        </Box>
      ) : null}
      <Document
        file={href}
        loading={null}
        onLoadSuccess={({ numPages }) => setPageCount(numPages)}
        onLoadError={(loadError) => setError(loadError instanceof Error ? loadError.message : 'Не вдалося відкрити PDF')}
        renderMode="canvas"
        options={PDF_DOCUMENT_OPTIONS}
      >
        <Stack spacing={{ xs: 2.5, md: 4 }} sx={{ px: { xs: 2, sm: 2.5, md: 3 }, py: { xs: 2.5, md: 3 }, alignItems: 'center' }}>
          {Array.from({ length: pageCount ?? 0 }, (_, pageIndex) => (
            <Box
              key={`pdf-page-${pageIndex + 1}`}
              sx={{
                width: 'fit-content',
                maxWidth: `${PDF_PAGE_MAX_WIDTH_PX * Math.max(1, scale)}px`,
                display: 'flex',
                justifyContent: 'center',
                mx: 'auto',
                px: { xs: 0, sm: 0.5 },
                '& .react-pdf__Page': {
                  backgroundColor: '#fff',
                  borderRadius: 2,
                  border: '1px solid rgba(148, 163, 184, 0.12)',
                  boxShadow: '0 18px 40px rgba(0, 0, 0, 0.26)',
                  overflow: 'hidden',
                },
                '& .react-pdf__Page__textContent': {
                  inset: '0 !important',
                  lineHeight: 1.4,
                  fontFamily: 'inherit',
                },
                '& .react-pdf__Page__textContent span': {
                  color: 'transparent',
                  WebkitTextFillColor: 'transparent',
                  textShadow: 'none',
                },
                '& .react-pdf__Page__annotations': {
                  inset: '0 !important',
                },
                '& .react-pdf__Page__canvas': {
                  display: 'block',
                },
              }}
            >
              <Page
                pageNumber={pageIndex + 1}
                scale={scale}
                renderTextLayer
                renderAnnotationLayer
                loading={<Box sx={{ minHeight: 240 }} />}
              />
            </Box>
          ))}
        </Stack>
      </Document>
      <Typography variant="caption" sx={{ display: 'none' }}>
        PDF preview
      </Typography>
    </Box>
  );
}
