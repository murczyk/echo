import { Box, DialogContent } from '@mui/material';
import { useState, type ReactNode } from 'react';

import { getAttachmentPreviewStageBg } from './message-card-attachment-preview';
import type { MessageCardAttachmentPreviewConfig } from './message-card-preview-config';
import type { MessageCardPreviewNavigation } from './message-card-preview.types';
import { AttachmentPreviewMobileCarouselNav } from './MessageCardAttachmentPreviewControls';
import { useAttachmentPreviewSwipe } from './useAttachmentPreviewSwipe';

export function MessageCardAttachmentPreviewLayout({
  config,
  stage,
  header,
  controls,
  infoPopover,
  navigation,
  swipeEnabled = true,
}: {
  isFullscreen: boolean;
  config: MessageCardAttachmentPreviewConfig;
  stage: ReactNode;
  header?: ReactNode;
  controls?: ReactNode;
  infoPopover?: ReactNode;
  actions?: ReactNode;
  onToggleFullscreen?: () => void;
  navigation?: MessageCardPreviewNavigation;
  swipeEnabled?: boolean;
}) {
  const isMediaLayout = config.layout === 'media';
  const [stageContainerEl, setStageContainerEl] = useState<HTMLDivElement | null>(null);

  useAttachmentPreviewSwipe({
    stageEl: stageContainerEl,
    navigation,
    enabled: swipeEnabled,
  });

  return (
    <>
      <DialogContent
        sx={{
          display: 'flex',
          flexDirection: 'column',
          p: 0,
          gap: 0,
          minHeight: 0,
          height: 0,
          flex: '1 1 0',
          overflow: 'hidden',
          backgroundColor: (theme) => getAttachmentPreviewStageBg(theme, isMediaLayout),
        }}
      >
        {header ?? null}
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
            backgroundColor: (theme) => getAttachmentPreviewStageBg(theme, isMediaLayout),
          }}
        >
          {stage}
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
                pointerEvents: 'none',
                '& > *': {
                  pointerEvents: 'auto',
                },
              }}
            >
              {controls}
            </Box>
          ) : null}
        </Box>

        {/* Mobile Bottom Bar (Under the divider line, containing ONLY carousel controls) */}
        {navigation && navigation.count > 1 ? (
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
