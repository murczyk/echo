import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { IconButton } from '@mui/material';

import type { MessageCardPreviewNavigation } from './message-card-preview.types';

export type AttachmentPreviewStageNavigationSide = 'prev' | 'next' | null;

export function AttachmentPreviewStageCarouselNav({
  navigation,
  visibleSide,
}: {
  navigation: MessageCardPreviewNavigation;
  visibleSide: AttachmentPreviewStageNavigationSide;
}) {
  if (navigation.count <= 1) return null;

  const buttonSx = (side: Exclude<AttachmentPreviewStageNavigationSide, null>) => {
    const visible = visibleSide === side;
    return {
      position: 'absolute',
      top: '50%',
      zIndex: 1250,
      [side === 'prev' ? 'left' : 'right']: { xs: 1, sm: 2, md: 3 },
      display: 'none',
      width: 48,
      height: 48,
      color: '#fff',
      backgroundColor: 'rgba(18, 18, 18, 0.58)',
      boxShadow: '0 2px 12px rgba(0, 0, 0, 0.35)',
      opacity: visible ? 1 : 0,
      visibility: visible ? 'visible' : 'hidden',
      pointerEvents: visible ? 'auto' : 'none',
      transform: `translate(${visible ? 0 : side === 'prev' ? -8 : 8}px, -50%)`,
      transition: 'opacity 150ms ease, transform 150ms ease, visibility 150ms ease',
      '&:hover': { backgroundColor: 'rgba(18, 18, 18, 0.78)' },
      '&.Mui-disabled': { color: 'rgba(255, 255, 255, 0.45)' },
      '@media (min-width: 600px) and (hover: hover) and (pointer: fine)': {
        display: 'inline-flex',
      },
    };
  };

  return (
    <>
      <IconButton
        aria-label="Попереднє"
        onClick={navigation.onPrevious}
        disabled={navigation.disabled}
        sx={buttonSx('prev')}
        data-attachment-preview-stage-nav="prev"
      >
        <ChevronLeftIcon fontSize="large" />
      </IconButton>
      <IconButton
        aria-label="Наступне"
        onClick={navigation.onNext}
        disabled={navigation.disabled}
        sx={buttonSx('next')}
        data-attachment-preview-stage-nav="next"
      >
        <ChevronRightIcon fontSize="large" />
      </IconButton>
    </>
  );
}
