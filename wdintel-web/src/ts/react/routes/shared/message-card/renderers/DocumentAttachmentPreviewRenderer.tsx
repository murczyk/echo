import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { MouseEvent } from 'react';

import type { MessageCardDocument } from '../document-preview.types';
import { getDocumentPreviewCapabilities } from '../document-preview-capabilities';
import { deriveDocumentDownloadName, deriveDocumentFileName } from '../message-card-document-utils';
import { formatSizeBytes } from '../message-card-image-utils';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import {
  getOcrDownloadItems,
  getOcrInfoSections,
  getOcrInfoSeverity,
  OcrPreviewAction,
  OcrSplitPreview,
} from '../attachment-preview/OcrPreview';
import { MessageCardAttachmentPreviewInfoPopover } from '../attachment-preview/MessageCardAttachmentPreviewInfoPopover';
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
import { DocumentFilePreviewStage } from './DocumentFilePreviewStage';
import { ZipDocumentPreview } from './ZipDocumentPreview';
import { MESSAGE_CARD_PREVIEW_MOBILE_ISLAND_CONTROLS_BOTTOM_PX } from '../attachment-preview/message-card-preview-config';

function NonZipDocumentAttachmentPreviewRenderer({
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
  const touchLandscape = useMediaQuery('(pointer: coarse) and (max-height: 599.95px)');
  const mobileViewport = isMobile || touchLandscape;
  const infoOpen = infoAnchorEl !== null;
  const currentDocumentKind = currentDocument.kind;
  const carouselAboveControls = currentDocumentKind === 'xls' || currentDocumentKind === 'xlsx';
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

  const handleInfoClick = (event: MouseEvent<HTMLButtonElement>) => {
    setInfoAnchorEl(event.currentTarget);
  };

  const handleReprocessQueued = useCallback((nextOcr: NonNullable<MessageCardDocument['ocr']>) => {
    setOcrStatus(nextOcr);
    setOcrVisible(true);
    setOcrFullPane(false);
    setSummaryStatus(null);
    setSummaryVisible(false);
  }, []);

  const sourceStage = (
    <DocumentFilePreviewStage
      source={{
        key: `${currentDocument.kind}:${currentDocument.href}`,
        fileName: currentDocument.fileName ?? '',
        extension: '',
        contentType: currentDocument.contentType ?? '',
        sizeBytes: currentDocument.sizeBytes ?? null,
        originalHref: currentDocument.href,
      }}
      kind={currentDocument.kind}
      zoom={dialogZoom}
      onZoomChange={setZoom}
      onBackgroundClick={onClose}
      zoomBadgePosition={{
        alignWithCarousel: mobileViewport,
        bottom:
          mobileViewport && carouselAboveControls
            ? `calc(${MESSAGE_CARD_PREVIEW_MOBILE_ISLAND_CONTROLS_BOTTOM_PX}px + env(safe-area-inset-bottom, 0px))`
            : undefined,
      }}
    />
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
              kind={reportDraft.kind}
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
      mobileChrome={ocrVisible && ocrFullPane && !isMobile ? 'fixed' : 'toggle'}
      carouselAboveControls={carouselAboveControls}
      headerInFlow={ocrVisible || summaryVisible || (reportDraft != null && reportVisible)}
      stage={stage}
      header={header}
      infoPopover={infoPopover}
      navigation={navigation}
      swipeEnabled={canSwipeCarousel && dialogZoom <= 100}
      onScrollBoundaryDismiss={
        dialogZoom <= 100 &&
        !ocrVisible &&
        !summaryVisible &&
        !(reportDraft != null && reportVisible)
          ? closeDialog
          : undefined
      }
    />
  );
}

export function DocumentAttachmentPreviewRenderer(
  props: {
    document: MessageCardDocument;
    onClose: () => void;
    navigation: MessageCardPreviewNavigation;
    reportDraft?: AttachmentPreviewReportDraft;
  } & MessageCardDownloadGuardProps &
    AttachmentPreviewReportVisibility,
) {
  if (props.document.kind === 'zip') return <ZipDocumentPreview {...props} />;
  return <NonZipDocumentAttachmentPreviewRenderer {...props} />;
}
