import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
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
import { getNextWheelZoom, isInteractivePreviewTarget } from '../message-card-image-preview-utils';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import {
  getOcrDownloadItems,
  getOcrInfoSections,
  getOcrInfoSeverity,
  OcrPreviewAction,
  OcrSplitPreview,
} from '../attachment-preview/OcrPreview';
import { MessageCardAttachmentPreviewInfoPopover } from '../attachment-preview/MessageCardAttachmentPreviewInfoPopover';
import { MessageCardAttachmentPreviewStage } from '../attachment-preview/MessageCardAttachmentPreviewStage';
import { AttachmentPreviewZoomBadge } from '../attachment-preview/AttachmentPreviewZoomBadge';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import { blurActiveAttachmentPreviewElement } from '../attachment-preview/message-card-attachment-preview';
import type { MessageCardDownloadGuardProps } from '../MessageCardMedia';
import type { MessageCardPreviewNavigation } from '../attachment-preview/message-card-preview.types';
import { MediaReprocessAction } from '../attachment-preview/MediaReprocessAction';
import { MediaSummaryAction } from '../attachment-preview/MediaSummaryPreview';
import {
  ReportTextPreviewAction,
  type AttachmentPreviewReportDraft,
  type AttachmentPreviewReportVisibility,
} from '../attachment-preview/ReportTextPreview';
import { MarkdownDocumentPreview, TxtDocumentPreview } from '../text-document-preview';
import { CsvDocumentPreview } from './CsvDocumentPreview';
import { DocxDocumentPreview } from './DocxDocumentPreview';
import { PdfDocumentPreview } from './PdfDocumentPreview';
import { UnsupportedDocumentPreview } from './UnsupportedDocumentPreview';
import { XlsxDocumentPreview } from './XlsxDocumentPreview';

function DocumentPreview({ document, zoom }: { document: MessageCardDocument; zoom: number }) {
  return (
    <Box data-document-preview-content sx={{ flex: '1 1 auto', minHeight: 0, width: '100%' }}>
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
  isDownloadStarting,
  onDownloadStart,
  reportDraft,
  reportVisible,
  onReportVisibleChange,
}: {
  document: MessageCardDocument;
  onClose: () => void;
  navigation: MessageCardPreviewNavigation;
  reportDraft?: AttachmentPreviewReportDraft;
} & MessageCardDownloadGuardProps &
  AttachmentPreviewReportVisibility) {
  const resolvedIndex = navigation.index;
  const currentDocument = document;
  const [zoom, setZoom] = useState(100);
  const [infoAnchorEl, setInfoAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [ocrVisible, setOcrVisible] = useState(false);
  const [ocrFullPane, setOcrFullPane] = useState(false);
  const [ocrStatus, setOcrStatus] = useState(currentDocument.ocr ?? null);
  const [summaryVisible, setSummaryVisible] = useState(false);
  const [summaryStatus, setSummaryStatus] = useState(currentDocument.summary ?? null);

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const infoOpen = infoAnchorEl !== null;
  const currentDocumentKind = currentDocument.kind;
  const currentDocumentCapabilities = getDocumentPreviewCapabilities(currentDocument.kind);
  const canZoom = currentDocumentCapabilities?.zoomable === true;
  const canSwipeCarousel = currentDocumentCapabilities?.carouselSwipeable === true;
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
    setOcrVisible(false);
    setOcrFullPane(false);
    setSummaryVisible(false);
    setSummaryStatus(currentDocument.summary ?? null);
  };

  const closeDialog = () => {
    blurActiveAttachmentPreviewElement();
    resetPreviewState();
    onClose();
  };

  useEffect(() => {
    setZoom(100);
    setInfoAnchorEl(null);
    setOcrVisible(false);
    setOcrFullPane(false);
    setOcrStatus(currentDocument.ocr ?? null);
    setSummaryVisible(false);
    setSummaryStatus(currentDocument.summary ?? null);
  }, [currentDocument.href, currentDocument.ocr, currentDocument.summary, resolvedIndex]);

  useEffect(() => {
    if (!canZoom && zoom !== 100) {
      setZoom(100);
    }
  }, [canZoom, zoom]);

  const setPreviewZoom = (nextZoom: number) => {
    setZoom(clamp(nextZoom, DOCUMENT_PREVIEW_ZOOM_MIN, DOCUMENT_PREVIEW_ZOOM_MAX));
  };

  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);

  const handleInfoClick = (event: MouseEvent<HTMLButtonElement>) => {
    setInfoAnchorEl(event.currentTarget);
  };

  const handleStageDoubleClick = () => {
    if (!canZoom) return;
    setZoom((currentZoom) => (currentZoom > 100 ? 100 : 150));
  };

  const handleReprocessQueued = useCallback((nextOcr: NonNullable<MessageCardDocument['ocr']>) => {
    setOcrStatus(nextOcr);
    setOcrVisible(true);
    setOcrFullPane(false);
    setSummaryStatus(null);
    setSummaryVisible(false);
  }, []);

  useEffect(() => {
    if (stageEl === null || !canZoom) return;

    let touchStartDist = 0;
    let touchStartZoom = 100;

    const handleStageWheelNative = (event: WheelEvent) => {
      if (isInteractivePreviewTarget(event.target)) return;

      // Ctrl / Cmd + scroll OR trackpad pinch (ctrlKey) -> Zoom in/out content area
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setZoom((currentZoom) =>
          getNextWheelZoom(currentZoom, event.deltaY, event.deltaMode, stageEl.clientHeight),
        );
      }
      // Regular scroll -> Just scroll content naturally
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        const t1 = event.touches[0];
        const t2 = event.touches[1];
        if (!t1 || !t2) return;
        touchStartDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        setZoom((currentZoom) => {
          touchStartZoom = currentZoom;
          return currentZoom;
        });
      }
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length === 2 && touchStartDist > 0) {
        event.preventDefault();
        const t1 = event.touches[0];
        const t2 = event.touches[1];
        if (!t1 || !t2) return;
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const scale = dist / touchStartDist;
        const nextZoom = clamp(
          touchStartZoom * scale,
          DOCUMENT_PREVIEW_ZOOM_MIN,
          DOCUMENT_PREVIEW_ZOOM_MAX,
        );
        setZoom(nextZoom);
      }
    };

    const handleTouchEnd = () => {
      touchStartDist = 0;
    };

    let gestureStartZoom = 100;

    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      setZoom((currentZoom) => {
        gestureStartZoom = currentZoom;
        return currentZoom;
      });
    };

    const handleGestureChange = (event: Event) => {
      event.preventDefault();
      const gestureEvent = event as unknown as { scale: number };
      if (typeof gestureEvent.scale === 'number') {
        const nextZoom = clamp(
          gestureStartZoom * gestureEvent.scale,
          DOCUMENT_PREVIEW_ZOOM_MIN,
          DOCUMENT_PREVIEW_ZOOM_MAX,
        );
        setZoom(nextZoom);
      }
    };

    const handleGestureEnd = (event: Event) => {
      event.preventDefault();
    };

    stageEl.addEventListener('wheel', handleStageWheelNative, { passive: false });
    stageEl.addEventListener('gesturestart', handleGestureStart, { passive: false });
    stageEl.addEventListener('gesturechange', handleGestureChange, { passive: false });
    stageEl.addEventListener('gestureend', handleGestureEnd, { passive: false });
    stageEl.addEventListener('touchstart', handleTouchStart, { passive: true });
    stageEl.addEventListener('touchmove', handleTouchMove, { passive: false });
    stageEl.addEventListener('touchend', handleTouchEnd, { passive: true });
    stageEl.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      stageEl.removeEventListener('wheel', handleStageWheelNative);
      stageEl.removeEventListener('gesturestart', handleGestureStart);
      stageEl.removeEventListener('gesturechange', handleGestureChange);
      stageEl.removeEventListener('gestureend', handleGestureEnd);
      stageEl.removeEventListener('touchstart', handleTouchStart);
      stageEl.removeEventListener('touchmove', handleTouchMove);
      stageEl.removeEventListener('touchend', handleTouchEnd);
      stageEl.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [canZoom, stageEl]);

  const sourceStage = (
    <MessageCardAttachmentPreviewStage
      ref={setStageEl}
      kind="document"
      onDoubleClick={handleStageDoubleClick}
      onPrimaryClick={(_, region) => {
        if (region === 'background') onClose();
      }}
    >
      <DocumentPreview document={currentDocument} zoom={dialogZoom} />
      {canZoom ? (
        <AttachmentPreviewZoomBadge zoom={dialogZoom} onResetZoom={() => setZoom(100)} />
      ) : null}
    </MessageCardAttachmentPreviewStage>
  );
  const stage = (
    <OcrSplitPreview
      source={sourceStage}
      mediaId={currentDocument.id}
      ocr={ocrStatus}
      visible={ocrVisible}
      fullPane={ocrFullPane}
      onOcrChange={setOcrStatus}
      onFullPaneChange={setOcrFullPane}
      summary={summaryStatus}
      summaryVisible={summaryVisible}
      onSummaryChange={setSummaryStatus}
      onSummaryVisibleChange={setSummaryVisible}
      reportDraft={reportDraft}
      reportVisible={reportVisible}
      onReportVisibleChange={onReportVisibleChange}
    />
  );

  const header = (
    <MessageCardAttachmentPreviewHeader
      fileName={previewFileName}
      openHref={currentDocument.href}
      download={{ href: currentDocument.href, fileName: downloadFileName }}
      navigation={navigation}
      onInfoClick={handleInfoClick}
      infoSeverity={getOcrInfoSeverity(ocrStatus)}
      additionalActions={
        <>
          <MediaSummaryAction
            status={summaryStatus}
            active={summaryVisible}
            onClick={() =>
              setSummaryVisible((visible) => {
                const next = !visible;
                if (next && isMobile) setOcrVisible(false);
                if (next) onReportVisibleChange(false);
                return next;
              })
            }
          />
          {reportDraft != null ? (
            <ReportTextPreviewAction
              active={reportVisible}
              onClick={() => {
                const next = !reportVisible;
                if (next) {
                  setOcrVisible(false);
                  setOcrFullPane(false);
                  setSummaryVisible(false);
                }
                onReportVisibleChange(next);
              }}
            />
          ) : null}
          <OcrPreviewAction
            ocr={ocrStatus}
            active={ocrVisible}
            onClick={() =>
              setOcrVisible((visible) => {
                const next = !visible;
                if (next && isMobile) setSummaryVisible(false);
                if (next) onReportVisibleChange(false);
                return next;
              })
            }
          />
        </>
      }
      overflowAction={
        <MediaReprocessAction
          mediaId={currentDocument.id}
          supported={currentDocument.kind === 'pdf'}
          ocr={ocrStatus}
          onQueued={handleReprocessQueued}
          downloadItems={getOcrDownloadItems(currentDocument.id, ocrStatus, previewFileName)}
          isDownloadStarting={isDownloadStarting}
          onDownloadStart={onDownloadStart}
        />
      }
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
      sections={getOcrInfoSections(ocrStatus)}
    />
  );

  return (
    <MessageCardAttachmentPreviewLayout
      stage={stage}
      header={header}
      infoPopover={infoPopover}
      navigation={navigation}
      swipeEnabled={canSwipeCarousel && dialogZoom <= 100}
    />
  );
}
