import { Box, DialogContent, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useLayoutEffect, useState, type ReactNode } from 'react';

import { getAttachmentPreviewStageBg } from './message-card-attachment-preview';
import type { MessageCardPreviewNavigation } from './message-card-preview.types';
import {
  AttachmentPreviewMobileCarouselIsland,
  AttachmentPreviewMobileCarouselNav,
} from './MessageCardAttachmentPreviewControls';
import { useAttachmentPreviewSwipe } from './useAttachmentPreviewSwipe';
import {
  AttachmentPreviewMobileSurfaceContext,
  useAttachmentPreviewMobileChrome,
} from './use-attachment-preview-mobile-chrome';
import {
  MESSAGE_CARD_PREVIEW_MOBILE_ISLAND_HEIGHT_PX,
  MESSAGE_CARD_PREVIEW_MOBILE_ISLAND_BOTTOM_PX,
  MESSAGE_CARD_PREVIEW_MOBILE_ISLAND_CONTROLS_BOTTOM_PX,
} from './message-card-preview-config';

const MOBILE_PREVIEW_SX = {
  '& [data-attachment-preview-header-navigation]': { display: 'none' },
  '& [data-attachment-preview-carousel-island]': { display: 'flex' },
  '--attachment-preview-table-border-collapse': 'separate',
  '& .leaflet-top': { top: 'var(--attachment-preview-header-height, 0px)' },
  '& [data-map-preview-points]': { minHeight: 0 },
  '& [data-attachment-preview-sheet-tabs]': {
    flexWrap: 'nowrap',
    overflowX: 'auto',
    flexShrink: 0,
    pb: 'calc(8px + env(safe-area-inset-bottom, 0px))',
    '& button': { flexShrink: 0, whiteSpace: 'nowrap' },
  },
  '& [data-ocr-scroll-container], & [data-attachment-preview-report-pane]': {
    pb: 'var(--attachment-preview-content-bottom-inset)',
  },
  '&::after': {
    content: '""',
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 'env(safe-area-inset-bottom, 0px)',
    backgroundColor: getAttachmentPreviewStageBg,
    zIndex: 1300,
    pointerEvents: 'none',
  },
} as const;

export function MessageCardAttachmentPreviewLayout({
  stage,
  header,
  controls,
  infoPopover,
  navigation,
  swipeEnabled = true,
  onSwipeDismiss,
  immersive = false,
  safeArea = false,
  headerVisible = true,
  overlayHeader = false,
  mobileChrome,
  carouselAboveControls = false,
  headerInFlow = false,
}: {
  stage: ReactNode;
  header?: ReactNode;
  controls?: ReactNode;
  infoPopover?: ReactNode;
  navigation?: MessageCardPreviewNavigation;
  swipeEnabled?: boolean;
  onSwipeDismiss?: () => void;
  immersive?: boolean;
  safeArea?: boolean;
  headerVisible?: boolean;
  overlayHeader?: boolean;
  mobileChrome?: 'toggle' | 'fixed';
  carouselAboveControls?: boolean;
  headerInFlow?: boolean;
}) {
  const [stageContainerEl, setStageContainerEl] = useState<HTMLDivElement | null>(null);
  const [headerEl, setHeaderEl] = useState<HTMLDivElement | null>(null);
  const narrowViewport = useMediaQuery(useTheme().breakpoints.down('sm'));
  const touchLandscape = useMediaQuery('(pointer: coarse) and (max-height: 599.95px)');
  const mobileChromeEnabled = mobileChrome != null && (narrowViewport || touchLandscape);
  const toggleMobileChrome = mobileChromeEnabled && mobileChrome === 'toggle';
  const chrome = useAttachmentPreviewMobileChrome(toggleMobileChrome, navigation?.index);
  const resolvedHeaderVisible = headerVisible && (!toggleMobileChrome || chrome.visible);
  const resolvedOverlayHeader = overlayHeader || (toggleMobileChrome && !headerInFlow);
  const carouselBottom =
    controls || carouselAboveControls
      ? MESSAGE_CARD_PREVIEW_MOBILE_ISLAND_CONTROLS_BOTTOM_PX
      : MESSAGE_CARD_PREVIEW_MOBILE_ISLAND_BOTTOM_PX;

  useLayoutEffect(() => {
    if (!resolvedOverlayHeader || headerEl === null) return;
    const container = headerEl.parentElement!;
    const measure = () => {
      container.style.setProperty(
        '--attachment-preview-header-height',
        `${headerEl.getBoundingClientRect().height}px`,
      );
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(headerEl);
    return () => {
      observer?.disconnect();
      container.style.removeProperty('--attachment-preview-header-height');
    };
  }, [headerEl, resolvedOverlayHeader]);

  const swipeMotion = useAttachmentPreviewSwipe({
    stageEl: stageContainerEl,
    navigation,
    enabled: swipeEnabled,
    onDismiss: onSwipeDismiss,
  });

  return (
    <>
      <DialogContent
        data-attachment-preview-mobile-chrome={mobileChromeEnabled ? 'true' : undefined}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          p: 0,
          gap: 0,
          minHeight: 0,
          height: 0,
          flex: '1 1 0',
          overflow: 'hidden',
          position: 'relative',
          backgroundColor: getAttachmentPreviewStageBg,
          ...(mobileChromeEnabled
            ? {
                ...MOBILE_PREVIEW_SX,
                '--attachment-preview-content-inset':
                  toggleMobileChrome && !headerInFlow
                    ? 'var(--attachment-preview-header-height, 0px)'
                    : undefined,
                '--attachment-preview-content-bottom-inset': `max(var(--attachment-preview-content-inset, 0px), calc(${carouselBottom + MESSAGE_CARD_PREVIEW_MOBILE_ISLAND_HEIGHT_PX}px + env(safe-area-inset-bottom, 0px)))`,
                '--attachment-preview-sticky-inset': resolvedHeaderVisible
                  ? 'var(--attachment-preview-header-height, 0px)'
                  : '0px',
              }
            : {}),
        }}
      >
        {(safeArea || mobileChromeEnabled) && header ? (
          <Box
            ref={setHeaderEl}
            sx={{
              position: resolvedOverlayHeader ? 'absolute' : 'relative',
              display: resolvedOverlayHeader || resolvedHeaderVisible ? 'block' : 'none',
              visibility: resolvedHeaderVisible ? 'visible' : 'hidden',
              top: 0,
              left: 0,
              right: 0,
              zIndex: 1400,
              flexShrink: 0,
              backgroundColor: 'background.paper',
              pt: 'env(safe-area-inset-top, 0px)',
              pl: 'env(safe-area-inset-left, 0px)',
              pr: 'env(safe-area-inset-right, 0px)',
            }}
          >
            {header}
          </Box>
        ) : (
          (header ?? null)
        )}
        <Box
          ref={setStageContainerEl}
          sx={{
            flex: '1 1 0',
            height: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            borderRadius: 0,
            overflow: 'hidden',
            backgroundColor: getAttachmentPreviewStageBg,
          }}
        >
          <Box
            data-attachment-preview-swipe-content
            {...chrome.surfaceProps}
            sx={{
              flex: '1 1 0',
              height: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              transform: swipeMotion.transform,
              opacity: swipeMotion.opacity,
              transition: swipeMotion.transition,
              willChange: 'transform, opacity',
            }}
          >
            <AttachmentPreviewMobileSurfaceContext.Provider
              value={toggleMobileChrome ? chrome.surfaceProps : null}
            >
              {stage}
            </AttachmentPreviewMobileSurfaceContext.Provider>
          </Box>
          {/* Controls Overlay (part of content stage area, above the divider) */}
          {controls ? (
            <Box
              sx={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                zIndex: 1300,
                width: '100%',
                visibility: mobileChromeEnabled && !resolvedHeaderVisible ? 'hidden' : undefined,
                pointerEvents: 'none',
                '& > *': {
                  pointerEvents: 'auto',
                  ...(mobileChromeEnabled
                    ? {
                        bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
                        left: 'max(16px, env(safe-area-inset-left, 0px))',
                      }
                    : {}),
                },
              }}
            >
              {controls}
            </Box>
          ) : null}
          {mobileChromeEnabled && navigation ? (
            <AttachmentPreviewMobileCarouselIsland
              navigation={navigation}
              visible={resolvedHeaderVisible}
              bottom={`calc(${carouselBottom}px + env(safe-area-inset-bottom, 0px))`}
            />
          ) : null}
        </Box>

        {/* Mobile Bottom Bar (Under the divider line, containing ONLY carousel controls) */}
        {!immersive && !mobileChromeEnabled && navigation && navigation.count > 1 ? (
          <Box
            sx={{
              display: { xs: 'flex', sm: 'none' },
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(18, 18, 18, 0.95)',
              backdropFilter: 'blur(12px)',
              borderTop: 1,
              borderColor: 'divider',
              color: '#fff',
              zIndex: 1300,
              flexShrink: 0,
              width: '100%',
              py: 0.75,
              px: 1.5,
            }}
          >
            <AttachmentPreviewMobileCarouselNav navigation={navigation} />
          </Box>
        ) : null}
      </DialogContent>
      {infoPopover ?? null}
    </>
  );
}
