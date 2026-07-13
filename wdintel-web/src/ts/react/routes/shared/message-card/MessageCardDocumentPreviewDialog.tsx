import { useEffect, useMemo, useState } from 'react';
import { Box, Typography } from '@mui/material';
import type { MouseEvent } from 'react';

import type { MessageCardDocument } from './document-preview.types';
import { getDocumentPreviewCapabilities } from './document-preview-capabilities';
import {
  clamp,
  DOCUMENT_PREVIEW_ZOOM_MAX,
  DOCUMENT_PREVIEW_ZOOM_MIN,
  normalizePreviewIndex,
  shouldIgnoreArrowNavigation,
} from './document-preview-utils';
import { deriveDocumentDownloadName, deriveDocumentFileName } from './message-card-document-utils';
import {
  MessageCardDocumentPreviewActions,
  MessageCardDocumentPreviewControls,
} from './MessageCardDocumentPreviewActions';
import { MessageCardDocumentPreviewInfoPopover } from './MessageCardDocumentPreviewInfoPopover';
import { MessageCardDocumentPreviewStage } from './MessageCardDocumentPreviewStage';
import { MessageCardPreviewShell } from './MessageCardPreviewShell';
import { blurActivePreviewDialogElement } from './message-card-preview-shell';

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
  const documentCount = documents.length;
  const hasCarousel = documentCount > 1;
  const resolvedIndex = normalizePreviewIndex(currentIndex ?? initialIndex, documentCount);
  const currentDocument = documents[resolvedIndex] ?? null;
  const [zoom, setZoom] = useState(100);
  const [infoAnchorEl, setInfoAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const infoOpen = infoAnchorEl !== null;
  const currentDocumentCapabilities =
    currentDocument == null ? null : getDocumentPreviewCapabilities(currentDocument.kind);
  const canZoom = currentDocumentCapabilities?.zoomable === true;
  const canFullscreen = currentDocumentCapabilities?.fullscreen === true;
  const dialogIsFullscreen = canFullscreen && isFullscreen;
  const dialogZoom = canZoom ? zoom : 100;
  const previewFileName = useMemo(
    () =>
      currentDocument != null
        ? deriveDocumentFileName(currentDocument, resolvedIndex)
        : `document-${resolvedIndex + 1}`,
    [currentDocument, resolvedIndex],
  );
  const downloadFileName = useMemo(
    () =>
      currentDocument != null
        ? deriveDocumentDownloadName(currentDocument, resolvedIndex)
        : `document-${resolvedIndex + 1}`,
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
    if (currentDocument == null) return;
    if (!canZoom && zoom !== 100) {
      setZoom(100);
    }
    if (!canFullscreen && isFullscreen) {
      setIsFullscreen(false);
    }
  }, [canFullscreen, canZoom, currentDocument, isFullscreen, zoom]);

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

  const handleDialogClose = (_event: unknown, reason: 'backdropClick' | 'escapeKeyDown') => {
    if (reason === 'escapeKeyDown' && dialogIsFullscreen) {
      setIsFullscreen(false);
      return;
    }
    closeDialog();
  };

  if (currentDocument == null) {
    return (
      <MessageCardPreviewShell
        open={open && documentCount > 0}
        isFullscreen={dialogIsFullscreen}
        ariaLabel="Перегляд документа"
        onClose={handleDialogClose}
        stage={<Typography variant="body2">Документ недоступний</Typography>}
      />
    );
  }

  return (
    <MessageCardPreviewShell
      open={open && documentCount > 0}
      isFullscreen={dialogIsFullscreen}
      ariaLabel="Перегляд документа"
      onClose={handleDialogClose}
      stage={
        <MessageCardDocumentPreviewStage
          documents={documents}
          currentIndex={resolvedIndex}
          zoom={dialogZoom}
          isFullscreen={dialogIsFullscreen}
        />
      }
      controls={
        canZoom ? (
          <MessageCardDocumentPreviewControls
            zoom={zoom}
            isFullscreen={isFullscreen}
            canFullscreen={canFullscreen}
            onSetPreviewZoom={setPreviewZoom}
            onToggleFullscreen={() => setIsFullscreen((value) => !value)}
          />
        ) : null
      }
      actions={
        dialogIsFullscreen ? null : (
          <MessageCardDocumentPreviewActions
            currentHref={currentDocument.href}
            downloadFileName={downloadFileName}
            hasCarousel={hasCarousel}
            resolvedIndex={resolvedIndex}
            documentCount={documentCount}
            onGoToPrevious={() =>
              onIndexChange(normalizePreviewIndex(resolvedIndex - 1, documentCount))
            }
            onGoToNext={() =>
              onIndexChange(normalizePreviewIndex(resolvedIndex + 1, documentCount))
            }
            onInfoClick={handleInfoClick}
            onClose={closeDialog}
          />
        )
      }
      infoPopover={
        <MessageCardDocumentPreviewInfoPopover
          open={infoOpen}
          anchorEl={infoAnchorEl}
          onClose={() => setInfoAnchorEl(null)}
          document={currentDocument}
          fileName={previewFileName}
          fileSize={currentDocument.sizeBytes ?? null}
        />
      }
    />
  );
}
