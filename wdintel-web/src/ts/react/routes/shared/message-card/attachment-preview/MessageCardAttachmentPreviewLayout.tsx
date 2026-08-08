import { Box, DialogContent } from '@mui/material';
import type { ReactNode } from 'react';

import type { MessageCardAttachmentPreviewConfig } from './message-card-preview-config';

export function MessageCardAttachmentPreviewLayout({
  isFullscreen,
  config,
  stage,
  controls,
  actions,
  infoPopover,
}: {
  isFullscreen: boolean;
  config: MessageCardAttachmentPreviewConfig;
  stage: ReactNode;
  controls?: ReactNode;
  actions?: ReactNode;
  infoPopover?: ReactNode;
}) {
  const isMediaLayout = config.layout === 'media';

  return (
    <>
      <DialogContent
        sx={{
          display: 'flex',
          flexDirection: 'column',
          px: isFullscreen ? 0 : isMediaLayout ? { xs: 0, sm: 2 } : 2,
          pt: isFullscreen ? 0 : isMediaLayout ? { xs: 0, sm: 2 } : 2,
          pb: 0,
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
            borderRadius: isFullscreen ? 0 : isMediaLayout ? { xs: 0, sm: 1.5 } : 1.5,
            overflow: 'hidden',
            backgroundColor: 'background.paper',
            border: isFullscreen || isMediaLayout ? 'none' : 1,
            borderColor: 'divider',
          }}
        >
          {stage}
          <Box sx={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
            <Box sx={{ width: '100%', maxWidth: 800 }}>{controls ?? null}</Box>
          </Box>
        </Box>
      </DialogContent>
      {infoPopover ?? null}
      {actions ?? null}
    </>
  );
}
