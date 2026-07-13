import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  clamp,
  clampPan,
  deriveImageDownloadName,
  derivePreviewFileName,
  normalizePreviewIndex,
  type MessageCardImage,
  type Point,
} from './message-card-image-utils';
import { shouldIgnoreArrowNavigation } from './document-preview-utils';
import {
  isInteractivePreviewTarget,
  sampleCornerColors,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  type DragState,
  type StagePalette,
} from './message-card-image-preview-utils';
import {
  MessageCardImagePreviewActions,
  MessageCardImagePreviewControls,
} from './MessageCardImagePreviewActions';
import { MessageCardImagePreviewInfoPopover } from './MessageCardImagePreviewInfoPopover';
import { MessageCardImagePreviewStage } from './MessageCardImagePreviewStage';
import { canCopyImageToClipboard, copyImageToClipboard } from './copy-image-to-clipboard';
import { blurActivePreviewDialogElement } from './message-card-preview-shell';
import { MessageCardPreviewShell } from './MessageCardPreviewShell';

type StageSize = {
  width: number;
  height: number;
};

export function MessageImagePreviewDialog({
  imageHrefs,
  initialIndex = 0,
  currentIndex,
  open,
  onClose,
  onIndexChange,
}: {
  imageHrefs: MessageCardImage[];
  initialIndex?: number;
  currentIndex?: number;
  open: boolean;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}) {
  const imageCount = imageHrefs.length;
  const hasCarousel = imageCount > 1;
  const resolvedIndex = normalizePreviewIndex(currentIndex ?? initialIndex, imageCount);
  const currentImage = imageHrefs[resolvedIndex] ?? null;
  const currentHref = currentImage?.href ?? '';
  const currentPreviewKey = `${resolvedIndex}:${currentHref}`;
  const [failedHref, setFailedHref] = useState<string | null>(null);
  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null);
  const [loadedImageKey, setLoadedImageKey] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const [zoom, setZoom] = useState(ZOOM_MIN);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [imageSize, setImageSize] = useState<StageSize | null>(null);
  const [, setStagePaletteVersion] = useState(0);
  const [infoAnchorEl, setInfoAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const stagePaletteByHrefRef = useRef(new Map<string, StagePalette>());
  const stageRef = useRef<HTMLDivElement | null>(null);
  const copyRequestKeyRef = useRef<string | null>(null);
  const currentHrefRef = useRef(currentHref);
  const zoomRef = useRef(zoom);
  const dragRef = useRef<DragState | null>(null);
  const pointerListenersRef = useRef<{
    move: (event: PointerEvent) => void;
    end: (event: PointerEvent) => void;
  } | null>(null);
  const infoOpen = infoAnchorEl !== null;
  const previewFileName = useMemo(
    () =>
      currentImage != null
        ? derivePreviewFileName(currentImage, resolvedIndex)
        : `image-${resolvedIndex + 1}`,
    [currentImage, resolvedIndex],
  );
  const downloadFileName = useMemo(
    () =>
      currentImage != null
        ? deriveImageDownloadName(currentImage, resolvedIndex)
        : `image-${resolvedIndex + 1}`,
    [currentImage, resolvedIndex],
  );
  const stagePalette =
    currentHref !== '' ? (stagePaletteByHrefRef.current.get(currentHref) ?? null) : null;
  const stageBackground = stagePalette
    ? `linear-gradient(135deg, ${stagePalette.start} 0%, ${stagePalette.end} 100%)`
    : 'none';
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
    setIsFullscreen(false);
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
        drag.stageWidth,
        drag.stageHeight,
        zoomRef.current,
      );
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
    blurActivePreviewDialogElement();
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

  const setPreviewZoom = (nextZoom: number) => {
    const clampedZoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
    const stage = stageRef.current;
    const currentZoom = zoomRef.current;

    if (clampedZoom === ZOOM_MIN) {
      setZoom(ZOOM_MIN);
      setPan({ x: 0, y: 0 });
      zoomRef.current = ZOOM_MIN;
      return;
    }

    if (clampedZoom < currentZoom && stage != null) {
      setPan((currentPan) =>
        clampPan(currentPan, stage.clientWidth, stage.clientHeight, clampedZoom),
      );
    }

    zoomRef.current = clampedZoom;
    setZoom(clampedZoom);
  };

  useEffect(() => {
    resetImageState();
  }, [currentHref, resolvedIndex, resetImageState]);

  useEffect(() => {
    if (!open) {
      resetPreviewState();
    }
  }, [open, resetPreviewState]);

  useEffect(() => {
    if (!isFullscreen) return;

    const handleFullscreenEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setIsFullscreen(false);
    };

    window.addEventListener('keydown', handleFullscreenEscape as EventListener, true);
    return () => {
      window.removeEventListener('keydown', handleFullscreenEscape as EventListener, true);
    };
  }, [isFullscreen]);

  useEffect(() => {
    if (!open) return;

    const handleWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isFullscreen && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setIsFullscreen(false);
        return;
      }

      if (!hasCarousel || shouldIgnoreArrowNavigation(event.target)) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        goToIndex(resolvedIndex - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation();
        goToIndex(resolvedIndex + 1);
      }
    };

    window.addEventListener('keydown', handleWindowKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown, true);
    };
  }, [hasCarousel, isFullscreen, open, resolvedIndex]);

  useEffect(() => {
    if (!open || stageEl === null) return;

    const handleStageWheelNative = (event: WheelEvent) => {
      if (isInteractivePreviewTarget(event.target)) return;
      event.preventDefault();
      if (event.deltaY < 0) {
        setPreviewZoom(zoomRef.current + ZOOM_STEP);
      } else if (event.deltaY > 0) {
        setPreviewZoom(zoomRef.current - ZOOM_STEP);
      }
    };

    stageEl.addEventListener('wheel', handleStageWheelNative, {
      passive: false,
    });
    return () => {
      stageEl.removeEventListener('wheel', handleStageWheelNative);
    };
  }, [open, stageEl]);

  useEffect(() => removePointerListeners, [removePointerListeners]);

  if (!open || imageCount === 0 || currentImage === null) return null;

  const goToIndex = (nextIndex: number) =>
    onIndexChange(normalizePreviewIndex(nextIndex, imageCount));

  const sampleStagePalette = (image: HTMLImageElement) => {
    const sampleHref = currentHref;
    window.requestAnimationFrame(() => {
      if (sampleHref !== currentHrefRef.current) return;
      const palette = sampleCornerColors(image);
      if (palette === null || sampleHref !== currentHrefRef.current) return;
      stagePaletteByHrefRef.current.set(sampleHref, palette);
      setStagePaletteVersion((value) => value + 1);
    });
  };

  const handleImageLoad = (image: HTMLImageElement) => {
    setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    setFailedHref(null);
    setLoadedImage(image);
    setLoadedImageKey(currentPreviewKey);
    sampleStagePalette(image);
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

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isInteractivePreviewTarget(event.target)) return;
    if (zoom === ZOOM_MIN) return;
    const stage = stageRef.current;
    if (stage === null) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: pan,
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

  return (
    <MessageCardPreviewShell
      open={open}
      isFullscreen={isFullscreen}
      ariaLabel="Перегляд зображення"
      onClose={closeDialog}
      layout="media"
      disableEscapeKeyDown={isFullscreen}
      stage={
        <MessageCardImagePreviewStage
          ref={setStageNode}
          currentImage={currentImage}
          currentHref={currentHref}
          imageCount={imageCount}
          resolvedIndex={resolvedIndex}
          previewFileName={previewFileName}
          zoom={zoom}
          pan={pan}
          failedHref={failedHref}
          imageSize={imageSize}
          stageBackground={stageBackground}
          isFullscreen={isFullscreen}
          onImageLoad={handleImageLoad}
          onImageError={handleImageError}
          onStartPan={startPan}
          onStopPan={stopPan}
          onExitFullscreen={() => setIsFullscreen(false)}
        />
      }
      controls={
        <MessageCardImagePreviewControls
          zoom={zoom}
          isFullscreen={isFullscreen}
          onSetPreviewZoom={setPreviewZoom}
          onToggleFullscreen={() => setIsFullscreen((value) => !value)}
        />
      }
      actions={
        !isFullscreen ? (
          <MessageCardImagePreviewActions
            currentHref={currentHref}
            downloadFileName={downloadFileName}
            hasCarousel={hasCarousel}
            copyStatus={copyStatus}
            canCopyImage={
              loadedImage !== null &&
              loadedImageKey === currentPreviewKey &&
              canCopyImageToClipboard(loadedImage)
            }
            resolvedIndex={resolvedIndex}
            imageCount={imageCount}
            onCopyImage={handleCopyImage}
            onGoToPrevious={() => goToIndex(resolvedIndex - 1)}
            onGoToNext={() => goToIndex(resolvedIndex + 1)}
            onInfoClick={(event) => setInfoAnchorEl(event.currentTarget)}
            onClose={closeDialog}
          />
        ) : null
      }
      infoPopover={
        <MessageCardImagePreviewInfoPopover
          open={infoOpen}
          anchorEl={infoAnchorEl}
          onClose={() => setInfoAnchorEl(null)}
          image={currentImage}
          fileName={previewFileName}
          fileSize={fileSize}
          imageSize={imageSize}
        />
      }
    />
  );
}
