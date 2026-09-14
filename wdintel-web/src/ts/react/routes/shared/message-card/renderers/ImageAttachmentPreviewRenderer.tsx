import type { SyntheticEvent } from 'react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EditIcon from '@mui/icons-material/Edit';
import {
  Alert,
  Box,
  CircularProgress,
  Divider,
  IconButton,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { MessageCardDisabledControlCursorWrapper } from '../MessageCardDisabledControlCursorWrapper';
import {
  deriveImageDownloadName,
  derivePreviewFileName,
  formatSizeBytes,
  type MessageCardImage,
  type Point,
} from '../message-card-image-utils';
import { ZOOM_MIN } from '../message-card-image-preview-utils';
import { AttachmentPreviewZoomBadge } from '../attachment-preview/AttachmentPreviewZoomBadge';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import { MessageCardAttachmentPreviewInfoPopover } from '../attachment-preview/MessageCardAttachmentPreviewInfoPopover';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import { MessageCardAttachmentPreviewStage } from '../attachment-preview/MessageCardAttachmentPreviewStage';
import { blurActiveAttachmentPreviewElement } from '../attachment-preview/message-card-attachment-preview';
import type { MessageCardPreviewNavigation } from '../attachment-preview/message-card-preview.types';
import {
  getOcrDownloadItems,
  getOcrInfoSections,
  getOcrInfoSeverity,
  OcrPreviewAction,
  OcrSplitPreview,
} from '../attachment-preview/OcrPreview';
import {
  isSupportedOcrImage,
  MediaReprocessAction,
} from '../attachment-preview/MediaReprocessAction';
import { MediaSummaryAction } from '../attachment-preview/MediaSummaryPreview';
import {
  ReportTextPreviewAction,
  type AttachmentPreviewReportDraft,
  type AttachmentPreviewReportVisibility,
} from '../attachment-preview/ReportTextPreview';
import { canCopyImageToClipboard, copyImageToClipboard } from '../copy-image-to-clipboard';
import type { MessageCardDownloadGuardProps } from '../MessageCardMedia';
import type {
  ImageEditingCapability,
  RegisterImageEditorEscapeHandler,
} from '../../image-editor/image-editor.types';
import { useImageAttachmentEditorSession } from './use-image-attachment-editor-session';
import { useImageAttachmentPreviewGestures } from './use-image-attachment-preview-gestures';

const ImageEditor = lazy(() =>
  import('../../image-editor/ImageEditor').then(({ ImageEditor: Component }) => ({
    default: Component,
  })),
);

function ImagePreview({
  image,
  href,
  carouselIndex,
  previewFileName,
  zoom,
  pan,
  failedHref,
  imageSize,
  onLoad,
  onError,
}: {
  image: MessageCardImage;
  href: string;
  carouselIndex: number;
  previewFileName: string;
  zoom: number;
  pan: Point;
  failedHref: string | null;
  imageSize: { width: number; height: number } | null;
  onLoad: (image: HTMLImageElement) => void;
  onError: () => void;
}) {
  return (
    <>
      {failedHref === href ? (
        <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center' }}>
          Зображення недоступне
        </Typography>
      ) : null}
      <Box
        component="img"
        src={href}
        alt={`Зображення ${carouselIndex + 1}`}
        data-image-preview-image
        data-image-preview-zoom={zoom}
        data-image-preview-pan-x={pan.x}
        data-image-preview-pan-y={pan.y}
        data-image-preview-file-name={previewFileName}
        data-image-preview-size-bytes={image.sizeBytes ?? ''}
        data-image-preview-natural-width={imageSize?.width ?? ''}
        data-image-preview-natural-height={imageSize?.height ?? ''}
        draggable={false}
        onLoad={(event: SyntheticEvent<HTMLImageElement>) => onLoad(event.currentTarget)}
        onError={onError}
        decoding="async"
        sx={{
          display: failedHref === href ? 'none' : 'block',
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`,
          transformOrigin: 'center center',
          transition: zoom === ZOOM_MIN ? 'transform 120ms ease-out' : 'none',
          willChange: 'transform',
          pointerEvents: 'none',
        }}
      />
    </>
  );
}

function ImageCopyAction({
  status,
  enabled,
  onCopy,
}: {
  status: 'idle' | 'copying' | 'copied' | 'error';
  enabled: boolean;
  onCopy: () => void;
}) {
  return (
    <Tooltip
      title={
        status === 'copying'
          ? 'Копіювання...'
          : enabled
            ? 'Скопіювати зображення'
            : 'Копіювання зображень недоступне'
      }
      enterDelay={300}
    >
      <MessageCardDisabledControlCursorWrapper disabled={!enabled || status === 'copying'}>
        <IconButton
          aria-label="Скопіювати зображення"
          size="small"
          onClick={onCopy}
          disabled={!enabled || status === 'copying'}
          sx={{
            color: 'text.secondary',
            '&:hover': { color: 'text.primary', backgroundColor: 'action.hover' },
            '&.Mui-disabled': { color: 'action.disabled' },
          }}
        >
          {status === 'copying' ? (
            <CircularProgress size={16} color="inherit" />
          ) : (
            <ContentCopyIcon fontSize="small" />
          )}
        </IconButton>
      </MessageCardDisabledControlCursorWrapper>
    </Tooltip>
  );
}

function ImageCopyStatus({ status }: { status: 'idle' | 'copying' | 'copied' | 'error' }) {
  const label =
    status === 'copying'
      ? 'Копіювання...'
      : status === 'copied'
        ? 'Зображення скопійовано'
        : status === 'error'
          ? 'Не вдалося скопіювати зображення'
          : '';
  if (label === '') return null;
  return (
    <Typography
      variant="caption"
      aria-live="polite"
      sx={{
        alignSelf: 'center',
        ml: 0.75,
        color:
          status === 'copied'
            ? 'success.main'
            : status === 'error'
              ? 'error.main'
              : 'text.secondary',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </Typography>
  );
}

export function ImageAttachmentPreviewRenderer({
  image,
  onClose,
  navigation,
  isDownloadStarting,
  onDownloadStart,
  imageEditing,
  initialAction,
  onInitialActionConsumed,
  onEditModeChange,
  registerEditorEscapeHandler,
  onChildOverlayChange,
  dismissChildOverlay,
  reportDraft,
  reportVisible,
  onReportVisibleChange,
}: {
  image: MessageCardImage;
  onClose: () => void;
  navigation: MessageCardPreviewNavigation;
  imageEditing?: ImageEditingCapability;
  initialAction?: 'edit-image';
  onInitialActionConsumed?: () => void;
  onEditModeChange?: (editing: boolean) => void;
  registerEditorEscapeHandler?: RegisterImageEditorEscapeHandler;
  onChildOverlayChange?: (open: boolean) => void;
  dismissChildOverlay?: number;
  reportDraft?: AttachmentPreviewReportDraft;
} & MessageCardDownloadGuardProps &
  AttachmentPreviewReportVisibility) {
  const href = image.href;
  const key = `${navigation.index}:${href}`;
  const [failedHref, setFailedHref] = useState<string | null>(null);
  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null);
  const [loadedImageKey, setLoadedImageKey] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const [infoAnchorEl, setInfoAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [ocrVisible, setOcrVisible] = useState(false);
  const [ocrFullPane, setOcrFullPane] = useState(false);
  const [ocrStatus, setOcrStatus] = useState(image.ocr ?? null);
  const [summaryVisible, setSummaryVisible] = useState(false);
  const [summaryStatus, setSummaryStatus] = useState(image.summary ?? null);
  const currentHrefRef = useRef(href);
  const copyKeyRef = useRef<string | null>(null);
  const editor = useImageAttachmentEditorSession({
    image,
    imageEditing,
    registerEditorEscapeHandler,
  });
  const close = useCallback(() => {
    blurActiveAttachmentPreviewElement();
    onClose();
  }, [onClose]);
  const gestures = useImageAttachmentPreviewGestures({
    previewKey: key,
    href,
    failedHref,
    interactionLocked: editor.isLocked,
    onBackgroundClick: close,
  });
  const isMobile = useMediaQuery(useTheme().breakpoints.down('sm'));
  const previewFileName = useMemo(
    () => derivePreviewFileName(image, navigation.index),
    [image, navigation.index],
  );
  const downloadFileName = useMemo(
    () => deriveImageDownloadName(image, navigation.index),
    [image, navigation.index],
  );
  useEffect(() => {
    currentHrefRef.current = href;
  }, [href]);
  useEffect(() => {
    onEditModeChange?.(editor.isLocked);
    return () => onEditModeChange?.(false);
  }, [editor.isLocked, onEditModeChange]);
  useEffect(() => {
    if (dismissChildOverlay) setInfoAnchorEl(null);
  }, [dismissChildOverlay]);
  const infoOpen = infoAnchorEl !== null;
  useEffect(() => onChildOverlayChange?.(infoOpen), [infoOpen, onChildOverlayChange]);
  useEffect(() => {
    gestures.reset();
    setFailedHref(null);
    setLoadedImage(null);
    setLoadedImageKey(null);
    setCopyStatus('idle');
    setInfoAnchorEl(null);
    setOcrVisible(false);
    setOcrFullPane(false);
    setSummaryVisible(false);
    setOcrStatus(image.ocr ?? null);
    setSummaryStatus(image.summary ?? null);
    copyKeyRef.current = null;
  }, [href, image.ocr, image.summary, navigation.index]);
  useEffect(() => {
    if (initialAction === 'edit-image') {
      onInitialActionConsumed?.();
      void editor.open();
    }
  }, [editor.open, initialAction, onInitialActionConsumed]);
  const onLoad = (element: HTMLImageElement) => {
    gestures.registerImage(element);
    setFailedHref(null);
    setLoadedImage(element);
    setLoadedImageKey(key);
  };
  const copy = async () => {
    if (loadedImage === null || loadedImageKey !== key) return;
    setCopyStatus('copying');
    copyKeyRef.current = key;
    try {
      await copyImageToClipboard(loadedImage, currentHrefRef.current);
      if (copyKeyRef.current === key) setCopyStatus('copied');
    } catch {
      if (copyKeyRef.current === key) setCopyStatus('error');
    }
  };
  const queueOcr = useCallback(
    (ocr: NonNullable<MessageCardImage['ocr']>) => {
      setOcrStatus(ocr);
      setOcrVisible(true);
      setOcrFullPane(false);
      setSummaryStatus(null);
      setSummaryVisible(false);
      onReportVisibleChange(false);
    },
    [onReportVisibleChange],
  );
  if (editor.session !== null)
    return (
      <Suspense
        fallback={<CircularProgress className="m-auto" aria-label="Завантаження редактора" />}
      >
        <ImageEditor
          source={editor.session.source}
          registerEscapeHandler={registerEditorEscapeHandler}
          onCancel={editor.close}
          onSaveReplacement={editor.saveReplacement}
          onSaveAsNew={editor.saveAsNew}
        />
      </Suspense>
    );
  const source = (
    <MessageCardAttachmentPreviewStage
      ref={gestures.stageRef}
      kind="image"
      cursor={gestures.zoom > ZOOM_MIN ? 'grab' : 'default'}
      onPointerDown={gestures.onPointerDown}
      onPointerMove={gestures.onPointerMove}
      onPointerUp={gestures.onPointerUp}
      onPointerCancel={gestures.onPointerCancel}
      onLostPointerCapture={gestures.onLostPointerCapture}
      onPrimaryClick={gestures.onPrimaryClick}
      getPrimaryPointerRegion={gestures.getPrimaryPointerRegion}
      activationEnabled={!editor.isLocked}
      activationKey={key}
    >
      <ImagePreview
        image={image}
        href={href}
        carouselIndex={navigation.index}
        previewFileName={previewFileName}
        zoom={gestures.zoom}
        pan={gestures.pan}
        failedHref={failedHref}
        imageSize={gestures.imageSize}
        onLoad={onLoad}
        onError={() => {
          setFailedHref(href);
          setLoadedImage(null);
        }}
      />
      <AttachmentPreviewZoomBadge
        zoom={gestures.zoom}
        onResetZoom={() => gestures.setPreviewZoom(ZOOM_MIN)}
      />
    </MessageCardAttachmentPreviewStage>
  );
  const stage = (
    <OcrSplitPreview
      source={source}
      mediaId={image.id}
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
  return (
    <MessageCardAttachmentPreviewLayout
      stage={
        editor.error ? (
          <>
            <Alert severity="error" className="m-2">
              {editor.error}
            </Alert>
            {stage}
          </>
        ) : (
          stage
        )
      }
      header={
        <MessageCardAttachmentPreviewHeader
          fileName={previewFileName}
          openHref={href}
          download={{ href, fileName: downloadFileName }}
          navigation={{ ...navigation, disabled: editor.isLocked }}
          additionalActions={
            <>
              <MediaSummaryAction
                status={summaryStatus}
                active={summaryVisible}
                onClick={() =>
                  setSummaryVisible((open) => {
                    const next = !open;
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
                  setOcrVisible((open) => {
                    const next = !open;
                    if (next && isMobile) setSummaryVisible(false);
                    if (next) onReportVisibleChange(false);
                    return next;
                  })
                }
              />
              {summaryStatus != null || ocrStatus != null ? (
                <Divider
                  orientation="vertical"
                  flexItem
                  sx={{ mx: 0.25, my: 0.75, borderColor: 'divider' }}
                />
              ) : null}
              <ImageCopyAction
                status={copyStatus}
                enabled={
                  loadedImage !== null &&
                  loadedImageKey === key &&
                  canCopyImageToClipboard(loadedImage)
                }
                onCopy={copy}
              />
              {imageEditing?.canEdit(image) ? (
                <Tooltip title="Редагувати зображення" enterDelay={300}>
                  <span>
                    <IconButton
                      aria-label="Редагувати зображення"
                      size="small"
                      onClick={() => void editor.open()}
                      disabled={editor.isLocked}
                      sx={{
                        color: 'text.secondary',
                        '&:hover': { color: 'text.primary', backgroundColor: 'action.hover' },
                        '&.Mui-disabled': { color: 'action.disabled' },
                      }}
                    >
                      {editor.loading ? (
                        <CircularProgress size={16} color="inherit" />
                      ) : (
                        <EditIcon fontSize="small" />
                      )}
                    </IconButton>
                  </span>
                </Tooltip>
              ) : null}
            </>
          }
          overflowAction={
            <MediaReprocessAction
              mediaId={image.id}
              supported={
                ocrStatus != null || isSupportedOcrImage(image.contentType, image.fileName)
              }
              ocr={ocrStatus}
              onQueued={queueOcr}
              downloadItems={getOcrDownloadItems(image.id, ocrStatus, previewFileName)}
              isDownloadStarting={isDownloadStarting}
              onDownloadStart={onDownloadStart}
            />
          }
          status={<ImageCopyStatus status={copyStatus} />}
          onInfoClick={(event) => {
            setInfoAnchorEl(event.currentTarget);
            onChildOverlayChange?.(true);
          }}
          infoSeverity={getOcrInfoSeverity(ocrStatus)}
          onClose={close}
          downloadKey={`media:${String(image.id ?? '')}`}
          isDownloadStarting={isDownloadStarting}
          onDownloadStart={onDownloadStart}
        />
      }
      infoPopover={
        <MessageCardAttachmentPreviewInfoPopover
          open={infoOpen}
          anchorEl={infoAnchorEl}
          onClose={() => {
            setInfoAnchorEl(null);
            onChildOverlayChange?.(false);
          }}
          fields={[
            { label: 'URL', value: href || '—' },
            { label: 'Файл', value: previewFileName },
            { label: 'Тип', value: image.contentType?.trim() || '—' },
            { label: 'Розмір файлу', value: formatSizeBytes(image.sizeBytes) },
            {
              label: 'Розмір зображення',
              value:
                gestures.imageSize == null
                  ? '—'
                  : `${gestures.imageSize.width} × ${gestures.imageSize.height}`,
            },
            ...(image.id?.trim() ? [{ label: 'ID', value: image.id.trim() }] : []),
          ]}
          sections={getOcrInfoSections(ocrStatus)}
        />
      }
      navigation={navigation}
      swipeEnabled={gestures.zoom <= ZOOM_MIN && !editor.isLocked}
    />
  );
}
