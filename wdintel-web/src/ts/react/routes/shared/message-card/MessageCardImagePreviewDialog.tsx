import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import DownloadIcon from '@mui/icons-material/Download';
import InfoIcon from '@mui/icons-material/Info';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  IconButton,
  Popover,
  Slider,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';

import {
  clamp,
  clampPan,
  deriveImageDownloadName,
  derivePreviewFileName,
  formatSizeBytes,
  normalizePreviewIndex,
  type MessageCardImage,
  type Point,
} from './message-card-image-utils';

const ZOOM_MIN = 100;
const ZOOM_MAX = 400;
const ZOOM_STEP = 25;
const ZOOM_MARKS = [100, 150, 200, 300, 400].map((value) => ({ value, label: `${value}%` }));

type StagePalette = {
  start: string;
  end: string;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  origin: Point;
  stageWidth: number;
  stageHeight: number;
};

function sampleCornerColors(image: HTMLImageElement): StagePalette | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context == null) return null;
    context.drawImage(image, 0, 0);
    const topLeft = context.getImageData(0, 0, 1, 1).data;
    const bottomRight = context.getImageData(Math.max(image.naturalWidth - 1, 0), Math.max(image.naturalHeight - 1, 0), 1, 1).data;
    return {
      start: rgbaToCssColor(topLeft),
      end: rgbaToCssColor(bottomRight),
    };
  } catch {
    return null;
  }
}

function rgbaToCssColor([r, g, b, a]: Uint8ClampedArray): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.max(a / 255, 0.08)})`;
}

function isInteractivePreviewTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('[data-image-preview-nav], button, a, input, textarea, select, [role="slider"], [contenteditable="true"]'));
}

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
  const theme = useTheme();
  const imageCount = imageHrefs.length;
  const hasCarousel = imageCount > 1;
  const resolvedIndex = normalizePreviewIndex(currentIndex ?? initialIndex, imageCount);
  const currentImage = imageHrefs[resolvedIndex] ?? null;
  const currentHref = currentImage?.href ?? '';
  const [failedHref, setFailedHref] = useState<string | null>(null);
  const [zoom, setZoom] = useState(ZOOM_MIN);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [, setStagePaletteVersion] = useState(0);
  const [infoAnchorEl, setInfoAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const stagePaletteByHrefRef = useRef(new Map<string, StagePalette>());
  const stageRef = useRef<HTMLDivElement | null>(null);
  const currentHrefRef = useRef(currentHref);
  const zoomRef = useRef(zoom);
  const dragRef = useRef<DragState | null>(null);
  const infoOpen = infoAnchorEl !== null;
  const previewFileName = useMemo(() => (currentImage != null ? derivePreviewFileName(currentImage, resolvedIndex) : `image-${resolvedIndex + 1}`), [currentImage, resolvedIndex]);
  const downloadFileName = useMemo(() => (currentImage != null ? deriveImageDownloadName(currentImage, resolvedIndex) : `image-${resolvedIndex + 1}`), [currentImage, resolvedIndex]);
  const stagePalette = currentHref !== '' ? stagePaletteByHrefRef.current.get(currentHref) ?? null : null;
  const stageBackground = stagePalette
    ? `linear-gradient(135deg, ${stagePalette.start} 0%, ${stagePalette.end} 100%)`
    : `linear-gradient(135deg, ${theme.palette.grey[900]} 0%, ${theme.palette.background.default} 100%)`;
  const resetPreviewState = useCallback(() => {
    setZoom(ZOOM_MIN);
    zoomRef.current = ZOOM_MIN;
    setPan({ x: 0, y: 0 });
    setFailedHref(null);
    setImageSize(null);
    setInfoAnchorEl(null);
    setIsFullscreen(false);
  }, []);
  const closeDialog = () => {
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
      return;
    }

    if (clampedZoom < currentZoom && stage != null) {
      setPan((currentPan) => clampPan(currentPan, stage.clientWidth, stage.clientHeight, clampedZoom));
    }

    zoomRef.current = clampedZoom;
    setZoom(clampedZoom);
  };

  useEffect(() => {
    resetPreviewState();
  }, [currentHref, resetPreviewState]);

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

    const shouldIgnoreArrowNavigation = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return Boolean(
        target.closest('input, textarea, select, [contenteditable="true"], [role="slider"]'),
      );
    };

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

    stageEl.addEventListener('wheel', handleStageWheelNative, { passive: false });
    return () => {
      stageEl.removeEventListener('wheel', handleStageWheelNative);
    };
  }, [open, currentHref, stageEl, resetPreviewState]);

  useEffect(() => {
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
        zoom,
      );
      setPan(nextPan);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag === null || event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove as EventListener);
      window.removeEventListener('pointerup', handlePointerUp as EventListener);
      window.removeEventListener('pointercancel', handlePointerUp as EventListener);
    };

    window.addEventListener('pointermove', handlePointerMove as EventListener, { passive: false });
    window.addEventListener('pointerup', handlePointerUp as EventListener);
    window.addEventListener('pointercancel', handlePointerUp as EventListener);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove as EventListener);
      window.removeEventListener('pointerup', handlePointerUp as EventListener);
      window.removeEventListener('pointercancel', handlePointerUp as EventListener);
    };
  }, [zoom]);

  if (!open || imageCount === 0 || currentImage === null) return null;

  const goToIndex = (nextIndex: number) => onIndexChange(normalizePreviewIndex(nextIndex, imageCount));

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

  const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    setFailedHref(null);
    sampleStagePalette(image);
  };

  const handleImageError = () => {
    setFailedHref(currentHref);
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
    (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
  };

  const stopPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      (event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
    } catch {
      // Ignore pointer-capture teardown failures.
    }
  };

  const imageTransform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`;
  const fileSize = formatSizeBytes(currentImage.sizeBytes);
  const imageId = currentImage.id?.trim() ?? '';
  const showImageId = imageId !== '';

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      maxWidth={false}
      aria-label="Перегляд зображення"
      disableEscapeKeyDown={isFullscreen}
      PaperProps={{
        sx: {
          backgroundColor: '#0b0f14',
          backgroundImage: 'none',
          color: '#f4f7fb',
          display: 'flex',
          flexDirection: 'column',
          width: isFullscreen ? '100vw' : { xs: '96vw', sm: '92vw' },
          height: isFullscreen ? '100svh' : '92svh',
          maxWidth: isFullscreen ? '100vw' : 'min(92vw, 1280px)',
          maxHeight: isFullscreen ? '100svh' : '92svh',
          borderRadius: isFullscreen ? 0 : 2,
          m: 0,
          overflow: 'hidden',
        },
      }}
      BackdropProps={{
        sx: {
          backgroundColor: 'rgba(0, 0, 0, 0.82)',
        },
      }}
    >
      <DialogContent
      sx={{
        px: 2,
        py: 2,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        minHeight: 0,
        flex: '1 1 auto',
        overflow: 'hidden',
        gap: 1.25,
      }}
    >
          <Box
            data-image-preview-stage
            ref={setStageNode}
          onPointerDown={startPan}
          onPointerUp={stopPan}
          onPointerLeave={stopPan}
          sx={{
          flex: '1 1 auto',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 0,
          overflow: 'hidden',
          borderRadius: isFullscreen ? 0 : 1.5,
          backgroundImage: stageBackground,
          backgroundColor: '#111821',
          backgroundRepeat: 'no-repeat',
          backgroundSize: 'cover',
          px: 1.5,
          py: 1.5,
          boxShadow: isFullscreen ? 'none' : 'inset 0 0 0 1px rgba(255, 255, 255, 0.04)',
          cursor: zoom > ZOOM_MIN ? 'grab' : 'default',
          userSelect: 'none',
        }}
      >
        {isFullscreen ? (
          <Tooltip title="Вийти з повноекранного режиму" enterDelay={300}>
            <IconButton
              aria-label="Вийти з повноекранного режиму"
              onClick={() => setIsFullscreen(false)}
              size="small"
              sx={{
                position: 'absolute',
                top: 12,
                right: 12,
                zIndex: 11,
                color: 'inherit',
                backgroundColor: 'rgba(0, 0, 0, 0.28)',
              }}
            >
              <FullscreenExitIcon />
            </IconButton>
          </Tooltip>
        ) : null}
        <Box
          component="img"
          src={currentHref}
          alt={`Зображення ${resolvedIndex + 1}`}
          data-image-preview-image
          data-image-preview-zoom={zoom}
          data-image-preview-pan-x={pan.x}
          data-image-preview-pan-y={pan.y}
          data-image-preview-file-name={previewFileName}
          data-image-preview-size-bytes={currentImage.sizeBytes ?? ''}
          data-image-preview-natural-width={imageSize?.width ?? ''}
          data-image-preview-natural-height={imageSize?.height ?? ''}
          draggable={false}
          onLoad={handleImageLoad}
          onError={handleImageError}
          sx={{
            display: failedHref === currentHref ? 'none' : 'block',
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            transform: imageTransform,
            transformOrigin: 'center center',
            transition: zoom === ZOOM_MIN ? 'transform 120ms ease-out' : 'none',
            willChange: 'transform',
            pointerEvents: 'none',
            filter: 'drop-shadow(0 10px 24px rgba(0, 0, 0, 0.3))',
          }}
        />
        {failedHref === currentHref ? (
          <Typography variant="body2" sx={{ color: 'rgba(244, 247, 251, 0.8)', textAlign: 'center' }}>
            Зображення недоступне
          </Typography>
        ) : null}
        {hasCarousel ? (
          <>
            <Box
              data-image-preview-nav="prev"
              onPointerDown={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
              sx={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                width: '4rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'linear-gradient(90deg, rgba(0,0,0,0.14), transparent)',
                pointerEvents: 'auto',
                zIndex: 10,
              }}
            >
              <Tooltip title="Попереднє" enterDelay={300}>
                <IconButton
                  data-image-preview-nav="prev"
                  onClick={(event) => {
                    event.stopPropagation();
                    goToIndex(resolvedIndex - 1);
                  }}
                  aria-label="Попереднє"
                  sx={{
                    pointerEvents: 'auto',
                    color: '#fff',
                    backgroundColor: 'rgba(0, 0, 0, 0.42)',
                    border: '1px solid rgba(255, 255, 255, 0.18)',
                    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
                    '&:hover, &:focus-visible': {
                      backgroundColor: 'rgba(0, 0, 0, 0.62)',
                    },
                  }}
                >
                  <ChevronLeftIcon />
                </IconButton>
              </Tooltip>
            </Box>
            <Box
              data-image-preview-nav="next"
              onPointerDown={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
              sx={{
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: 0,
                width: '4rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'linear-gradient(270deg, rgba(0,0,0,0.14), transparent)',
                pointerEvents: 'auto',
                zIndex: 10,
              }}
            >
              <Tooltip title="Наступне" enterDelay={300}>
                <IconButton
                  data-image-preview-nav="next"
                  onClick={(event) => {
                    event.stopPropagation();
                    goToIndex(resolvedIndex + 1);
                  }}
                  aria-label="Наступне"
                  sx={{
                    pointerEvents: 'auto',
                    color: '#fff',
                    backgroundColor: 'rgba(0, 0, 0, 0.42)',
                    border: '1px solid rgba(255, 255, 255, 0.18)',
                    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
                    '&:hover, &:focus-visible': {
                      backgroundColor: 'rgba(0, 0, 0, 0.62)',
                    },
                  }}
                >
                  <ChevronRightIcon />
                </IconButton>
              </Tooltip>
            </Box>
          </>
        ) : null}
      </Box>
      <Typography
        variant="body2"
        data-image-preview-counter
        sx={{
          alignSelf: 'center',
          color: 'rgba(244, 247, 251, 0.72)',
          fontWeight: 700,
          letterSpacing: 0,
          px: 1,
          py: 0.25,
          borderRadius: 1,
          border: '1px solid rgba(244, 247, 251, 0.12)',
          backgroundColor: 'rgba(244, 247, 251, 0.08)',
        }}
      >
        {`${resolvedIndex + 1} / ${imageCount}`}
      </Typography>
      <Popover
        open={infoOpen}
        anchorEl={infoAnchorEl}
        onClose={() => setInfoAnchorEl(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        slotProps={{
          paper: {
            sx: {
              p: 1.5,
              minWidth: 280,
              maxWidth: 360,
              backgroundColor: '#111821',
              color: '#f4f7fb',
            },
          },
        }}
      >
        <Stack spacing={1}>
          <Box>
            <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
              URL
            </Typography>
            <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
              {currentHref || '—'}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
              Файл
            </Typography>
            <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
              {previewFileName}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
              Тип
            </Typography>
            <Typography variant="body2">{currentImage.contentType?.trim() || '—'}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
              Розмір файлу
            </Typography>
            <Typography variant="body2">{fileSize}</Typography>
          </Box>
          <Box>
            <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
              Розмір зображення
            </Typography>
            <Typography variant="body2">{imageSize != null ? `${imageSize.width} × ${imageSize.height}` : '—'}</Typography>
          </Box>
          {showImageId ? (
            <Box>
              <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
                ID
              </Typography>
              <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                {imageId}
              </Typography>
            </Box>
          ) : null}
        </Stack>
      </Popover>
    </DialogContent>
    <DialogActions
      sx={{
        px: 2,
        py: '28px',
        borderTop: '1px solid',
        borderColor: 'rgba(244, 247, 251, 0.12)',
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        gap: 1,
      }}
    >
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ justifySelf: 'start', minWidth: 0, flexWrap: 'wrap' }}>
        <Tooltip title="Інформація" enterDelay={300}>
          <IconButton
            aria-label="Інформація"
            size="small"
            onClick={(event) => setInfoAnchorEl(event.currentTarget)}
            sx={{ color: 'inherit' }}
          >
            <InfoIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'} enterDelay={300}>
          <IconButton
            aria-label={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
            size="small"
            onClick={() => setIsFullscreen((value) => !value)}
            sx={{ color: 'inherit' }}
          >
            {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Відкрити в новій вкладці" enterDelay={300}>
          <IconButton
            component="a"
            href={currentHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Відкрити в новій вкладці"
            size="small"
            sx={{ color: 'inherit' }}
          >
            <OpenInNewIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Завантажити" enterDelay={300}>
          <IconButton
            component="a"
            href={currentHref}
            download={downloadFileName}
            aria-label="Завантажити"
            size="small"
            sx={{ color: 'inherit' }}
          >
            <DownloadIcon />
          </IconButton>
        </Tooltip>
      </Stack>
      <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="center" sx={{ justifySelf: 'center', minWidth: 0 }}>
        <Tooltip title="Зменшити" enterDelay={300}>
          <span>
            <IconButton
              aria-label="Зменшити"
              size="small"
              onClick={() => setPreviewZoom(zoom - ZOOM_STEP)}
              disabled={zoom <= ZOOM_MIN}
              sx={{ color: 'inherit' }}
            >
              <ZoomOutIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Slider
          value={zoom}
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          marks={ZOOM_MARKS}
          valueLabelDisplay="auto"
          aria-label="Масштаб"
          onChange={(_, value) => {
            const nextZoom = Array.isArray(value) ? value[0] ?? ZOOM_MIN : value;
            setPreviewZoom(nextZoom);
          }}
          sx={{
            width: { xs: 180, sm: 260 },
            color: 'primary.light',
            '& .MuiSlider-markLabel': {
              color: 'rgba(244, 247, 251, 0.68)',
            },
          }}
        />
        <Tooltip title="Збільшити" enterDelay={300}>
          <span>
            <IconButton
              aria-label="Збільшити"
              size="small"
              onClick={() => setPreviewZoom(zoom + ZOOM_STEP)}
              disabled={zoom >= ZOOM_MAX}
              sx={{ color: 'inherit' }}
            >
              <ZoomInIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Stack direction="row" justifyContent="flex-end" sx={{ justifySelf: 'end' }}>
        <Button onClick={closeDialog}>
          Закрити
        </Button>
      </Stack>
    </DialogActions>
    </Dialog>
  );
}
