import { useMemo, useState } from 'react';
import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import { Box, ButtonBase, Skeleton, Typography, useMediaQuery, useTheme } from '@mui/material';

import type { MessageCardImage } from './message-card-image-utils';

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
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [naturalSize, setNaturalSize] = useState<Size | null>(null);
  const canOpen = image.href.trim() !== '';
  const renderedSize = naturalSize != null ? fitContainedSize(naturalSize, thumbLimits) : {
    width: thumbLimits.placeholderWidth,
    height: thumbLimits.placeholderHeight,
  };
  const showImage = loaded && !failed;

  return (
    <ButtonBase
      component="button"
      type="button"
      onClick={canOpen ? () => onOpen(index) : undefined}
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
            if (target.naturalWidth > 0 && target.naturalHeight > 0) {
              setNaturalSize({ width: target.naturalWidth, height: target.naturalHeight });
            }
            setLoaded(true);
          }}
          onError={() => setFailed(true)}
          sx={{
            display: showImage ? 'block' : 'none',
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            transition: 'opacity 120ms ease-out',
          }}
        />
        {!loaded || failed ? (
          <Box
            sx={{
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
