import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  CircularProgress,
  Stack,
  Typography,
  useTheme,
} from "@mui/material";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const PDF_PAGE_MAX_WIDTH_PX = 920;
const PDF_PAGE_RENDER_LIMIT = 24;
const PDF_DOCUMENT_OPTIONS = { useWorkerFetch: true };

export function PdfDocumentPreview({
  href,
  zoom,
}: {
  href: string;
  zoom: number;
}) {
  const theme = useTheme();
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scale = useMemo(() => zoom / 100, [zoom]);

  useEffect(() => {
    setPageCount(null);
    setError(null);
  }, [href]);

  const renderedPageCount = Math.min(pageCount ?? 0, PDF_PAGE_RENDER_LIMIT);
  const isPreviewLimited =
    pageCount != null && pageCount > PDF_PAGE_RENDER_LIMIT;

  return (
    <Box
      sx={{
        width: "100%",
        height: "100%",
        minHeight: 0,
        position: "relative",
        overflow: "auto",
        borderRadius: 1,
        backgroundColor: "transparent",
      }}
    >
      {error == null && pageCount == null ? (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            zIndex: 2,
            display: "grid",
            placeItems: "center",
          }}
        >
          <CircularProgress size={22} />
        </Box>
      ) : null}
      {error != null ? (
        <Box sx={{ p: 3, textAlign: "center" }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Помилка перегляду
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {error}
          </Typography>
        </Box>
      ) : null}
      <Document
        file={href}
        loading={null}
        onLoadSuccess={({ numPages }) => setPageCount(numPages)}
        onLoadError={(loadError) =>
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Не вдалося відкрити PDF",
          )
        }
        renderMode="canvas"
        options={PDF_DOCUMENT_OPTIONS}
      >
        <Stack
          spacing={{ xs: 2.5, md: 4 }}
          sx={{
            px: { xs: 2, sm: 2.5, md: 3 },
            py: { xs: 2.5, md: 3 },
            alignItems: "center",
          }}
        >
          {Array.from({ length: renderedPageCount }, (_, pageIndex) => (
            <LazyPdfPage
              key={`pdf-page-${pageIndex + 1}`}
              pageNumber={pageIndex + 1}
              scale={scale}
            />
          ))}
          {isPreviewLimited ? (
            <Typography variant="caption" color="text.secondary">
              Показано перші {PDF_PAGE_RENDER_LIMIT} сторінок
            </Typography>
          ) : null}
        </Stack>
      </Document>
      <Typography variant="caption" sx={{ display: "none" }}>
        PDF preview
      </Typography>
    </Box>
  );
}

function LazyPdfPage({
  pageNumber,
  scale,
}: {
  pageNumber: number;
  scale: number;
}) {
  const pageShellRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const pageShell = pageShellRef.current;
    if (pageShell == null) return;

    if (typeof IntersectionObserver === "undefined") {
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
        root: null,
        rootMargin: "40% 0px",
        threshold: 0.01,
      },
    );

    observer.observe(pageShell);
    return () => observer.disconnect();
  }, []);

  return (
    <Box
      ref={pageShellRef}
      data-pdf-page-shell
      data-pdf-page-number={pageNumber}
      sx={{
        width: "fit-content",
        maxWidth: `${PDF_PAGE_MAX_WIDTH_PX * Math.max(1, scale)}px`,
        minHeight: 240,
        display: "flex",
        justifyContent: "center",
        mx: "auto",
        px: { xs: 0, sm: 0.5 },
        "& .react-pdf__Page": {
          backgroundColor: "#fff",
          borderRadius: 2,
          border: "1px solid rgba(148, 163, 184, 0.12)",
          boxShadow: "0 18px 40px rgba(0, 0, 0, 0.26)",
          overflow: "hidden",
        },
        "& .react-pdf__Page__textContent": {
          inset: "0 !important",
          lineHeight: 1.4,
          fontFamily: "inherit",
        },
        "& .react-pdf__Page__textContent span": {
          color: "transparent",
          WebkitTextFillColor: "transparent",
          textShadow: "none",
        },
        "& .react-pdf__Page__annotations": {
          inset: "0 !important",
        },
        "& .react-pdf__Page__canvas": {
          display: "block",
        },
      }}
    >
      {isVisible ? (
        <Page
          pageNumber={pageNumber}
          scale={scale}
          renderTextLayer
          renderAnnotationLayer
          loading={<Box sx={{ minHeight: 240 }} />}
        />
      ) : null}
    </Box>
  );
}
