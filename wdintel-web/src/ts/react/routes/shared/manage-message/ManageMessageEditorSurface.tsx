import { Drawer, Paper, useMediaQuery } from '@mui/material';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';

export const MANAGE_MESSAGE_EDITOR_MIN_WIDTH = 1024;
export const MANAGE_MESSAGE_EDITOR_WIDTH = 'clamp(440px, 40vw, 640px)';
export const MANAGE_MESSAGE_EDITOR_GAP = 16;

export type ManageMessageEditorPresentation = 'modal' | 'embedded';

type ManageMessageEditorSurfaceProps = {
  children: ReactNode;
  dismissDisabled: boolean;
  onRequestClose: () => void;
  open: boolean;
  presentation: ManageMessageEditorPresentation;
  titleId: string;
  fillEmbeddedSurface?: boolean;
  transparentEmbeddedSurface?: boolean;
};

export function useManageMessageEditorPresentation(): ManageMessageEditorPresentation {
  return useMediaQuery(`(min-width:${MANAGE_MESSAGE_EDITOR_MIN_WIDTH}px)`) ? 'embedded' : 'modal';
}

export function ManageMessageEditorSurface({
  children,
  dismissDisabled,
  onRequestClose,
  open,
  presentation,
  titleId,
  fillEmbeddedSurface = false,
  transparentEmbeddedSurface = false,
}: ManageMessageEditorSurfaceProps) {
  const embeddedSurfaceRef = useRef<HTMLElement | null>(null);
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  useEffect(() => {
    if (presentation !== 'embedded' || !open || dismissDisabled) return;
    const handleEscape = (event: KeyboardEvent) => {
      const surface = embeddedSurfaceRef.current;
      if (
        event.defaultPrevented ||
        event.key !== 'Escape' ||
        !surface?.contains(document.activeElement)
      ) {
        return;
      }
      event.preventDefault();
      onRequestClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [dismissDisabled, onRequestClose, open, presentation]);

  if (presentation === 'modal') {
    return (
      <Drawer
        anchor="right"
        data-manage-message-presentation="modal"
        open={open}
        onClose={dismissDisabled ? undefined : onRequestClose}
        sx={{ zIndex: 1200 }}
        ModalProps={{
          closeAfterTransition: true,
          BackdropProps: {
            sx: (theme) => pageDrawerBackdropSx(theme),
          },
        }}
        slotProps={{
          paper: {
            style: { width: '100vw', maxWidth: '100vw' },
            sx: {
              display: 'flex',
              backgroundColor: 'background.default',
              backgroundImage: 'none',
            },
          },
        }}
      >
        {children}
      </Drawer>
    );
  }

  if (!open) return null;

  return (
    <Paper
      ref={embeddedSurfaceRef}
      component="aside"
      aria-labelledby={titleId}
      data-manage-message-presentation="embedded"
      elevation={0}
      style={
        {
          '--manage-message-editor-width': MANAGE_MESSAGE_EDITOR_WIDTH,
          width: fillEmbeddedSurface ? '100%' : 'var(--manage-message-editor-width)',
          flex: fillEmbeddedSurface ? '1 1 auto' : '0 0 auto',
          height: '100%',
          marginLeft: transparentEmbeddedSurface ? 0 : `${MANAGE_MESSAGE_EDITOR_GAP}px`,
          backgroundColor: transparentEmbeddedSurface ? 'transparent' : undefined,
          animationName: 'manage-message-editor-enter',
          animationDuration: reduceMotion ? '0s' : '180ms',
          animationTimingFunction: 'cubic-bezier(0.2, 0, 0, 1)',
          animationFillMode: 'both',
        } as CSSProperties
      }
      sx={{
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        borderLeft: transparentEmbeddedSurface ? 'none' : '1px solid',
        borderColor: 'divider',
        backgroundColor: 'background.default',
        backgroundImage: 'none',
        '@keyframes manage-message-editor-enter': {
          from: {
            opacity: 0,
            transform: 'translateX(24px)',
          },
          to: {
            opacity: 1,
            transform: 'translateX(0)',
          },
        },
      }}
    >
      {children}
    </Paper>
  );
}
