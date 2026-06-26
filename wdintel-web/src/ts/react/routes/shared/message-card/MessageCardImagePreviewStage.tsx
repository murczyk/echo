import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react';
import { forwardRef } from 'react';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';

import type { MessageCardImage } from './message-card-image-utils';
import { ZOOM_MIN } from './message-card-image-preview-utils';

type StageSize = {
  width: number;
  height: number;
};

export const MessageCardImagePreviewStage = forwardRef<
  HTMLDivElement,
  {
    currentImage: MessageCardImage;
    currentHref: string;
    imageCount: number;
    resolvedIndex: number;
    previewFileName: string;
    zoom: number;
    pan: { x: number; y: number };
    failedHref: string | null;
    imageSize: StageSize | null;
    stageBackground: string;
    isFullscreen: boolean;
    onImageLoad: (event: SyntheticEvent<HTMLImageElement>) => void;
    onImageError: () => void;
    onStartPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onStopPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onGoToPrevious: () => void;
    onGoToNext: () => void;
    onExitFullscreen: () => void;
  }
>(function MessageCardImagePreviewStage(
  {
    currentImage,
    currentHref,
    imageCount,
    resolvedIndex,
    previewFileName,
    zoom,
    pan,
    failedHref,
    imageSize,
    stageBackground,
    isFullscreen,
    onImageLoad,
    onImageError,
    onStartPan,
    onStopPan,
    onGoToPrevious,
    onGoToNext,
    onExitFullscreen,
  },
  ref,
) {
  const hasCarousel = imageCount > 1;
  const imageTransform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`;

  return (
    <Box
      data-image-preview-stage
      ref={ref}
      onPointerDown={onStartPan}
      onPointerUp={onStopPan}
      onPointerLeave={onStopPan}
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
            onClick={onExitFullscreen}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
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
        onLoad={onImageLoad}
        onError={onImageError}
        decoding="async"
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
                  onGoToPrevious();
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
                  onGoToNext();
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
  );
});
