import { forwardRef } from 'react';
import { Box } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import type { MessageCardDocument } from './document-preview.types';
import { DocxDocumentPreview } from './renderers/DocxDocumentPreview';
import { PdfDocumentPreview } from './renderers/PdfDocumentPreview';
import { UnsupportedDocumentPreview } from './renderers/UnsupportedDocumentPreview';
import { XlsxDocumentPreview } from './renderers/XlsxDocumentPreview';
import { getMessageCardPreviewStageSx } from './message-card-preview-shell';

export const MessageCardDocumentPreviewStage = forwardRef<
  HTMLDivElement,
  {
    documents: MessageCardDocument[];
    currentIndex: number;
    zoom: number;
    isFullscreen: boolean;
  }
>(function MessageCardDocumentPreviewStage({ documents, currentIndex, zoom, isFullscreen }, ref) {
  const theme = useTheme();
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
        ...getMessageCardPreviewStageSx(theme, isFullscreen),
        color: theme.palette.text.primary,
      }}
    >
      <Box
        sx={{
          flex: '1 1 auto',
          minHeight: 0,
          width: '100%',
        }}
      >
        {currentDocument == null ? null : currentDocument.kind === 'pdf' ? (
          <PdfDocumentPreview
            href={currentDocument.href}
            zoom={zoom}
            sizeBytes={currentDocument.sizeBytes ?? null}
          />
        ) : currentDocument.kind === 'docx' ? (
          <DocxDocumentPreview
            href={currentDocument.href}
            zoom={zoom}
            sizeBytes={currentDocument.sizeBytes ?? null}
          />
        ) : currentDocument.kind === 'xlsx' ? (
          <XlsxDocumentPreview
            href={currentDocument.href}
            zoom={zoom}
            sizeBytes={currentDocument.sizeBytes ?? null}
          />
        ) : (
          <UnsupportedDocumentPreview fileName={currentDocument.fileName ?? currentDocument.href} />
        )}
      </Box>
    </Box>
  );
});
