import type { SyntheticEvent } from 'react';
import { Box, Typography } from '@mui/material';
import type { Point } from '../message-card-image-utils';
import { ZOOM_MIN } from '../message-card-image-preview-utils';

export function ImageFilePreview({
  sizeBytes,
  href,
  carouselIndex,
  previewFileName,
  zoom,
  pan,
  failedHref,
  imageSize,
  onLoad,
  onError,
  onSurfaceTap,
  insetForControls = false,
}: {
  sizeBytes: number | null;
  href: string;
  carouselIndex: number;
  previewFileName: string;
  zoom: number;
  pan: Point;
  failedHref: string | null;
  imageSize: { width: number; height: number } | null;
  onLoad: (image: HTMLImageElement) => void;
  onError: () => void;
  onSurfaceTap?: () => void;
  insetForControls?: boolean;
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
        role={onSurfaceTap ? 'button' : undefined}
        tabIndex={onSurfaceTap ? 0 : undefined}
        aria-label={onSurfaceTap ? 'Показати або приховати панелі зображення' : undefined}
        onKeyDown={(event) => {
          if (!onSurfaceTap || event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          event.stopPropagation();
          onSurfaceTap();
        }}
        data-image-preview-image
        data-image-preview-zoom={zoom}
        data-image-preview-pan-x={pan.x}
        data-image-preview-pan-y={pan.y}
        data-image-preview-file-name={previewFileName}
        data-image-preview-size-bytes={sizeBytes ?? ''}
        data-image-preview-natural-width={imageSize?.width ?? ''}
        data-image-preview-natural-height={imageSize?.height ?? ''}
        draggable={false}
        onLoad={(event: SyntheticEvent<HTMLImageElement>) => onLoad(event.currentTarget)}
        onError={onError}
        decoding="async"
        sx={{
          display: failedHref === href ? 'none' : 'block',
          maxWidth: '100%',
          maxHeight: insetForControls
            ? 'max(1px, calc(100% - 2 * var(--attachment-preview-header-height, 0px)))'
            : '100%',
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
