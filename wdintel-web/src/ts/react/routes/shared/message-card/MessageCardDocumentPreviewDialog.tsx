import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, Typography, useTheme } from '@mui/material';
import type { MouseEvent } from 'react';

import type { MessageCardDocument } from './document-preview.types';
import {
  clamp,
  DOCUMENT_PREVIEW_ZOOM_MAX,
  DOCUMENT_PREVIEW_ZOOM_MIN,
  normalizePreviewIndex,
  shouldIgnoreArrowNavigation,
} from './document-preview-utils';
import { deriveDocumentDownloadName, deriveDocumentFileName } from './message-card-document-utils';
import { MessageCardDocumentPreviewActions } from './MessageCardDocumentPreviewActions';
import { MessageCardDocumentPreviewInfoPopover } from './MessageCardDocumentPreviewInfoPopover';
import { MessageCardDocumentPreviewStage } from './MessageCardDocumentPreviewStage';
import {
  blurActivePreviewDialogElement,
  getMessageCardPreviewCounterSx,
  getMessageCardPreviewDialogPaperSx,
} from './message-card-preview-shell';

export function MessageCardDocumentPreviewDialog({
  documents,
  initialIndex = 0,
  currentIndex,
  open,
  onClose,
  onIndexChange,
}: {
  documents: MessageCardDocument[];
  initialIndex?: number;
  currentIndex?: number;
  open: boolean;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}) {
  const theme = useTheme();
  const documentCount = documents.length;
  const hasCarousel = documentCount > 1;
  const resolvedIndex = normalizePreviewIndex(currentIndex ?? initialIndex, documentCount);
  const currentDocument = documents[resolvedIndex] ?? null;
  const [zoom, setZoom] = useState(100);
  const [infoAnchorEl, setInfoAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const infoOpen = infoAnchorEl !== null;
  const previewFileName = useMemo(
    () => (currentDocument != null ? deriveDocumentFileName(currentDocument, resolvedIndex) : `document-${resolvedIndex + 1}`),
    [currentDocument, resolvedIndex],
  );
  const downloadFileName = useMemo(
    () => (currentDocument != null ? deriveDocumentDownloadName(currentDocument, resolvedIndex) : `document-${resolvedIndex + 1}`),
    [currentDocument, resolvedIndex],
  );

  const resetPreviewState = () => {
    setZoom(100);
    setInfoAnchorEl(null);
    setIsFullscreen(false);
  };

  const closeDialog = () => {
    blurActivePreviewDialogElement();
    resetPreviewState();
    onClose();
  };

  useEffect(() => {
    if (!open) {
      resetPreviewState();
    }
  }, [open]);

  useEffect(() => {
    if (!open || !hasCarousel) return;

    const handleWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (shouldIgnoreArrowNavigation(event.target)) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        onIndexChange(normalizePreviewIndex(resolvedIndex - 1, documentCount));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        onIndexChange(normalizePreviewIndex(resolvedIndex + 1, documentCount));
      }
    };

    window.addEventListener('keydown', handleWindowKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown, true);
    };
  }, [documentCount, hasCarousel, onIndexChange, open, resolvedIndex]);

  const setPreviewZoom = (nextZoom: number) => {
    setZoom(clamp(nextZoom, DOCUMENT_PREVIEW_ZOOM_MIN, DOCUMENT_PREVIEW_ZOOM_MAX));
  };

  const handleInfoClick = (event: MouseEvent<HTMLButtonElement>) => {
    setInfoAnchorEl(event.currentTarget);
  };

  const dialogWidth = isFullscreen ? '100vw' : '92vw';
  const dialogHeight = isFullscreen ? '100vh' : '92svh';

  return (
    <Dialog
      open={open && documentCount > 0}
      onClose={(_, reason) => {
        if (reason === 'escapeKeyDown' && isFullscreen) {
          setIsFullscreen(false);
          return;
        }
        closeDialog();
      }}
      maxWidth={false}
      fullScreen={isFullscreen}
      disableRestoreFocus
      PaperProps={{
        sx: {
          width: dialogWidth,
          height: dialogHeight,
          maxWidth: dialogWidth,
          maxHeight: dialogHeight,
          margin: 0,
          ...getMessageCardPreviewDialogPaperSx(isFullscreen),
        },
      }}
    >
      <DialogContent
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          minHeight: 0,
          p: 1.5,
          overflow: 'hidden',
        }}
      >
        {currentDocument != null ? (
          <>
            <MessageCardDocumentPreviewStage
              documents={documents}
              currentIndex={resolvedIndex}
              zoom={zoom}
              isFullscreen={isFullscreen}
              onGoToPrevious={() => onIndexChange(normalizePreviewIndex(resolvedIndex - 1, documentCount))}
              onGoToNext={() => onIndexChange(normalizePreviewIndex(resolvedIndex + 1, documentCount))}
            />
            <Typography
              variant="body2"
              data-document-preview-counter
              sx={{
                alignSelf: 'center',
                fontWeight: 700,
                letterSpacing: 0,
                px: 1,
                py: 0.25,
                borderRadius: 1,
                ...getMessageCardPreviewCounterSx(theme),
              }}
            >
              {`${resolvedIndex + 1} / ${documentCount}`}
            </Typography>
          </>
        ) : (
          <Typography variant="body2">Документ недоступний</Typography>
        )}
      </DialogContent>
      {currentDocument != null ? (
        <MessageCardDocumentPreviewInfoPopover
          open={infoOpen}
          anchorEl={infoAnchorEl}
          onClose={() => setInfoAnchorEl(null)}
          document={currentDocument}
          fileName={previewFileName}
          fileSize={currentDocument.sizeBytes ?? null}
        />
      ) : null}
      {currentDocument != null ? (
        <MessageCardDocumentPreviewActions
          zoom={zoom}
          currentHref={currentDocument.href}
          downloadFileName={downloadFileName}
          isFullscreen={isFullscreen}
          onSetPreviewZoom={setPreviewZoom}
          onToggleFullscreen={() => setIsFullscreen((value) => !value)}
          onInfoClick={handleInfoClick}
          onClose={closeDialog}
        />
      ) : null}
    </Dialog>
  );
}
