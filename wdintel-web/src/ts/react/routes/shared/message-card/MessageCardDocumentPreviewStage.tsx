import { forwardRef } from 'react';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Box, IconButton, Tooltip } from '@mui/material';

import type { MessageCardDocument } from './document-preview.types';
import { DocxDocumentPreview } from './renderers/DocxDocumentPreview';
import { PdfDocumentPreview } from './renderers/PdfDocumentPreview';
import { UnsupportedDocumentPreview } from './renderers/UnsupportedDocumentPreview';
import { XlsxDocumentPreview } from './renderers/XlsxDocumentPreview';

export const MessageCardDocumentPreviewStage = forwardRef<
  HTMLDivElement,
  {
    documents: MessageCardDocument[];
    currentIndex: number;
    zoom: number;
    isFullscreen: boolean;
    onGoToPrevious: () => void;
    onGoToNext: () => void;
  }
>(function MessageCardDocumentPreviewStage(
  { documents, currentIndex, zoom, isFullscreen, onGoToPrevious, onGoToNext },
  ref,
) {
  const currentDocument = documents[currentIndex] ?? null;
  const hasCarousel = documents.length > 1;

  return (
    <Box
      data-document-preview-stage
      ref={ref}
      sx={{
        flex: '1 1 auto',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
        borderRadius: isFullscreen ? 0 : 1.5,
        backgroundColor: '#111821',
        boxShadow: isFullscreen ? 'none' : 'inset 0 0 0 1px rgba(255, 255, 255, 0.04)',
        color: '#f4f7fb',
      }}
    >
      {hasCarousel ? (
        <>
          <Box
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            sx={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: 0,
              width: '4rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'linear-gradient(90deg, rgba(0,0,0,0.14), transparent)',
              pointerEvents: 'auto',
              zIndex: 10,
            }}
          >
            <Tooltip title="Попереднє" enterDelay={300}>
              <IconButton
                onClick={(event) => {
                  event.stopPropagation();
                  onGoToPrevious();
                }}
                aria-label="Попереднє"
                sx={{
                  pointerEvents: 'auto',
                  color: '#fff',
                  backgroundColor: 'rgba(0, 0, 0, 0.42)',
                  border: '1px solid rgba(255, 255, 255, 0.18)',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
                  '&:hover, &:focus-visible': {
                    backgroundColor: 'rgba(0, 0, 0, 0.62)',
                  },
                }}
              >
                <ChevronLeftIcon />
              </IconButton>
            </Tooltip>
          </Box>
          <Box
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            sx={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              width: '4rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'linear-gradient(270deg, rgba(0,0,0,0.14), transparent)',
              pointerEvents: 'auto',
              zIndex: 10,
            }}
          >
            <Tooltip title="Наступне" enterDelay={300}>
              <IconButton
                onClick={(event) => {
                  event.stopPropagation();
                  onGoToNext();
                }}
                aria-label="Наступне"
                sx={{
                  pointerEvents: 'auto',
                  color: '#fff',
                  backgroundColor: 'rgba(0, 0, 0, 0.42)',
                  border: '1px solid rgba(255, 255, 255, 0.18)',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
                  '&:hover, &:focus-visible': {
                    backgroundColor: 'rgba(0, 0, 0, 0.62)',
                  },
                }}
              >
                <ChevronRightIcon />
              </IconButton>
            </Tooltip>
          </Box>
        </>
      ) : null}

      <Box
        sx={{
          flex: '1 1 auto',
          minHeight: 0,
          overflow: 'auto',
          p: 1.5,
          width: '100%',
        }}
      >
        {currentDocument == null ? null : currentDocument.kind === 'pdf' ? (
          <PdfDocumentPreview href={currentDocument.href} zoom={zoom} />
        ) : currentDocument.kind === 'docx' ? (
          <DocxDocumentPreview href={currentDocument.href} zoom={zoom} />
        ) : currentDocument.kind === 'xlsx' ? (
          <XlsxDocumentPreview href={currentDocument.href} zoom={zoom} />
        ) : (
          <UnsupportedDocumentPreview fileName={currentDocument.fileName ?? currentDocument.href} />
        )}
      </Box>
    </Box>
  );
});
