import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import { Box, DialogContent, IconButton, Tooltip } from '@mui/material';
import type { ReactNode } from 'react';

import { getAttachmentPreviewStageBg } from './message-card-attachment-preview';
import type { MessageCardAttachmentPreviewConfig } from './message-card-preview-config';

export function MessageCardAttachmentPreviewLayout({
  isFullscreen,
  config,
  stage,
  controls,
  actions,
  infoPopover,
  onToggleFullscreen,
}: {
  isFullscreen: boolean;
  config: MessageCardAttachmentPreviewConfig;
  stage: ReactNode;
  controls?: ReactNode;
  actions?: ReactNode;
  infoPopover?: ReactNode;
  onToggleFullscreen?: () => void;
}) {
  const isMediaLayout = config.layout === 'media';
  const canFullscreen = config.supportsFullscreen;

  return (
    <>
      <DialogContent
        sx={{
          display: 'flex',
          flexDirection: 'column',
          p: 0,
          gap: 0,
          minHeight: 0,
          flex: '1 1 auto',
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            borderRadius: 0,
            overflow: 'hidden',
            backgroundColor: (theme) => getAttachmentPreviewStageBg(theme, isMediaLayout),
            border: isFullscreen || isMediaLayout ? 'none' : 1,
            borderColor: 'divider',
          }}
        >
          {stage}
          {canFullscreen && onToggleFullscreen ? (
            <Tooltip
              title={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
              enterDelay={300}
            >
              <IconButton
                aria-label={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
                size="small"
                onClick={onToggleFullscreen}
                sx={{
                  position: 'absolute',
                  top: 16,
                  right: 16,
                  zIndex: 1300,
                  backgroundColor: 'rgba(18, 18, 18, 0.75)',
                  backdropFilter: 'blur(12px)',
                  boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25)',
                  color: 'rgba(255, 255, 255, 0.85)',
                  borderRadius: 2,
                  p: 0.75,
                  '&:hover': {
                    backgroundColor: 'rgba(18, 18, 18, 0.9)',
                    color: '#fff',
                  },
                }}
              >
                {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
              </IconButton>
            </Tooltip>
          ) : null}
          {controls ? (
            <Box
              sx={{
                position: 'absolute',
                bottom: 16,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 1300,
                display: 'flex',
                justifyContent: 'center',
                width: 'auto',
                maxWidth: 'calc(100% - 32px)',
                pointerEvents: 'auto',
              }}
            >
              <Box sx={{ width: '100%', maxWidth: 800 }}>{controls}</Box>
            </Box>
          ) : null}
        </Box>
      </DialogContent>
      {infoPopover ?? null}
      {actions ?? null}
    </>
  );
}
