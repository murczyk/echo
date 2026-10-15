import { Drawer, Paper, useMediaQuery } from '@mui/material';
import { createPortal } from 'react-dom';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';

export const MANAGE_MESSAGE_EDITOR_EMBEDDED_MIN_VIEWPORT_WIDTH = 1024;
export const MANAGE_MESSAGE_EDITOR_WIDTH = 'clamp(440px, 40vw, 640px)';
export const MANAGE_MESSAGE_EDITOR_GAP = 16;
export const MANAGE_MESSAGE_EDITOR_TRANSITION_MS = 180;
export const MANAGE_MESSAGE_EDITOR_TRANSITION_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
const MANAGE_MESSAGE_EDITOR_EXIT_MS = 140;

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

export function resolveManageMessageEditorPresentation(
  viewportWidth: number | null,
): ManageMessageEditorPresentation {
  return viewportWidth != null && viewportWidth >= MANAGE_MESSAGE_EDITOR_EMBEDDED_MIN_VIEWPORT_WIDTH
    ? 'embedded'
    : 'modal';
}

export function useManageMessageEditorPresentation(): ManageMessageEditorPresentation {
  const viewportCanEmbed = useMediaQuery(
    `(min-width:${MANAGE_MESSAGE_EDITOR_EMBEDDED_MIN_VIEWPORT_WIDTH}px)`,
  );
  return viewportCanEmbed ? 'embedded' : 'modal';
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
  const embeddedMountRef = useRef<HTMLDivElement | null>(null);
  const modalMountRef = useRef<HTMLDivElement | null>(null);
  const [editorHost] = useState(() => {
    const host = document.createElement('div');
    host.className = 'flex h-full min-h-0 w-full flex-1';
    return host;
  });
  const [editorHostMounted, setEditorHostMounted] = useState(false);
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [embeddedMounted, setEmbeddedMounted] = useState(presentation === 'embedded' && open);

  useEffect(() => {
    if (presentation !== 'embedded') {
      setEmbeddedMounted(false);
      return;
    }
    if (open) {
      setEmbeddedMounted(true);
      return;
    }
    const timeoutId = window.setTimeout(
      () => setEmbeddedMounted(false),
      reduceMotion ? 0 : MANAGE_MESSAGE_EDITOR_EXIT_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [open, presentation, reduceMotion]);

  useLayoutEffect(() => {
    embeddedSurfaceRef.current?.toggleAttribute('inert', !open);
  }, [embeddedMounted, open]);

  const moveEditorHost = useCallback(() => {
    const mount = presentation === 'modal' ? modalMountRef.current : embeddedMountRef.current;
    if (mount && editorHost.parentElement !== mount) mount.append(editorHost);
    if (mount) setEditorHostMounted(true);
  }, [editorHost, presentation]);

  const setEmbeddedMount = useCallback(
    (element: HTMLDivElement | null) => {
      embeddedMountRef.current = element;
      moveEditorHost();
    },
    [moveEditorHost],
  );

  const setModalMount = useCallback(
    (element: HTMLDivElement | null) => {
      modalMountRef.current = element;
      moveEditorHost();
    },
    [moveEditorHost],
  );

  useLayoutEffect(() => {
    moveEditorHost();
  }, [moveEditorHost]);

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

  return (
    <>
      {presentation === 'modal' ? (
        <Drawer
          anchor="right"
          data-manage-message-presentation="modal"
          open={open}
          onClose={dismissDisabled ? undefined : onRequestClose}
          sx={{ zIndex: 1200 }}
          ModalProps={{
            closeAfterTransition: true,
            disableRestoreFocus: true,
            BackdropProps: {
              sx: (theme) => pageDrawerBackdropSx(theme),
            },
          }}
          slotProps={{
            paper: {
              role: 'dialog',
              'aria-modal': true,
              'aria-labelledby': titleId,
              style: { width: '100vw', maxWidth: '100vw' },
              sx: {
                display: 'flex',
                backgroundColor: 'var(--background-color)',
                backgroundImage: 'none',
              },
            },
          }}
        >
          <div ref={setModalMount} className="flex h-full min-h-0 flex-1" />
        </Drawer>
      ) : null}
      {embeddedMounted || open ? (
        <Paper
          ref={embeddedSurfaceRef}
          component="aside"
          aria-labelledby={titleId}
          aria-hidden={open && presentation === 'embedded' ? undefined : true}
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
              animationName: open ? 'manage-message-editor-enter' : 'manage-message-editor-exit',
              animationDuration: reduceMotion
                ? '0s'
                : `${open ? MANAGE_MESSAGE_EDITOR_TRANSITION_MS : MANAGE_MESSAGE_EDITOR_EXIT_MS}ms`,
              animationTimingFunction: MANAGE_MESSAGE_EDITOR_TRANSITION_EASING,
              animationFillMode: 'both',
              pointerEvents: open && presentation === 'embedded' ? undefined : 'none',
              display: presentation === 'embedded' ? undefined : 'none',
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
            '@keyframes manage-message-editor-exit': {
              from: {
                opacity: 1,
                transform: 'translateX(0)',
              },
              to: {
                opacity: 0,
                transform: 'translateX(16px)',
              },
            },
          }}
        >
          <div ref={setEmbeddedMount} className="flex h-full min-h-0 flex-1" />
        </Paper>
      ) : null}
      {editorHostMounted ? createPortal(children, editorHost) : null}
    </>
  );
}
