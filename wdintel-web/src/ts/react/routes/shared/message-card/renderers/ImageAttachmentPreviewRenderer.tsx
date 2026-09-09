import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EditIcon from '@mui/icons-material/Edit';
import {
  Box,
  Alert,
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
import { canCopyImageToClipboard, copyImageToClipboard } from '../copy-image-to-clipboard';
import { blurActiveAttachmentPreviewElement } from '../attachment-preview/message-card-attachment-preview';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import type { MessageCardDownloadGuardProps } from '../MessageCardMedia';
import type { MessageCardPreviewNavigation } from '../attachment-preview/message-card-preview.types';
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
import { useImageAttachmentEditorSession } from './use-image-attachment-editor-session';
import type {
  ImageEditingCapability,
  RegisterImageEditorEscapeHandler,
} from '../../image-editor/image-editor.types';

const ImageEditor = lazy(() =>
  import('../../image-editor/ImageEditor').then(({ ImageEditor: Component }) => ({
    default: Component,
  })),
);
type StageSize = {
  width: number;
  height: number;
};

type TouchPoint = Point;

type TouchGesture =
  | { mode: 'idle' | 'swipe-candidate' }
  | { mode: 'pan'; pointerId: number; start: TouchPoint; origin: Point }
  | {
      mode: 'pinch';
      startZoom: number;
      startPan: Point;
      startDistance: number;
      startMidpoint: TouchPoint;
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
    1,
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
  const resolvedIndex = navigation.index;
  const currentImage = image;
  const currentHref = currentImage.href;
  const currentPreviewKey = `${resolvedIndex}:${currentHref}`;
  const [failedHref, setFailedHref] = useState<string | null>(null);
  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null);
  const [loadedImageKey, setLoadedImageKey] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const [zoom, setZoom] = useState(ZOOM_MIN);
  const editor = useImageAttachmentEditorSession({
    image: currentImage,
    imageEditing,
    registerEditorEscapeHandler,
  });
  useEffect(() => {
    onEditModeChange?.(editor.isLocked);
    return () => onEditModeChange?.(false);
  }, [editor.isLocked, onEditModeChange]);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [imageSize, setImageSize] = useState<StageSize | null>(null);
  const [infoAnchorEl, setInfoAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [ocrVisible, setOcrVisible] = useState(false);
  const [ocrFullPane, setOcrFullPane] = useState(false);
  const [ocrStatus, setOcrStatus] = useState(currentImage.ocr ?? null);
  const [summaryVisible, setSummaryVisible] = useState(false);
  const [summaryStatus, setSummaryStatus] = useState(currentImage.summary ?? null);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageElementRef = useRef<HTMLImageElement | null>(null);
  const copyRequestKeyRef = useRef<string | null>(null);
  const currentHrefRef = useRef(currentHref);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const dragRef = useRef<DragState | null>(null);
  const touchPointsRef = useRef(new Map<number, TouchPoint>());
  const touchGestureRef = useRef<TouchGesture>({ mode: 'idle' });
  const releasedPointerIdsRef = useRef(new Set<number>());
  const cleaningGestureRef = useRef(false);
  const pointerListenersRef = useRef<{
    move: (event: PointerEvent) => void;
    end: (event: PointerEvent) => void;
  } | null>(null);
  const infoOpen = infoAnchorEl !== null;
  useEffect(() => onChildOverlayChange?.(infoOpen), [infoOpen, onChildOverlayChange]);
  useEffect(() => {
    if (dismissChildOverlay) setInfoAnchorEl(null);
  }, [dismissChildOverlay]);
  const previewFileName = useMemo(
    () => derivePreviewFileName(currentImage, resolvedIndex),
    [currentImage, resolvedIndex],
  );
  const downloadFileName = useMemo(
    () => deriveImageDownloadName(currentImage, resolvedIndex),
    [currentImage, resolvedIndex],
  );
  const removePointerListeners = useCallback(() => {
    const listeners = pointerListenersRef.current;
    if (listeners === null) return;
    window.removeEventListener('pointermove', listeners.move as EventListener);
    window.removeEventListener('pointerup', listeners.end as EventListener);
    window.removeEventListener('pointercancel', listeners.end as EventListener);
    pointerListenersRef.current = null;
  }, []);

  const cleanupImageGesture = useCallback(() => {
    if (cleaningGestureRef.current) return;
    cleaningGestureRef.current = true;
    const stage = stageRef.current;
    for (const pointerId of touchPointsRef.current.keys()) {
      try {
        if (stage?.hasPointerCapture(pointerId)) {
          releasedPointerIdsRef.current.add(pointerId);
          stage.releasePointerCapture(pointerId);
        }
      } catch {
        // Capture ownership can already be gone after an interrupted gesture.
      }
    }
    touchPointsRef.current.clear();
    touchGestureRef.current = { mode: 'idle' };
    dragRef.current = null;
    removePointerListeners();
    stage?.dispatchEvent(new CustomEvent('attachment-preview-gesture-end', { bubbles: true }));
    cleaningGestureRef.current = false;
  }, [removePointerListeners]);

  const resetImageState = useCallback(() => {
    cleanupImageGesture();
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
    setOcrVisible(false);
    setOcrFullPane(false);
    setSummaryVisible(false);
    setSummaryStatus(currentImage.summary ?? null);
    copyRequestKeyRef.current = null;
  }, [cleanupImageGesture, currentImage.summary]);

  const resetPreviewState = useCallback(() => {
    resetImageState();
  }, [resetImageState]);

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

  const setStageNode = useCallback(
    (node: HTMLDivElement | null) => {
      if (stageRef.current !== null && stageRef.current !== node) cleanupImageGesture();
      stageRef.current = node;
      setStageEl(node);
    },
    [cleanupImageGesture],
  );

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
          );
    panRef.current = nextPan;
    setPan(nextPan);

    zoomRef.current = clampedZoom;
    setZoom(clampedZoom);
  };

  useEffect(() => {
    resetImageState();
    setOcrStatus(currentImage.ocr ?? null);
  }, [currentHref, currentImage.ocr, currentImage.summary, resolvedIndex, resetImageState]);

  useEffect(() => {
    if (stageEl === null) return;

    const handleStageWheelNative = (event: WheelEvent) => {
      if (isInteractivePreviewTarget(event.target)) return;
      event.preventDefault();
      const rect = stageEl.getBoundingClientRect();
      const imageRect = imageElementRef.current?.getBoundingClientRect();
      const overImage =
        imageRect != null &&
        event.clientX >= imageRect.left &&
        event.clientX <= imageRect.right &&
        event.clientY >= imageRect.top &&
        event.clientY <= imageRect.bottom;
      setPreviewZoom(
        getNextWheelZoom(zoomRef.current, event.deltaY, event.deltaMode, rect.height),
        overImage
          ? {
              x: event.clientX - (rect.left + rect.width / 2),
              y: event.clientY - (rect.top + rect.height / 2),
            }
          : { x: 0, y: 0 },
      );
    };

    stageEl.addEventListener('wheel', handleStageWheelNative, { passive: false });

    return () => {
      stageEl.removeEventListener('wheel', handleStageWheelNative);
    };
  }, [imageSize, stageEl]);

  useEffect(() => cleanupImageGesture, [cleanupImageGesture]);

  useEffect(() => {
    if (editor.isLocked) cleanupImageGesture();
  }, [cleanupImageGesture, editor.isLocked]);

  const handleImageLoad = (image: HTMLImageElement) => {
    imageElementRef.current = image;
    setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    setFailedHref(null);
    setLoadedImage(image);
    setLoadedImageKey(currentPreviewKey);
  };

  const handleImageError = () => {
    imageElementRef.current = null;
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

  useEffect(() => {
    if (initialAction !== 'edit-image') return;
    onInitialActionConsumed?.();
    void editor.open();
  }, [editor.open, initialAction, onInitialActionConsumed]);

  const handleReprocessQueued = useCallback(
    (nextOcr: NonNullable<MessageCardImage['ocr']>) => {
      setOcrStatus(nextOcr);
      setOcrVisible(true);
      setOcrFullPane(false);
      setSummaryStatus(null);
      setSummaryVisible(false);
      onReportVisibleChange(false);
    },
    [onReportVisibleChange],
  );

  const getPrimaryPointerRegion = (event: PointerEvent) => {
    if (isInteractivePreviewTarget(event.target)) return 'protected' as const;
    const imageElement = imageElementRef.current;
    if (imageElement === null || failedHref === currentHref) return 'background' as const;
    const rect = imageElement.getBoundingClientRect();
    return event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
      ? ('content' as const)
      : ('background' as const);
  };

  const handlePrimaryClick = (
    event: MouseEvent,
    region: 'background' | 'content' | 'protected',
  ) => {
    if (editor.isLocked) return;
    if (region === 'protected') return;
    if (region === 'background') {
      closeDialog();
      return;
    }
    if (zoomRef.current > ZOOM_MIN) {
      setPreviewZoom(ZOOM_MIN);
    } else {
      setZoom(200);
      zoomRef.current = 200;
      setPan({ x: 0, y: 0 });
      panRef.current = { x: 0, y: 0 };
    }
  };

  const getStagePoint = (event: ReactPointerEvent<HTMLDivElement>): TouchPoint => {
    const rect = stageRef.current?.getBoundingClientRect();
    return {
      x: event.clientX - ((rect?.left ?? 0) + (rect?.width ?? 0) / 2),
      y: event.clientY - ((rect?.top ?? 0) + (rect?.height ?? 0) / 2),
    };
  };

  const clampPreviewPan = (point: Point, nextZoom = zoomRef.current) => {
    const stage = stageRef.current;
    if (stage === null) return point;
    const baseSize = getFittedImageSize(imageSize, stage);
    return clampPan(
      point,
      baseSize.width,
      baseSize.height,
      stage.clientWidth,
      stage.clientHeight,
      nextZoom,
    );
  };

  const setPreviewTransform = (nextZoom: number, nextPan: Point) => {
    const clampedZoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
    const clampedPan =
      clampedZoom === ZOOM_MIN ? { x: 0, y: 0 } : clampPreviewPan(nextPan, clampedZoom);
    zoomRef.current = clampedZoom;
    panRef.current = clampedPan;
    setZoom(clampedZoom);
    setPan(clampedPan);
  };

  useEffect(() => {
    if (stageEl === null || imageSize === null) return;
    const clampAfterLayoutChange = () => {
      if (zoomRef.current <= ZOOM_MIN) return;
      setPreviewTransform(zoomRef.current, panRef.current);
    };
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clampAfterLayoutChange);
    observer?.observe(stageEl);
    window.addEventListener('resize', clampAfterLayoutChange);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', clampAfterLayoutChange);
    };
  }, [imageSize, stageEl]);

  const beginPinch = () => {
    const [first, second] = Array.from(touchPointsRef.current.values());
    if (first == null || second == null) return;
    const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    touchGestureRef.current = {
      mode: 'pinch',
      startZoom: zoomRef.current,
      startPan: panRef.current,
      startDistance: Math.hypot(first.x - second.x, first.y - second.y),
      startMidpoint: midpoint,
    };
    dragRef.current = null;
    removePointerListeners();
    stageRef.current?.dispatchEvent(new CustomEvent('attachment-preview-pinch', { bubbles: true }));
  };

  const updateTouchGesture = () => {
    const gesture = touchGestureRef.current;
    if (gesture.mode !== 'pinch') return;
    const [first, second] = Array.from(touchPointsRef.current.values());
    if (first == null || second == null || gesture.startDistance <= 0) return;
    const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const nextZoom = clamp(
      gesture.startZoom *
        (Math.hypot(first.x - second.x, first.y - second.y) / gesture.startDistance),
      ZOOM_MIN,
      ZOOM_MAX,
    );
    const ratio = nextZoom / gesture.startZoom;
    setPreviewTransform(nextZoom, {
      x: midpoint.x - ratio * (gesture.startMidpoint.x - gesture.startPan.x),
      y: midpoint.y - ratio * (gesture.startMidpoint.y - gesture.startPan.y),
    });
  };

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (editor.isLocked) return;
    if (isInteractivePreviewTarget(event.target)) return;
    if (event.pointerType === 'touch') {
      releasedPointerIdsRef.current.delete(event.pointerId);
      touchPointsRef.current.set(event.pointerId, getStagePoint(event));
      if (touchPointsRef.current.size === 2) {
        beginPinch();
      } else if (zoomRef.current > ZOOM_MIN) {
        touchGestureRef.current = {
          mode: 'pan',
          pointerId: event.pointerId,
          start: getStagePoint(event),
          origin: panRef.current,
        };
      } else {
        touchGestureRef.current = { mode: 'swipe-candidate' };
      }
      (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
      return;
    }
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

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return;
    if (editor.isLocked) return;
    if (!touchPointsRef.current.has(event.pointerId)) return;
    event.preventDefault();
    const point = getStagePoint(event);
    touchPointsRef.current.set(event.pointerId, point);
    const gesture = touchGestureRef.current;
    if (gesture.mode === 'pinch') {
      updateTouchGesture();
      return;
    }
    if (gesture.mode === 'pan' && gesture.pointerId === event.pointerId) {
      setPreviewTransform(zoomRef.current, {
        x: gesture.origin.x + point.x - gesture.start.x,
        y: gesture.origin.y + point.y - gesture.start.y,
      });
    }
  };

  const stopPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') {
      touchPointsRef.current.delete(event.pointerId);
      const remaining = Array.from(touchPointsRef.current.entries());
      if (remaining.length === 1) {
        const [pointerId, point] = remaining[0]!;
        touchGestureRef.current = {
          mode: 'pan',
          pointerId,
          start: point,
          origin: panRef.current,
        };
      } else if (remaining.length === 0) {
        touchGestureRef.current = { mode: 'idle' };
        stageRef.current?.dispatchEvent(
          new CustomEvent('attachment-preview-gesture-end', { bubbles: true }),
        );
      }
      try {
        releasedPointerIdsRef.current.add(event.pointerId);
        (event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already have been released by the browser.
      }
      return;
    }
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    removePointerListeners();
    try {
      releasedPointerIdsRef.current.add(event.pointerId);
      (event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
    } catch {
      // Ignore pointer-capture teardown failures.
    }
  };

  const cancelPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'mouse') return;
    cleanupImageGesture();
  };

  const lostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (releasedPointerIdsRef.current.delete(event.pointerId)) return;
    if (cleaningGestureRef.current) return;
    cancelPan(event);
  };

  if (editor.session !== null) {
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
  }

  const fileSize = currentImage.sizeBytes;
  const sourceStage = (
    <MessageCardAttachmentPreviewStage
      ref={setStageNode}
      kind="image"
      cursor={zoom > ZOOM_MIN ? 'grab' : 'default'}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={stopPan}
      onPointerCancel={cancelPan}
      onLostPointerCapture={lostPointerCapture}
      onPrimaryClick={handlePrimaryClick}
      getPrimaryPointerRegion={getPrimaryPointerRegion}
      activationEnabled={!editor.isLocked}
      activationKey={currentPreviewKey}
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
      <AttachmentPreviewZoomBadge zoom={zoom} onResetZoom={() => setPreviewZoom(ZOOM_MIN)} />
    </MessageCardAttachmentPreviewStage>
  );
  const stage = (
    <OcrSplitPreview
      source={sourceStage}
      mediaId={currentImage.id}
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
      openHref={currentHref}
      download={{ href: currentHref, fileName: downloadFileName }}
      navigation={{ ...navigation, disabled: editor.isLocked }}
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
              loadedImageKey === currentPreviewKey &&
              canCopyImageToClipboard(loadedImage)
            }
            onCopy={handleCopyImage}
          />
          {imageEditing?.canEdit(currentImage) ? (
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
          mediaId={currentImage.id}
          supported={
            ocrStatus != null ||
            isSupportedOcrImage(currentImage.contentType, currentImage.fileName)
          }
          ocr={ocrStatus}
          onQueued={handleReprocessQueued}
          downloadItems={getOcrDownloadItems(currentImage.id, ocrStatus, previewFileName)}
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
      onClose={closeDialog}
      downloadKey={`media:${String(currentImage?.id ?? '')}`}
      isDownloadStarting={isDownloadStarting}
      onDownloadStart={onDownloadStart}
    />
  );
  const infoPopover = (
    <MessageCardAttachmentPreviewInfoPopover
      open={infoOpen}
      anchorEl={infoAnchorEl}
      onClose={() => {
        setInfoAnchorEl(null);
        onChildOverlayChange?.(false);
      }}
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
      sections={getOcrInfoSections(ocrStatus)}
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
      header={header}
      infoPopover={infoPopover}
      navigation={navigation}
      swipeEnabled={zoom <= ZOOM_MIN && !editor.isLocked}
    />
  );
}
