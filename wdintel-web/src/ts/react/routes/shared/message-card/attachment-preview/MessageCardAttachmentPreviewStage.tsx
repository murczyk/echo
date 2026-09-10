import { Box } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  forwardRef,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  type PointerEventHandler,
  type ReactNode,
  useEffect,
  useRef,
} from 'react';

import { ATTACHMENT_PREVIEW_DRAG_THRESHOLD_PX } from '../message-card-image-preview-utils';
import { getAttachmentPreviewStageSx } from './message-card-attachment-preview';

type PreviewRegion = 'background' | 'content' | 'protected';

type PrimaryGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  startRegion: PreviewRegion;
  moved: boolean;
};

type PendingActivation = {
  region: PreviewRegion;
};

const PROTECTED_TARGET_SELECTOR = [
  '[data-attachment-preview-content]',
  '[data-attachment-preview-scroll]',
  '[data-attachment-preview-report-pane]',
  '[data-attachment-preview-video-controls]',
  '[data-audio-preview-content]',
  '[data-document-preview-content]',
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'video',
  'audio',
  'iframe',
  'canvas',
].join(',');
const ATTACHMENT_PREVIEW_DOUBLE_CLICK_WINDOW_MS = 350;

function getDefaultRegion(target: EventTarget | null): PreviewRegion {
  return target instanceof Element && target.closest(PROTECTED_TARGET_SELECTOR) !== null
    ? 'protected'
    : 'background';
}

export const MessageCardAttachmentPreviewStage = forwardRef<
  HTMLDivElement,
  {
    kind: 'image' | 'video' | 'audio' | 'document';
    children: ReactNode;
    cursor?: 'default' | 'grab';
    onPointerDown?: PointerEventHandler<HTMLDivElement>;
    onPointerMove?: PointerEventHandler<HTMLDivElement>;
    onPointerUp?: PointerEventHandler<HTMLDivElement>;
    onPointerCancel?: PointerEventHandler<HTMLDivElement>;
    onLostPointerCapture?: PointerEventHandler<HTMLDivElement>;
    onPointerLeave?: PointerEventHandler<HTMLDivElement>;
    onDoubleClick?: MouseEventHandler<HTMLDivElement>;
    onPrimaryClick?: (event: MouseEvent, region: PreviewRegion) => void;
    getPrimaryPointerRegion?: (event: PointerEvent, stage: HTMLDivElement) => PreviewRegion;
    activationEnabled?: boolean;
    activationKey?: string;
  }
>(function MessageCardAttachmentPreviewStage(
  {
    kind,
    children,
    cursor = 'default',
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
    onPointerLeave,
    onDoubleClick,
    onPrimaryClick,
    getPrimaryPointerRegion,
    activationEnabled = true,
    activationKey,
  },
  ref,
) {
  const theme = useTheme();
  const gestureRef = useRef<PrimaryGesture | null>(null);
  const pendingActivationRef = useRef<PendingActivation | null>(null);
  const lastActivationRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const activationEnabledRef = useRef(activationEnabled);
  activationEnabledRef.current = activationEnabled;
  const isDocument = kind === 'document';
  const isScrollable = isDocument || kind === 'audio';
  const getRegion = (event: PointerEvent, stage: HTMLDivElement) =>
    getPrimaryPointerRegion?.(event, stage) ?? getDefaultRegion(event.target);

  useEffect(() => {
    gestureRef.current = null;
    pendingActivationRef.current = null;
    lastActivationRef.current = null;
  }, [activationEnabled, activationKey]);

  const handlePointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
    pendingActivationRef.current = null;
    if (!activationEnabledRef.current) {
      gestureRef.current = null;
      onPointerDown?.(event);
      return;
    }
    if (event.pointerType === 'mouse' && event.button === 0) {
      gestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startRegion: getRegion(event.nativeEvent, event.currentTarget),
        moved: false,
      };
    }
    onPointerDown?.(event);
  };
  const handlePointerMove: PointerEventHandler<HTMLDivElement> = (event) => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    if (
      Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >
      ATTACHMENT_PREVIEW_DRAG_THRESHOLD_PX
    ) {
      gesture.moved = true;
    }
  };
  const handlePointerUp: PointerEventHandler<HTMLDivElement> = (event) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    onPointerUp?.(event);
    if (
      !activationEnabledRef.current ||
      gesture === null ||
      gesture.pointerId !== event.pointerId ||
      gesture.moved
    )
      return;
    const endRegion = getRegion(event.nativeEvent, event.currentTarget);
    if (gesture.startRegion !== endRegion) return;
    pendingActivationRef.current = { region: endRegion };
  };
  const handleClick: MouseEventHandler<HTMLDivElement> = (event) => {
    const pendingActivation = pendingActivationRef.current;
    pendingActivationRef.current = null;
    if (!activationEnabledRef.current || event.detail !== 1 || pendingActivation === null) return;
    const previousActivation = lastActivationRef.current;
    if (
      previousActivation !== null &&
      event.timeStamp - previousActivation.at <= ATTACHMENT_PREVIEW_DOUBLE_CLICK_WINDOW_MS &&
      Math.hypot(event.clientX - previousActivation.x, event.clientY - previousActivation.y) <=
        ATTACHMENT_PREVIEW_DRAG_THRESHOLD_PX
    )
      return;
    lastActivationRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    onPrimaryClick?.(event.nativeEvent, pendingActivation.region);
  };
  const clearGesture = (
    event: ReactPointerEvent<HTMLDivElement>,
    callback?: PointerEventHandler<HTMLDivElement>,
  ) => {
    if (gestureRef.current?.pointerId === event.pointerId) {
      gestureRef.current = null;
      pendingActivationRef.current = null;
    }
    callback?.(event);
  };

  return (
    <Box
      ref={ref}
      data-attachment-preview-stage={kind}
      data-image-preview-stage={kind === 'image' ? '' : undefined}
      data-document-preview-stage={isDocument ? '' : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={(event) => {
        handlePointerMove(event);
        onPointerMove?.(event);
      }}
      onPointerUp={handlePointerUp}
      onPointerCancel={(event) => clearGesture(event, onPointerCancel)}
      onLostPointerCapture={(event) => clearGesture(event, onLostPointerCapture)}
      onClick={handleClick}
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
        touchAction: kind === 'image' ? 'none' : undefined,
        userSelect: kind === 'image' ? 'none' : undefined,
      }}
    >
      {children}
    </Box>
  );
});
