import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';

import {
  clamp,
  clampPan,
  deriveImageDownloadName,
  derivePreviewFileName,
  formatSizeBytes,
  type MessageCardImage,
  type Point,
} from '../message-card-image-utils';
import {
  getNextWheelZoom,
  isInteractivePreviewTarget,
  ZOOM_MAX,
  ZOOM_MARKS,
  ZOOM_MIN,
  ZOOM_STEP,
  type DragState,
} from '../message-card-image-preview-utils';
import { MessageCardAttachmentPreviewActions } from '../attachment-preview/MessageCardAttachmentPreviewActions';
import { AttachmentPreviewZoomControls } from '../attachment-preview/MessageCardAttachmentPreviewControls';
import { MessageCardAttachmentPreviewInfoPopover } from '../attachment-preview/MessageCardAttachmentPreviewInfoPopover';
import { MessageCardAttachmentPreviewStage } from '../attachment-preview/MessageCardAttachmentPreviewStage';
import { canCopyImageToClipboard, copyImageToClipboard } from '../copy-image-to-clipboard';
import { blurActiveAttachmentPreviewElement } from '../attachment-preview/message-card-attachment-preview';
import { getMessageCardAttachmentPreviewConfig } from '../attachment-preview/message-card-preview-config';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import type { MessageCardDownloadGuardProps } from '../MessageCardMedia';
import type { MessageCardPreviewNavigation } from '../attachment-preview/message-card-preview.types';

type StageSize = {
  width: number;
  height: number;
};

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
  imageSize: StageSize | null;
  onLoad: (image: HTMLImageElement) => void;
  onError: () => void;
}) {
  return (
    <>
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
      {failedHref === href ? (
        <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center' }}>
          Зображення недоступне
        </Typography>
      ) : null}
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
  const title =
    status === 'copying'
      ? 'Копіювання...'
      : enabled
        ? 'Скопіювати зображення'
        : 'Копіювання зображень недоступне';

  return (
    <Tooltip title={title} enterDelay={300}>
      <span>
        <IconButton
          aria-label="Скопіювати зображення"
          size="small"
          onClick={onCopy}
          disabled={!enabled || status === 'copying'}
          sx={{ color: 'text.secondary' }}
        >
          <ContentCopyIcon />
        </IconButton>
      </span>
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

function getFittedImageSize(imageSize: StageSize | null, stage: HTMLDivElement): StageSize {
  if (
    imageSize === null ||
    !Number.isFinite(imageSize.width) ||
    !Number.isFinite(imageSize.height) ||
    imageSize.width <= 0 ||
    imageSize.height <= 0
  ) {
    return { width: stage.clientWidth, height: stage.clientHeight };
  }
  const fitScale = Math.min(
    stage.clientWidth / imageSize.width,
    stage.clientHeight / imageSize.height,
  );
  return Number.isFinite(fitScale)
    ? { width: imageSize.width * fitScale, height: imageSize.height * fitScale }
    : { width: stage.clientWidth, height: stage.clientHeight };
}

export function ImageAttachmentPreviewRenderer({
  image,
  onClose,
  navigation,
  isFullscreen,
  onFullscreenChange,
  isDownloadStarting,
  onDownloadStart,
}: {
  image: MessageCardImage;
  onClose: () => void;
  navigation: MessageCardPreviewNavigation;
  isFullscreen: boolean;
  onFullscreenChange: (isFullscreen: boolean) => void;
} & MessageCardDownloadGuardProps) {
  const resolvedIndex = navigation.index;
  const currentImage = image;
  const currentHref = currentImage.href;
  const currentPreviewKey = `${resolvedIndex}:${currentHref}`;
  const [failedHref, setFailedHref] = useState<string | null>(null);
  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null);
  const [loadedImageKey, setLoadedImageKey] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const [zoom, setZoom] = useState(ZOOM_MIN);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [imageSize, setImageSize] = useState<StageSize | null>(null);
  const [infoAnchorEl, setInfoAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const copyRequestKeyRef = useRef<string | null>(null);
  const currentHrefRef = useRef(currentHref);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const dragRef = useRef<DragState | null>(null);
  const pointerListenersRef = useRef<{
    move: (event: PointerEvent) => void;
    end: (event: PointerEvent) => void;
  } | null>(null);
  const infoOpen = infoAnchorEl !== null;
  const previewFileName = useMemo(
    () => derivePreviewFileName(currentImage, resolvedIndex),
    [currentImage, resolvedIndex],
  );
  const downloadFileName = useMemo(
    () => deriveImageDownloadName(currentImage, resolvedIndex),
    [currentImage, resolvedIndex],
  );
  const previewConfig = getMessageCardAttachmentPreviewConfig('image');
  const canFullscreen = previewConfig.supportsFullscreen;
  const dialogIsFullscreen = canFullscreen && isFullscreen;
  const changeFullscreen = useCallback(
    (value: boolean) => onFullscreenChange(value),
    [onFullscreenChange],
  );
  const removePointerListeners = useCallback(() => {
    const listeners = pointerListenersRef.current;
    if (listeners === null) return;
    window.removeEventListener('pointermove', listeners.move as EventListener);
    window.removeEventListener('pointerup', listeners.end as EventListener);
    window.removeEventListener('pointercancel', listeners.end as EventListener);
    pointerListenersRef.current = null;
  }, []);

  const resetImageState = useCallback(() => {
    removePointerListeners();
    dragRef.current = null;
    setZoom(ZOOM_MIN);
    zoomRef.current = ZOOM_MIN;
    setPan({ x: 0, y: 0 });
    panRef.current = { x: 0, y: 0 };
    setFailedHref(null);
    setImageSize(null);
    setLoadedImage(null);
    setLoadedImageKey(null);
    setCopyStatus('idle');
    setInfoAnchorEl(null);
    copyRequestKeyRef.current = null;
  }, [removePointerListeners]);

  const resetPreviewState = useCallback(() => {
    resetImageState();
    changeFullscreen(false);
  }, [changeFullscreen, resetImageState]);

  const addPointerListeners = useCallback(() => {
    removePointerListeners();

    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag === null || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const nextPan = clampPan(
        {
          x: drag.origin.x + (event.clientX - drag.startX),
          y: drag.origin.y + (event.clientY - drag.startY),
        },
        drag.fittedImageWidth,
        drag.fittedImageHeight,
        drag.stageWidth,
        drag.stageHeight,
        zoomRef.current,
        ZOOM_MAX,
      );
      panRef.current = nextPan;
      setPan(nextPan);
    };

    const handlePointerEnd = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag === null || event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      removePointerListeners();
    };

    pointerListenersRef.current = {
      move: handlePointerMove,
      end: handlePointerEnd,
    };
    window.addEventListener('pointermove', handlePointerMove as EventListener, {
      passive: false,
    });
    window.addEventListener('pointerup', handlePointerEnd as EventListener);
    window.addEventListener('pointercancel', handlePointerEnd as EventListener);
  }, [removePointerListeners]);

  const closeDialog = () => {
    blurActiveAttachmentPreviewElement();
    resetPreviewState();
    onClose();
  };

  const setStageNode = useCallback((node: HTMLDivElement | null) => {
    stageRef.current = node;
    setStageEl(node);
  }, []);

  useEffect(() => {
    currentHrefRef.current = currentHref;
  }, [currentHref]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  const setPreviewZoom = (nextZoom: number, cursorPoint: Point = { x: 0, y: 0 }) => {
    const clampedZoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
    const stage = stageRef.current;
    const currentZoom = zoomRef.current;

    if (clampedZoom === ZOOM_MIN) {
      setZoom(ZOOM_MIN);
      setPan({ x: 0, y: 0 });
      panRef.current = { x: 0, y: 0 };
      zoomRef.current = ZOOM_MIN;
      return;
    }

    const currentPan = panRef.current;
    const fittedImageSize = stage === null ? null : getFittedImageSize(imageSize, stage);
    const nextPan =
      stage === null
        ? currentPan
        : clampPan(
            {
              x: cursorPoint.x - (clampedZoom / currentZoom) * (cursorPoint.x - currentPan.x),
              y: cursorPoint.y - (clampedZoom / currentZoom) * (cursorPoint.y - currentPan.y),
            },
            fittedImageSize?.width ?? 0,
            fittedImageSize?.height ?? 0,
            stage.clientWidth,
            stage.clientHeight,
            clampedZoom,
            ZOOM_MAX,
          );
    panRef.current = nextPan;
    setPan(nextPan);

    zoomRef.current = clampedZoom;
    setZoom(clampedZoom);
  };

  useEffect(() => {
    resetImageState();
  }, [currentHref, resolvedIndex, resetImageState]);

  useEffect(() => {
    if (stageEl === null) return;

    const handleStageWheelNative = (event: WheelEvent) => {
      if (isInteractivePreviewTarget(event.target)) return;
      event.preventDefault();
      const rect = stageEl.getBoundingClientRect();
      setPreviewZoom(
        getNextWheelZoom(zoomRef.current, event.deltaY, event.deltaMode, rect.height),
        {
          x: event.clientX - (rect.left + rect.width / 2),
          y: event.clientY - (rect.top + rect.height / 2),
        },
      );
    };

    stageEl.addEventListener('wheel', handleStageWheelNative, {
      passive: false,
    });
    return () => {
      stageEl.removeEventListener('wheel', handleStageWheelNative);
    };
  }, [imageSize, stageEl]);

  useEffect(() => removePointerListeners, [removePointerListeners]);

  const handleImageLoad = (image: HTMLImageElement) => {
    setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    setFailedHref(null);
    setLoadedImage(image);
    setLoadedImageKey(currentPreviewKey);
  };

  const handleImageError = () => {
    setFailedHref(currentHref);
    setLoadedImage(null);
  };

  const handleCopyImage = async () => {
    if (loadedImage === null || loadedImageKey !== currentPreviewKey) return;

    setCopyStatus('copying');
    copyRequestKeyRef.current = currentPreviewKey;

    try {
      await copyImageToClipboard(loadedImage, currentHrefRef.current);
      if (copyRequestKeyRef.current !== currentPreviewKey) return;
      setCopyStatus('copied');
    } catch {
      if (copyRequestKeyRef.current !== currentPreviewKey) return;
      setCopyStatus('error');
    }
  };

  const handleToggleFullscreen = () => {
    if (!canFullscreen) return;
    changeFullscreen(!dialogIsFullscreen);
  };

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isInteractivePreviewTarget(event.target)) return;
    if (zoom === ZOOM_MIN) return;
    const stage = stageRef.current;
    if (stage === null) return;
    const fittedImageSize = getFittedImageSize(imageSize, stage);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: pan,
      fittedImageWidth: fittedImageSize.width,
      fittedImageHeight: fittedImageSize.height,
      stageWidth: stage.clientWidth,
      stageHeight: stage.clientHeight,
    };
    addPointerListeners();
    (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
  };

  const stopPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    removePointerListeners();
    try {
      (event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
    } catch {
      // Ignore pointer-capture teardown failures.
    }
  };

  const fileSize = currentImage.sizeBytes;
  const stage = (
    <MessageCardAttachmentPreviewStage
      ref={setStageNode}
      kind="image"
      isFullscreen={dialogIsFullscreen}
      cursor={zoom > ZOOM_MIN ? 'grab' : 'default'}
      onPointerDown={startPan}
      onPointerUp={stopPan}
      onPointerLeave={stopPan}
    >
      <ImagePreview
        image={currentImage}
        href={currentHref}
        carouselIndex={navigation.index}
        previewFileName={previewFileName}
        zoom={zoom}
        pan={pan}
        failedHref={failedHref}
        imageSize={imageSize}
        onLoad={handleImageLoad}
        onError={handleImageError}
      />
    </MessageCardAttachmentPreviewStage>
  );
  const controls = (
    <AttachmentPreviewZoomControls
      zoom={zoom}
      min={ZOOM_MIN}
      max={ZOOM_MAX}
      buttonStep={ZOOM_STEP}
      sliderStep={1}
      marks={ZOOM_MARKS.map((mark) => mark.value)}
      isFullscreen={dialogIsFullscreen}
      canFullscreen={canFullscreen}
      onZoomChange={setPreviewZoom}
      onToggleFullscreen={handleToggleFullscreen}
    />
  );
  const actions = !dialogIsFullscreen ? (
    <MessageCardAttachmentPreviewActions
      openHref={currentHref}
      download={{ href: currentHref, fileName: downloadFileName }}
      navigation={navigation}
      additionalActions={
        <ImageCopyAction
          status={copyStatus}
          enabled={
            loadedImage !== null &&
            loadedImageKey === currentPreviewKey &&
            canCopyImageToClipboard(loadedImage)
          }
          onCopy={handleCopyImage}
        />
      }
      status={<ImageCopyStatus status={copyStatus} />}
      onInfoClick={(event) => setInfoAnchorEl(event.currentTarget)}
      onClose={closeDialog}
      downloadKey={`media:${String(currentImage?.id ?? '')}`}
      isDownloadStarting={isDownloadStarting}
      onDownloadStart={onDownloadStart}
    />
  ) : null;
  const infoPopover = (
    <MessageCardAttachmentPreviewInfoPopover
      open={infoOpen}
      anchorEl={infoAnchorEl}
      onClose={() => setInfoAnchorEl(null)}
      fields={[
        { label: 'URL', value: currentImage.href || '—' },
        { label: 'Файл', value: previewFileName },
        { label: 'Тип', value: currentImage.contentType?.trim() || '—' },
        { label: 'Розмір файлу', value: formatSizeBytes(fileSize) },
        {
          label: 'Розмір зображення',
          value: imageSize != null ? `${imageSize.width} × ${imageSize.height}` : '—',
        },
        ...(currentImage.id?.trim() ? [{ label: 'ID', value: currentImage.id.trim() }] : []),
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
      onToggleFullscreen={handleToggleFullscreen}
    />
  );
}
