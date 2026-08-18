import { useState } from 'react';
import type { MouseEvent } from 'react';
import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import { Box, ButtonBase, Skeleton, Typography } from '@mui/material';

import type { MessageCardImage } from './message-card-image-utils';
import { blurActiveElement } from '../../../utils/focus';

type PreviewVariant = 'single' | 'multi';

export function MessageCardImageThumb({
  image,
  index,
  variant,
  compact = false,
  selected = false,
  onOpen,
}: {
  image: MessageCardImage;
  index: number;
  variant: PreviewVariant;
  compact?: boolean;
  selected?: boolean;
  onOpen: (index: number) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const canOpen = image.href.trim() !== '';

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
      aria-current={selected ? 'true' : undefined}
      data-summary-selected={selected ? 'true' : undefined}
      data-picture-thumb-state={failed ? 'failed' : loaded ? 'loaded' : 'loading'}
      data-picture-thumb-layout={variant}
      sx={{
        display: 'inline-flex',
        maxWidth: 150,
        height: 150,
        minWidth: 85,
        alignSelf: 'flex-start',
        textAlign: 'left',
        cursor: canOpen ? 'pointer' : 'default',
        color: 'inherit',
        borderRadius: 1.5,
        overflow: 'hidden',
        border: '1px solid',
        borderColor: selected ? 'primary.light' : 'divider',
        backgroundColor: selected ? 'action.selected' : 'action.hover',
        boxShadow: selected ? 1 : 0,
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
          width: '100%',
          height: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {!loaded && !failed && (
          <Skeleton
            variant="rectangular"
            animation="wave"
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              zIndex: 0,
            }}
          />
        )}
        <Box
          component="img"
          src={image.href}
          alt="Зображення повідомлення"
          onLoad={() => {
            setLoaded(true);
            setFailed(false);
          }}
          onError={() => {
            setFailed(true);
            setLoaded(false);
          }}
          {...imageLoadingProps}
          sx={{
            display: 'block',
            maxWidth: 150,
            height: 150,
            width: 'auto',
            objectFit: 'cover',
            opacity: showImage ? 1 : 0,
            transition: 'opacity 120ms ease-out',
            pointerEvents: 'none',
          }}
        />
        {failed ? (
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
              color: 'text.secondary',
            }}
          >
            <BrokenImageOutlinedIcon aria-hidden />
            <Typography variant="caption" component="span" sx={{ textAlign: 'center' }}>
              Зображення недоступне
            </Typography>
          </Box>
        ) : null}
      </Box>
      <span className="sr-only">Зображення {index + 1}</span>
    </ButtonBase>
  );
}
