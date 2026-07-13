import { Dialog, DialogContent, Box } from '@mui/material';
import type { ReactNode } from 'react';

import { getMessageCardPreviewDialogPaperSx } from './message-card-preview-shell';

export function MessageCardPreviewShell({
  open,
  isFullscreen,
  ariaLabel,
  onClose,
  stage,
  controls,
  actions,
  infoPopover,
}: {
  open: boolean;
  isFullscreen: boolean;
  ariaLabel: string;
  onClose: (event: unknown, reason: 'backdropClick' | 'escapeKeyDown') => void;
  stage: ReactNode;
  controls?: ReactNode;
  actions?: ReactNode;
  infoPopover?: ReactNode;
}) {
  const dialogWidth = isFullscreen ? '100vw' : '92vw';
  const dialogHeight = isFullscreen ? '100vh' : '92svh';

  return (
    <Dialog
      open={open}
      onClose={(event, reason) => {
        onClose(event, reason);
      }}
      maxWidth={false}
      fullScreen={isFullscreen}
      disableRestoreFocus
      aria-label={ariaLabel}
      PaperProps={{
        sx: {
          width: dialogWidth,
          height: dialogHeight,
          maxWidth: dialogWidth,
          maxHeight: dialogHeight,
          margin: 0,
          ...getMessageCardPreviewDialogPaperSx(isFullscreen),
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
