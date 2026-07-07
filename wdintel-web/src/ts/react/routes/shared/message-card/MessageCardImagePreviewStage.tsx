import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react';
import { forwardRef } from 'react';
import { Box, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import type { MessageCardImage } from './message-card-image-utils';
import { ZOOM_MIN } from './message-card-image-preview-utils';
import { getMessageCardPreviewStageSx } from './message-card-preview-shell';

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
    onImageLoad: (image: HTMLImageElement) => void;
    onImageError: () => void;
    onStartPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onStopPan: (event: ReactPointerEvent<HTMLDivElement>) => void;
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
    onExitFullscreen,
  },
  ref,
) {
  const theme = useTheme();
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
        backgroundImage: stageBackground,
        ...getMessageCardPreviewStageSx(theme, isFullscreen),
        backgroundRepeat: 'no-repeat',
        backgroundSize: 'cover',
        cursor: zoom > ZOOM_MIN ? 'grab' : 'default',
        userSelect: 'none',
      }}
    >
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
        onLoad={(event: SyntheticEvent<HTMLImageElement>) => onImageLoad(event.currentTarget)}
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
        <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center' }}>
          Зображення недоступне
        </Typography>
      ) : null}
    </Box>
  );
});
