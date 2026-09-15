import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, CircularProgress, Stack, Typography, useMediaQuery, useTheme } from '@mui/material';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const PDF_PAGE_MAX_WIDTH_PX = 920;
const PDF_PAGE_RENDER_LIMIT = 24;
const PDF_DOCUMENT_OPTIONS = { useWorkerFetch: true };
const MAX_PDF_FILE_MB = 10;
const MAX_PDF_FILE_BYTES = MAX_PDF_FILE_MB * 1024 * 1024;

import { fetchCachedDocumentResponse } from '../document-preview-utils';

function formatPdfPreviewErrorMessage(error: string | null): string {
  if (error === 'PDF_FILE_TOO_LARGE') {
    return `Файл PDF завеликий для попереднього перегляду. Максимум: ${MAX_PDF_FILE_MB} МБ.`;
  }

  return error ?? 'PDF недоступний';
}

export function PdfDocumentPreview({
  href,
  zoom,
  sizeBytes,
  onError,
}: {
  href: string;
  zoom: number;
  sizeBytes?: number | null;
  onError?: (error: unknown) => void;
}) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [pageAspectRatio, setPageAspectRatio] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scale = useMemo(() => zoom / 100, [zoom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const updateWidth = () => {
      setContainerWidth(container.clientWidth);
    };

    updateWidth();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateWidth);
      observer.observe(container);
      return () => observer.disconnect();
    }
  }, []);

  useEffect(() => {
    setPageCount(null);
    setPageAspectRatio(null);
    setError(null);
    setPdfBlobUrl(null);

    const abortController = new AbortController();
    let disposed = false;
    let objectUrl: string | null = null;

    const load = async () => {
      try {
        if (sizeBytes != null && sizeBytes > MAX_PDF_FILE_BYTES) {
          throw new Error('PDF_FILE_TOO_LARGE');
        }

        const { buffer, contentType, contentLength } = await fetchCachedDocumentResponse(
          href,
          MAX_PDF_FILE_BYTES,
          'PDF_FILE_TOO_LARGE',
          abortController.signal,
        );

        if (contentLength != null && contentLength > MAX_PDF_FILE_BYTES) {
          throw new Error('PDF_FILE_TOO_LARGE');
        }

        if (buffer.byteLength > MAX_PDF_FILE_BYTES) {
          throw new Error('PDF_FILE_TOO_LARGE');
        }

        objectUrl = URL.createObjectURL(
          new Blob([buffer], {
            type: contentType ?? 'application/pdf',
          }),
        );
        if (disposed) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        setPdfBlobUrl(objectUrl);
      } catch (loadError) {
        if (disposed || abortController.signal.aborted) return;
        onError?.(loadError);
        setError(
          formatPdfPreviewErrorMessage(loadError instanceof Error ? loadError.message : null),
        );
      }
    };

    void load();

    return () => {
      disposed = true;
      abortController.abort();
      if (objectUrl != null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [href, sizeBytes, onError]);

  const renderedPageCount = Math.min(pageCount ?? 0, PDF_PAGE_RENDER_LIMIT);
  const isPreviewLimited = pageCount != null && pageCount > PDF_PAGE_RENDER_LIMIT;
  const availableWidth =
    containerWidth != null && containerWidth > 0
      ? Math.max(280, containerWidth - (isMobile ? 16 : 32))
      : PDF_PAGE_MAX_WIDTH_PX;
  const pageWidth = Math.round(Math.min(PDF_PAGE_MAX_WIDTH_PX, availableWidth) * scale);
  const isOverflowing = containerWidth != null && pageWidth > containerWidth;

  return (
    <Box
      ref={scrollContainerRef}
      sx={{
        width: '100%',
        height: '100%',
        minHeight: 0,
        position: 'relative',
        overflow: 'auto',
        borderRadius: 1,
        backgroundColor: 'transparent',
      }}
    >
      {error == null && pageCount == null ? (
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
      {error != null ? (
        <Box sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Помилка перегляду
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {formatPdfPreviewErrorMessage(error)}
          </Typography>
        </Box>
      ) : null}
      {pdfBlobUrl != null ? (
        <Document
          file={pdfBlobUrl}
          loading={null}
          onLoadSuccess={(pdf) => {
            setPageCount(pdf.numPages);
            pdf
              .getPage(1)
              .then((page) => {
                const viewport = page.getViewport({ scale: 1 });
                if (viewport.width > 0 && viewport.height > 0) {
                  setPageAspectRatio(viewport.height / viewport.width);
                }
              })
              .catch(() => {});
          }}
          onLoadError={(loadError) => {
            onError?.(loadError);
            setError(loadError instanceof Error ? loadError.message : 'Не вдалося відкрити PDF');
          }}
          renderMode="canvas"
          options={PDF_DOCUMENT_OPTIONS}
        >
          <Stack
            spacing={{ xs: 2.5, md: 4 }}
            sx={{
              px: { xs: 1, sm: 2.5, md: 3 },
              py: { xs: 2.5, md: 3 },
              alignItems: isOverflowing ? 'flex-start' : 'center',
              minWidth: '100%',
              width: 'max-content',
              mx: 'auto',
            }}
          >
            {Array.from({ length: renderedPageCount }, (_, pageIndex) => (
              <LazyPdfPage
                key={`pdf-page-${pageIndex + 1}`}
                pageNumber={pageIndex + 1}
                pageWidth={pageWidth}
                pageAspectRatio={pageAspectRatio}
                scrollContainerRef={scrollContainerRef}
              />
            ))}
            {isPreviewLimited ? (
              <Typography variant="caption" color="text.secondary">
                Показано перші {PDF_PAGE_RENDER_LIMIT} сторінок
              </Typography>
            ) : null}
          </Stack>
        </Document>
      ) : null}
      <Typography variant="caption" sx={{ display: 'none' }}>
        PDF preview
      </Typography>
    </Box>
  );
}

function LazyPdfPage({
  pageNumber,
  pageWidth,
  pageAspectRatio,
  scrollContainerRef,
}: {
  pageNumber: number;
  pageWidth: number;
  pageAspectRatio: number | null;
  scrollContainerRef: React.RefObject<HTMLDivElement>;
}) {
  const pageShellRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(pageNumber <= 3);

  useEffect(() => {
    if (isVisible) return;
    const pageShell = pageShellRef.current;
    if (pageShell == null) return;

    if (typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      {
        root: scrollContainerRef.current,
        rootMargin: '600px 0px',
        threshold: 0.01,
      },
    );

    observer.observe(pageShell);
    return () => observer.disconnect();
  }, [isVisible, scrollContainerRef]);

  const estimatedHeight = Math.round(pageWidth * (pageAspectRatio ?? 1.414));

  return (
    <Box
      ref={pageShellRef}
      data-pdf-page-shell
      data-pdf-page-number={pageNumber}
      sx={{
        width: 'fit-content',
        maxWidth: '100%',
        minHeight: `${estimatedHeight}px`,
        display: 'flex',
        justifyContent: 'center',
        mx: 'auto',
        px: { xs: 0, sm: 0.5 },
        '& .react-pdf__Page': {
          backgroundColor: 'background.paper',
          borderRadius: 2,
          border: 1,
          borderColor: 'divider',
          boxShadow: 4,
          overflow: 'hidden',
          maxWidth: '100%',
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
          maxWidth: '100%',
          height: 'auto !important',
        },
      }}
    >
      {isVisible ? (
        <Page
          pageNumber={pageNumber}
          width={pageWidth}
          renderTextLayer
          renderAnnotationLayer
          loading={
            <Box
              sx={{
                width: pageWidth,
                height: estimatedHeight,
                minHeight: estimatedHeight,
              }}
            />
          }
        />
      ) : null}
    </Box>
  );
}
