import { Dialog, DialogContent, Box } from '@mui/material';
import type { ReactNode } from 'react';

import { getMessageCardPreviewDialogPaperSx } from './message-card-preview-shell';
import type { MessageCardPreviewShellConfig } from './message-card-preview-config';

export function MessageCardPreviewShell({
  open,
  isFullscreen,
  ariaLabel,
  onClose,
  config,
  stage,
  controls,
  actions,
  infoPopover,
}: {
  open: boolean;
  isFullscreen: boolean;
  ariaLabel: string;
  onClose: (event: unknown, reason: 'backdropClick' | 'escapeKeyDown') => void;
  config: MessageCardPreviewShellConfig;
  stage: ReactNode;
  controls?: ReactNode;
  actions?: ReactNode;
  infoPopover?: ReactNode;
}) {
  const paperSx: Record<string, unknown> =
    config.layout === 'media'
      ? {
          display: 'flex',
          flexDirection: 'column',
          width: isFullscreen ? '100vw' : { xs: '96vw', sm: '92vw' },
          height: isFullscreen ? '100svh' : '92svh',
          maxWidth: isFullscreen ? '100vw' : 'min(92vw, 1280px)',
          maxHeight: isFullscreen ? '100svh' : '92svh',
          m: 0,
        }
      : {
          width: isFullscreen ? '100vw' : '92vw',
          height: isFullscreen ? '100vh' : '92svh',
          maxWidth: isFullscreen ? '100vw' : '92vw',
          maxHeight: isFullscreen ? '100vh' : '92svh',
          margin: 0,
        };

  return (
    <Dialog
      open={open}
      onClose={(event, reason) => {
        onClose(event, reason);
      }}
      maxWidth={false}
      fullScreen={isFullscreen}
      disableEscapeKeyDown={isFullscreen && config.disableEscapeKeyDownInFullscreen}
      disableRestoreFocus={config.disableRestoreFocus}
      PaperProps={{
        'aria-label': ariaLabel,
        sx: {
          ...getMessageCardPreviewDialogPaperSx(isFullscreen),
          ...paperSx,
        },
      }}
      BackdropProps={{
        sx: { backgroundColor: 'rgba(0, 0, 0, 0.8)' },
      }}
    >
      <DialogContent
        sx={{
          display: 'flex',
          flexDirection: 'column',
          px: isFullscreen ? 0 : 2,
          pt: isFullscreen ? 0 : 2,
          pb: 0,
          gap: 0,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: isFullscreen ? 0 : 1.5,
            overflow: 'hidden',
            backgroundColor: 'background.paper',
            border: isFullscreen ? 'none' : 1,
            borderColor: 'divider',
          }}
        >
          {stage}
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              width: '100%',
            }}
          >
            <Box sx={{ width: '100%', maxWidth: 800 }}>{controls ?? null}</Box>
          </Box>
        </Box>
      </DialogContent>
      {infoPopover ?? null}
      {actions ?? null}
    </Dialog>
  );
}
