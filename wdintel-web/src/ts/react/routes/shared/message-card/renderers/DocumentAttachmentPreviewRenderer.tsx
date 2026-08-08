import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box } from '@mui/material';
import type { MouseEvent } from 'react';

import type { MessageCardDocument } from '../document-preview.types';
import { getDocumentPreviewCapabilities } from '../document-preview-capabilities';
import {
  clamp,
  DOCUMENT_PREVIEW_ZOOM_MAX,
  DOCUMENT_PREVIEW_ZOOM_MARKS,
  DOCUMENT_PREVIEW_ZOOM_MIN,
  DOCUMENT_PREVIEW_ZOOM_STEP,
} from '../document-preview-utils';
import { deriveDocumentDownloadName, deriveDocumentFileName } from '../message-card-document-utils';
import { formatSizeBytes } from '../message-card-image-utils';
import { MessageCardAttachmentPreviewActions } from '../attachment-preview/MessageCardAttachmentPreviewActions';
import { AttachmentPreviewZoomControls } from '../attachment-preview/MessageCardAttachmentPreviewControls';
import { MessageCardAttachmentPreviewInfoPopover } from '../attachment-preview/MessageCardAttachmentPreviewInfoPopover';
import { MessageCardAttachmentPreviewStage } from '../attachment-preview/MessageCardAttachmentPreviewStage';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import { getMessageCardAttachmentPreviewConfig } from '../attachment-preview/message-card-preview-config';
import { blurActiveAttachmentPreviewElement } from '../attachment-preview/message-card-attachment-preview';
import type { MessageCardDownloadGuardProps } from '../MessageCardMedia';
import type { MessageCardPreviewNavigation } from '../attachment-preview/message-card-preview.types';
import { MarkdownDocumentPreview, TxtDocumentPreview } from '../text-document-preview';
import { CsvDocumentPreview } from './CsvDocumentPreview';
import { DocxDocumentPreview } from './DocxDocumentPreview';
import { PdfDocumentPreview } from './PdfDocumentPreview';
import { UnsupportedDocumentPreview } from './UnsupportedDocumentPreview';
import { XlsxDocumentPreview } from './XlsxDocumentPreview';

function DocumentPreview({ document, zoom }: { document: MessageCardDocument; zoom: number }) {
  return (
    <Box sx={{ flex: '1 1 auto', minHeight: 0, width: '100%' }}>
      {document.kind === 'pdf' ? (
        <PdfDocumentPreview
          href={document.href}
          zoom={zoom}
          sizeBytes={document.sizeBytes ?? null}
        />
      ) : document.kind === 'docx' ? (
        <DocxDocumentPreview
          href={document.href}
          zoom={zoom}
          sizeBytes={document.sizeBytes ?? null}
        />
      ) : document.kind === 'xlsx' ? (
        <XlsxDocumentPreview
          href={document.href}
          zoom={zoom}
          sizeBytes={document.sizeBytes ?? null}
        />
      ) : document.kind === 'csv' ? (
        <CsvDocumentPreview
          href={document.href}
          zoom={zoom}
          sizeBytes={document.sizeBytes ?? null}
          contentType={document.contentType ?? null}
        />
      ) : document.kind === 'txt' ? (
        <TxtDocumentPreview href={document.href} sizeBytes={document.sizeBytes ?? null} />
      ) : document.kind === 'md' ? (
        <MarkdownDocumentPreview href={document.href} sizeBytes={document.sizeBytes ?? null} />
      ) : (
        <UnsupportedDocumentPreview fileName={document.fileName ?? document.href} />
      )}
    </Box>
  );
}

export function DocumentAttachmentPreviewRenderer({
  document,
  onClose,
  navigation,
  isFullscreen,
  onFullscreenChange,
  isDownloadStarting,
  onDownloadStart,
}: {
  document: MessageCardDocument;
  onClose: () => void;
  navigation: MessageCardPreviewNavigation;
  isFullscreen: boolean;
  onFullscreenChange: (isFullscreen: boolean) => void;
} & MessageCardDownloadGuardProps) {
  const resolvedIndex = navigation.index;
  const currentDocument = document;
  const [zoom, setZoom] = useState(100);
  const [infoAnchorEl, setInfoAnchorEl] = useState<HTMLButtonElement | null>(null);

  const infoOpen = infoAnchorEl !== null;
  const currentDocumentKind = currentDocument.kind;
  const previewConfig = getMessageCardAttachmentPreviewConfig(currentDocumentKind);
  const currentDocumentCapabilities = getDocumentPreviewCapabilities(currentDocument.kind);
  const canZoom = currentDocumentCapabilities?.zoomable === true;
  const canFullscreen = previewConfig.supportsFullscreen;
  const dialogIsFullscreen = canFullscreen && isFullscreen;
  const changeFullscreen = useCallback(
    (value: boolean) => onFullscreenChange(value),
    [onFullscreenChange],
  );
  const dialogZoom = canZoom ? zoom : 100;
  const previewFileName = useMemo(
    () => deriveDocumentFileName(currentDocument, resolvedIndex),
    [currentDocument, resolvedIndex],
  );
  const downloadFileName = useMemo(
    () => deriveDocumentDownloadName(currentDocument, resolvedIndex),
    [currentDocument, resolvedIndex],
  );

  const resetPreviewState = () => {
    setZoom(100);
    setInfoAnchorEl(null);
    changeFullscreen(false);
  };

  const closeDialog = () => {
    blurActiveAttachmentPreviewElement();
    resetPreviewState();
    onClose();
  };

  useEffect(() => {
    if (!canZoom && zoom !== 100) {
      setZoom(100);
    }
    if (!canFullscreen && isFullscreen) {
      changeFullscreen(false);
    }
  }, [canFullscreen, canZoom, changeFullscreen, currentDocument, isFullscreen, zoom]);

  const setPreviewZoom = (nextZoom: number) => {
    setZoom(clamp(nextZoom, DOCUMENT_PREVIEW_ZOOM_MIN, DOCUMENT_PREVIEW_ZOOM_MAX));
  };

  const handleInfoClick = (event: MouseEvent<HTMLButtonElement>) => {
    setInfoAnchorEl(event.currentTarget);
  };

  const stage = (
    <MessageCardAttachmentPreviewStage kind="document" isFullscreen={dialogIsFullscreen}>
      <DocumentPreview document={currentDocument} zoom={dialogZoom} />
    </MessageCardAttachmentPreviewStage>
  );
  const controls = canZoom ? (
    <AttachmentPreviewZoomControls
      zoom={zoom}
      min={DOCUMENT_PREVIEW_ZOOM_MIN}
      max={DOCUMENT_PREVIEW_ZOOM_MAX}
      buttonStep={DOCUMENT_PREVIEW_ZOOM_STEP}
      marks={DOCUMENT_PREVIEW_ZOOM_MARKS.map((mark) => mark.value)}
      isFullscreen={dialogIsFullscreen}
      canFullscreen={canFullscreen}
      onZoomChange={setPreviewZoom}
      onToggleFullscreen={() => changeFullscreen(!dialogIsFullscreen)}
    />
  ) : null;
  const actions = dialogIsFullscreen ? null : (
    <MessageCardAttachmentPreviewActions
      openHref={currentDocument.href}
      download={{ href: currentDocument.href, fileName: downloadFileName }}
      navigation={navigation}
      onInfoClick={handleInfoClick}
      onClose={closeDialog}
      downloadKey={`media:${String(currentDocument?.id ?? '')}`}
      isDownloadStarting={isDownloadStarting}
      onDownloadStart={onDownloadStart}
    />
  );
  const infoPopover = (
    <MessageCardAttachmentPreviewInfoPopover
      open={infoOpen}
      anchorEl={infoAnchorEl}
      onClose={() => setInfoAnchorEl(null)}
      fields={[
        { label: 'URL', value: currentDocument.href || '—' },
        { label: 'Файл', value: previewFileName },
        { label: 'Тип', value: currentDocument.contentType?.trim() || '—' },
        {
          label: 'Розмір файлу',
          value: formatSizeBytes(currentDocument.sizeBytes ?? null),
        },
        { label: 'Тип перегляду', value: currentDocument.kind },
      ]}
    />
  );

  return (
    <MessageCardAttachmentPreviewLayout
      isFullscreen={dialogIsFullscreen}
      config={previewConfig}
      stage={stage}
      controls={controls}
      actions={actions}
      infoPopover={infoPopover}
      onToggleFullscreen={() => changeFullscreen(!dialogIsFullscreen)}
    />
  );
}
