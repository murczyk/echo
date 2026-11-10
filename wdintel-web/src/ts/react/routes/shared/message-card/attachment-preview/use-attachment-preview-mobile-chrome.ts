import { createContext, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ATTACHMENT_PREVIEW_DRAG_THRESHOLD_PX } from '../message-card-image-preview-utils';
import { MESSAGE_CARD_PREVIEW_MOBILE_TAP_MAX_DURATION_MS } from './message-card-preview-config';

type PreviewPointerEvent = Pick<
  PointerEvent,
  'isPrimary' | 'button' | 'target' | 'pointerId' | 'clientX' | 'clientY'
>;

const PROTECTED_TARGETS = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'summary',
  'iframe',
  '[role="slider"]',
  '[role="tab"]',
  '[contenteditable="true"]',
  'table',
  '[data-audio-player-host]',
  '[data-audio-preview-player]',
  '[data-attachment-preview-report-pane]',
  '.leaflet-control',
  '.leaflet-interactive',
  '.leaflet-marker-icon',
  '.leaflet-popup',
  '[data-coordinate-panel]',
].join(',');

function isProtectedTarget(target: EventTarget | null) {
  const element = target as Element | null;
  return typeof element?.closest === 'function' && element.closest(PROTECTED_TARGETS) !== null;
}

export function useAttachmentPreviewMobileChrome(enabled: boolean, previewIndex?: number) {
  const [visible, setVisible] = useState(true);
  const tap = useRef<{ pointerId: number; x: number; y: number; startedAt: number } | null>(null);
  const pendingClick = useRef(false);

  useEffect(() => {
    setVisible(true);
    tap.current = null;
    pendingClick.current = false;
  }, [enabled, previewIndex]);

  const onPointerDownCapture = (event: PreviewPointerEvent) => {
    pendingClick.current = false;
    tap.current =
      enabled && event.isPrimary && event.button === 0 && !isProtectedTarget(event.target)
        ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startedAt: Date.now() }
        : null;
  };
  const onPointerMoveCapture = (event: PreviewPointerEvent) => {
    const start = tap.current;
    if (
      start &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) >
        ATTACHMENT_PREVIEW_DRAG_THRESHOLD_PX
    )
      tap.current = null;
  };
  const onPointerUpCapture = (event: PreviewPointerEvent) => {
    const start = tap.current;
    pendingClick.current =
      start !== null &&
      start.pointerId === event.pointerId &&
      Date.now() - start.startedAt < MESSAGE_CARD_PREVIEW_MOBILE_TAP_MAX_DURATION_MS &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) <=
        ATTACHMENT_PREVIEW_DRAG_THRESHOLD_PX &&
      !isProtectedTarget(event.target);
    tap.current = null;
  };
  const onClick = (event: Pick<MouseEvent, 'target' | 'stopPropagation'>) => {
    if (!enabled || !pendingClick.current) return;
    pendingClick.current = false;
    const ownerDocument = (event.target as Node | null)?.ownerDocument ?? document;
    if (isProtectedTarget(event.target) || ownerDocument.getSelection()?.isCollapsed === false)
      return;
    event.stopPropagation();
    setVisible((current) => !current);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !enabled ||
      event.target !== event.currentTarget ||
      event.repeat ||
      (event.key !== 'Enter' && event.key !== ' ')
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    setVisible((current) => !current);
  };

  return {
    visible,
    surfaceProps: {
      onPointerDownCapture,
      onPointerMoveCapture,
      onPointerUpCapture,
      onPointerCancelCapture: () => {
        tap.current = null;
        pendingClick.current = false;
      },
      onClick,
      onKeyDown,
      tabIndex: enabled ? 0 : undefined,
      role: enabled ? 'region' : undefined,
      'aria-label': enabled ? 'Область перегляду вкладення' : undefined,
    },
  };
}

export const AttachmentPreviewMobileSurfaceContext = createContext<
  ReturnType<typeof useAttachmentPreviewMobileChrome>['surfaceProps'] | null
>(null);
