import { useMemo, useState } from 'react';
import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import { Box, ButtonBase, ImageList, ImageListItem, Skeleton, Typography, useMediaQuery, useTheme } from '@mui/material';

import type { MessageCardImage } from './message-card-image-utils';

const IMAGE_LIST_GAP_PX = 8;
const IMAGE_LIST_ONE_HEIGHT_PX = 256;
const IMAGE_LIST_MULTI_HEIGHT_PX = 336;
const IMAGE_LIST_ITEM_HEIGHT_PX = 160;
const IMAGE_LIST_ITEM_HEIGHT_COMPACT_PX = 144;

function getImageListColumns(imageCount: number, compact: boolean): number {
  if (imageCount <= 1) return 1;
  if (imageCount === 2) return 2;
  return compact ? 2 : 3;
}

function getImageListHeight(imageCount: number): number {
  if (imageCount <= 1) return IMAGE_LIST_ONE_HEIGHT_PX;
  if (imageCount === 2) return IMAGE_LIST_MULTI_HEIGHT_PX;
  return 2 * IMAGE_LIST_ITEM_HEIGHT_PX + IMAGE_LIST_GAP_PX;
}

function getImageItemHeight(imageCount: number, compact: boolean): number {
  if (imageCount <= 1) return IMAGE_LIST_ONE_HEIGHT_PX - 24;
  return compact ? IMAGE_LIST_ITEM_HEIGHT_COMPACT_PX : IMAGE_LIST_ITEM_HEIGHT_PX;
}

function MessageCardImageThumb({
  image,
  index,
  itemHeight,
  onOpen,
}: {
  image: MessageCardImage;
  index: number;
  itemHeight: number;
  onOpen: (index: number) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const canOpen = image.href.trim() !== '';

  return (
    <ImageListItem
      sx={{
        width: '100%',
        minWidth: 0,
        height: `${itemHeight}px !important`,
        overflow: 'hidden',
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: 'divider',
        backgroundColor: 'action.hover',
      }}
    >
      <ButtonBase
        component="button"
        type="button"
        onClick={canOpen ? () => onOpen(index) : undefined}
        disabled={!canOpen}
        aria-label="Відкрити зображення"
        data-picture-thumb-state={failed ? 'failed' : loaded ? 'loaded' : 'loading'}
        data-picture-thumb-error-height-px={failed ? 36 : undefined}
        sx={{
          display: 'flex',
          width: '100%',
          height: '100%',
          alignItems: 'stretch',
          justifyContent: 'stretch',
          textAlign: 'left',
          cursor: canOpen ? 'pointer' : 'default',
          color: 'inherit',
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
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            backgroundColor: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <Box
            component="img"
            src={image.href}
            alt="Зображення повідомлення"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            sx={{
              display: 'block',
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: loaded && !failed ? 1 : 0,
              transition: 'opacity 120ms ease-out',
            }}
          />
          {!loaded || failed ? (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0.5,
                px: 1,
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
    </ImageListItem>
  );
}

export function MessageCardImageList({
  images,
  onOpen,
}: {
  images: MessageCardImage[];
  onOpen: (index: number) => void;
}) {
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down('sm'));
  const imageCount = images.length;
  const cols = useMemo(() => getImageListColumns(imageCount, compact), [compact, imageCount]);
  const itemHeight = useMemo(() => getImageItemHeight(imageCount, compact), [compact, imageCount]);
  const maxHeight = useMemo(() => getImageListHeight(imageCount), [imageCount]);

  if (imageCount === 0) return null;

  return (
    <Box className="m-1" sx={{ maxWidth: '100%' }}>
      <ImageList
        cols={cols}
        rowHeight={itemHeight}
        gap={IMAGE_LIST_GAP_PX}
        sx={{
          m: 0,
          width: '100%',
          maxHeight: `${maxHeight}px`,
          overflowY: imageCount > 3 ? 'auto' : 'hidden',
          overflowX: 'hidden',
        }}
      >
        {images.map((image, index) => (
          <MessageCardImageThumb key={`${image.href}-${index}`} image={image} index={index} itemHeight={itemHeight} onOpen={onOpen} />
        ))}
      </ImageList>
    </Box>
  );
}
