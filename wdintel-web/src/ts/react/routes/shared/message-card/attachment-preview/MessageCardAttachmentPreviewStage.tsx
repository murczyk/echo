import { Box } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { forwardRef, type PointerEventHandler, type ReactNode } from 'react';

import { getAttachmentPreviewStageSx } from './message-card-attachment-preview';

export const MessageCardAttachmentPreviewStage = forwardRef<
  HTMLDivElement,
  {
    kind: 'image' | 'video' | 'document';
    isFullscreen: boolean;
    children: ReactNode;
    cursor?: 'default' | 'grab';
    onPointerDown?: PointerEventHandler<HTMLDivElement>;
    onPointerUp?: PointerEventHandler<HTMLDivElement>;
    onPointerLeave?: PointerEventHandler<HTMLDivElement>;
  }
>(function MessageCardAttachmentPreviewStage(
  { kind, isFullscreen, children, cursor = 'default', onPointerDown, onPointerUp, onPointerLeave },
  ref,
) {
  const theme = useTheme();
  const isDocument = kind === 'document';

  return (
    <Box
      ref={ref}
      data-attachment-preview-stage={kind}
      data-image-preview-stage={kind === 'image' ? '' : undefined}
      data-document-preview-stage={isDocument ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      sx={{
        flex: '1 1 auto',
        position: 'relative',
        display: 'flex',
        flexDirection: isDocument ? 'column' : 'row',
        alignItems: isDocument ? 'stretch' : 'center',
        justifyContent: isDocument ? 'flex-start' : 'center',
        minHeight: 0,
        overflow: 'hidden',
        borderRadius: isFullscreen ? 0 : 1.5,
        ...getAttachmentPreviewStageSx(theme, isFullscreen),
        color: isDocument ? theme.palette.text.primary : undefined,
        cursor,
        userSelect: kind === 'image' ? 'none' : undefined,
      }}
    >
      {children}
    </Box>
  );
});
