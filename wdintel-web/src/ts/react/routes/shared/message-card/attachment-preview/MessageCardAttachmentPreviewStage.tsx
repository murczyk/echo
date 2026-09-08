import { Box } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  forwardRef,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from 'react';

import { getAttachmentPreviewStageSx } from './message-card-attachment-preview';

export const MessageCardAttachmentPreviewStage = forwardRef<
  HTMLDivElement,
  {
    kind: 'image' | 'video' | 'audio' | 'document';
    children: ReactNode;
    cursor?: 'default' | 'grab';
    onPointerDown?: PointerEventHandler<HTMLDivElement>;
    onPointerUp?: PointerEventHandler<HTMLDivElement>;
    onPointerLeave?: PointerEventHandler<HTMLDivElement>;
    onDoubleClick?: MouseEventHandler<HTMLDivElement>;
  }
>(function MessageCardAttachmentPreviewStage(
  { kind, children, cursor = 'default', onPointerDown, onPointerUp, onPointerLeave, onDoubleClick },
  ref,
) {
  const theme = useTheme();
  const isDocument = kind === 'document';
  const isScrollable = isDocument || kind === 'audio';

  return (
    <Box
      ref={ref}
      data-attachment-preview-stage={kind}
      data-image-preview-stage={kind === 'image' ? '' : undefined}
      data-document-preview-stage={isDocument ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onDoubleClick}
      sx={{
        flex: '1 1 auto',
        position: 'relative',
        display: 'flex',
        flexDirection: isScrollable ? 'column' : 'row',
        alignItems: isScrollable ? 'stretch' : 'center',
        justifyContent: isScrollable ? 'flex-start' : 'center',
        minHeight: 0,
        overflow: isScrollable ? 'auto' : 'hidden',
        borderRadius: 0,
        ...getAttachmentPreviewStageSx(),
        color: isScrollable ? theme.palette.text.primary : undefined,
        cursor,
        userSelect: kind === 'image' ? 'none' : undefined,
      }}
    >
      {children}
    </Box>
  );
});
