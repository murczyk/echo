import { Box, DialogContent } from '@mui/material';
import type { ReactNode } from 'react';

import { getAttachmentPreviewStageBg } from './message-card-attachment-preview';
import type { MessageCardAttachmentPreviewConfig } from './message-card-preview-config';

export function MessageCardAttachmentPreviewLayout({
  config,
  stage,
  header,
  controls,
  infoPopover,
}: {
  isFullscreen: boolean;
  config: MessageCardAttachmentPreviewConfig;
  stage: ReactNode;
  header?: ReactNode;
  controls?: ReactNode;
  infoPopover?: ReactNode;
  actions?: ReactNode;
  onToggleFullscreen?: () => void;
}) {
  const isMediaLayout = config.layout === 'media';

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
          backgroundColor: (theme) => getAttachmentPreviewStageBg(theme, isMediaLayout),
        }}
      >
        {header ?? null}
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
          }}
        >
          {stage}
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
      </DialogContent>
      {infoPopover ?? null}
    </>
  );
}
