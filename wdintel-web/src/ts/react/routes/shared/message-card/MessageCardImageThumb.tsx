import { useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import { Box, ButtonBase, Skeleton, Typography, useMediaQuery, useTheme } from '@mui/material';

import type { MessageCardImage } from './message-card-image-utils';
import { blurActiveElement } from './message-card-focus';

type PreviewVariant = 'single' | 'multi';

type Size = {
  width: number;
  height: number;
};

type ThumbnailLimits = {
  maxWidth: number;
  maxHeight: number;
  placeholderWidth: number;
  placeholderHeight: number;
};

type CachedThumbnailState = {
  naturalSize: Size | null;
};

const THUMBNAIL_CACHE_LIMIT = 500;
const thumbnailStateCache = new Map<string, CachedThumbnailState>();
const thumbnailStateCacheOrder: string[] = [];

function getCachedThumbnailState(href: string): CachedThumbnailState | null {
  return thumbnailStateCache.get(href) ?? null;
}

function cacheThumbnailState(href: string, state: CachedThumbnailState) {
  if (href.trim() === '') return;
  if (thumbnailStateCache.has(href)) {
    thumbnailStateCache.set(href, state);
    return;
  }

  thumbnailStateCache.set(href, state);
  thumbnailStateCacheOrder.push(href);

  while (thumbnailStateCacheOrder.length > THUMBNAIL_CACHE_LIMIT) {
    const oldestHref = thumbnailStateCacheOrder.shift();
    if (oldestHref != null) {
      thumbnailStateCache.delete(oldestHref);
    }
  }
}

function fitContainedSize(naturalSize: Size, limits: ThumbnailLimits): Size {
  const widthScale = limits.maxWidth / naturalSize.width;
  const heightScale = limits.maxHeight / naturalSize.height;
  const scale = Math.min(1, widthScale, heightScale);
  return {
    width: Math.max(1, Math.round(naturalSize.width * scale)),
    height: Math.max(1, Math.round(naturalSize.height * scale)),
  };
}

function getThumbnailLimits(variant: PreviewVariant, compact: boolean): ThumbnailLimits {
  if (variant === 'single') {
    return compact
      ? {
          maxWidth: 260,
          maxHeight: 220,
          placeholderWidth: 220,
          placeholderHeight: 160,
        }
      : {
          maxWidth: 320,
          maxHeight: 240,
          placeholderWidth: 240,
          placeholderHeight: 180,
        };
  }

  return compact
    ? {
        maxWidth: 160,
        maxHeight: 120,
        placeholderWidth: 160,
        placeholderHeight: 120,
      }
    : {
        maxWidth: 200,
        maxHeight: 140,
        placeholderWidth: 200,
        placeholderHeight: 140,
      };
}

export function MessageCardImageThumb({
  image,
  index,
  variant,
  compact = false,
  onOpen,
}: {
  image: MessageCardImage;
  index: number;
  variant: PreviewVariant;
  compact?: boolean;
  onOpen: (index: number) => void;
}) {
  const theme = useTheme();
  const compactViewport = useMediaQuery(theme.breakpoints.down('sm'));
  const thumbLimits = useMemo(() => getThumbnailLimits(variant, compact || compactViewport), [compact, compactViewport, variant]);
  const cachedState = useMemo(() => getCachedThumbnailState(image.href), [image.href]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [naturalSize, setNaturalSize] = useState<Size | null>(cachedState?.naturalSize ?? null);
  const canOpen = image.href.trim() !== '';
  const renderedSize = naturalSize != null ? fitContainedSize(naturalSize, thumbLimits) : {
    width: thumbLimits.placeholderWidth,
    height: thumbLimits.placeholderHeight,
  };
  const showImage = loaded && !failed;
  const imageLoadingProps = {
    loading: 'lazy',
    decoding: 'async',
    fetchpriority: 'low',
  } as const;
  const handleOpenClick = (_event: MouseEvent<HTMLButtonElement>) => {
    blurActiveElement();
    onOpen(index);
  };

  return (
    <ButtonBase
      component="button"
      type="button"
      onClick={canOpen ? handleOpenClick : undefined}
      disabled={!canOpen}
      aria-label="Відкрити зображення"
      data-picture-thumb-state={failed ? 'failed' : loaded ? 'loaded' : 'loading'}
      data-picture-thumb-layout={variant}
      data-picture-thumb-max-width-px={thumbLimits.maxWidth}
      data-picture-thumb-max-height-px={thumbLimits.maxHeight}
      data-picture-thumb-width-px={renderedSize.width}
      data-picture-thumb-height-px={renderedSize.height}
      data-picture-thumb-error-height-px={failed ? thumbLimits.placeholderHeight : undefined}
      sx={{
        display: 'inline-flex',
        width: 'fit-content',
        maxWidth: '100%',
        alignSelf: 'flex-start',
        alignItems: 'stretch',
        justifyContent: 'stretch',
        textAlign: 'left',
        cursor: canOpen ? 'pointer' : 'default',
        color: 'inherit',
        borderRadius: 1.5,
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'divider',
        backgroundColor: 'action.hover',
        '&:disabled': {
          color: 'text.disabled',
        },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: '-2px',
        },
      }}
    >
      <Box
        sx={{
          position: 'relative',
          display: 'flex',
          width: `${renderedSize.width}px`,
          maxWidth: '100%',
          height: `${renderedSize.height}px`,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          backgroundColor: 'rgba(255, 255, 255, 0.02)',
          flex: '0 0 auto',
        }}
      >
        <Box
          component="img"
          src={image.href}
          alt="Зображення повідомлення"
          onLoad={(event) => {
            const target = event.currentTarget;
            let nextNaturalSize = naturalSize;
            if (target.naturalWidth > 0 && target.naturalHeight > 0) {
              nextNaturalSize = { width: target.naturalWidth, height: target.naturalHeight };
              setNaturalSize(nextNaturalSize);
            }
            setLoaded(true);
            setFailed(false);
            cacheThumbnailState(image.href, { naturalSize: nextNaturalSize });
          }}
          onError={() => {
            setFailed(true);
            setLoaded(false);
          }}
          {...imageLoadingProps}
          sx={{
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            opacity: showImage ? 1 : 0,
            transition: 'opacity 120ms ease-out',
            pointerEvents: 'none',
          }}
        />
        {!loaded || failed ? (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 1,
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0.5,
              px: 1.5,
              py: 1,
              color: failed ? 'text.secondary' : 'text.disabled',
            }}
          >
            {failed ? <BrokenImageOutlinedIcon aria-hidden /> : <Skeleton variant="rounded" width="100%" height="100%" />}
            <Typography variant="caption" component="span" sx={{ textAlign: 'center' }}>
              {failed ? 'Зображення недоступне' : 'Зображення'}
            </Typography>
          </Box>
        ) : null}
      </Box>
    </ButtonBase>
  );
}
