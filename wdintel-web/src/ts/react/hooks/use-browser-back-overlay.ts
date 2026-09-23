import { useCallback, useEffect, useRef } from 'react';

const HISTORY_STATE_KEY = '__echoBrowserBackOverlayIds';
const DOCUMENT_CLASS = 'echo-browser-back-overlay-open';
const EDGE_START_MAX_PX = 32;
const EDGE_SWIPE_MIN_PX = 72;
const EDGE_SWIPE_HORIZONTAL_RATIO = 1.2;

type OverlayEntry = {
  id: string;
  onClose: () => void;
};

type EdgeGesture = {
  startX: number;
  startY: number;
} | null;

let nextOverlayId = 0;
let overlays: OverlayEntry[] = [];
let edgeGesture: EdgeGesture = null;
let listenersAttached = false;

function readOverlayIds(state: unknown): string[] {
  if (state == null || typeof state !== 'object' || Array.isArray(state)) return [];
  const ids = (state as Record<string, unknown>)[HISTORY_STATE_KEY];
  return Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? ids : [];
}

function withOverlayId(state: unknown, id: string): Record<string, unknown> {
  const baseState =
    state != null && typeof state === 'object' && !Array.isArray(state) ? state : {};
  return {
    ...baseState,
    [HISTORY_STATE_KEY]: [...readOverlayIds(state), id],
  };
}

function topOverlay() {
  return overlays.at(-1) ?? null;
}

function requestOverlayClose(id: string, fallback: () => void) {
  const overlay = overlays.find((entry) => entry.id === id);
  if (!overlay) {
    fallback();
    return;
  }
  if (overlay !== topOverlay()) return;

  const historyIds = readOverlayIds(window.history.state);
  if (historyIds.includes(id)) {
    overlays = overlays.filter((entry) => entry !== overlay);
    updateDocumentProtection();
    window.history.back();
    overlay.onClose();
    return;
  }

  overlays = overlays.filter((entry) => entry !== overlay);
  updateDocumentProtection();
  overlay.onClose();
}

function handlePopState(event: PopStateEvent) {
  const restoredIds = new Set(readOverlayIds(event.state));
  const dismissed = overlays.filter((entry) => !restoredIds.has(entry.id)).reverse();
  if (dismissed.length === 0) return;

  const dismissedIds = new Set(dismissed.map((entry) => entry.id));
  overlays = overlays.filter((entry) => !dismissedIds.has(entry.id));
  updateDocumentProtection();
  dismissed.forEach((entry) => entry.onClose());
}

function handleTouchStart(event: TouchEvent) {
  if (event.touches.length !== 1) {
    edgeGesture = null;
    return;
  }
  const touch = event.touches[0];
  edgeGesture =
    touch && touch.clientX <= EDGE_START_MAX_PX
      ? { startX: touch.clientX, startY: touch.clientY }
      : null;
}

function handleTouchMove(event: TouchEvent) {
  const touch = event.touches[0];
  if (!edgeGesture || !touch) return;
  const deltaX = touch.clientX - edgeGesture.startX;
  const deltaY = touch.clientY - edgeGesture.startY;
  if (deltaX > 0 && deltaX > Math.abs(deltaY) * EDGE_SWIPE_HORIZONTAL_RATIO) {
    event.preventDefault();
  }
}

function handleTouchEnd(event: TouchEvent) {
  const gesture = edgeGesture;
  edgeGesture = null;
  const touch = event.changedTouches[0];
  const overlay = topOverlay();
  if (!gesture || !touch || !overlay) return;

  const deltaX = touch.clientX - gesture.startX;
  const deltaY = touch.clientY - gesture.startY;
  if (deltaX < EDGE_SWIPE_MIN_PX || deltaX < Math.abs(deltaY) * EDGE_SWIPE_HORIZONTAL_RATIO) {
    return;
  }
  requestOverlayClose(overlay.id, overlay.onClose);
}

function handleTouchCancel() {
  edgeGesture = null;
}

function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  window.addEventListener('popstate', handlePopState);
  document.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true });
  document.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
  document.addEventListener('touchend', handleTouchEnd, { passive: true, capture: true });
  document.addEventListener('touchcancel', handleTouchCancel, { passive: true, capture: true });
}

function detachListeners() {
  if (!listenersAttached) return;
  listenersAttached = false;
  edgeGesture = null;
  window.removeEventListener('popstate', handlePopState);
  document.removeEventListener('touchstart', handleTouchStart, true);
  document.removeEventListener('touchmove', handleTouchMove, true);
  document.removeEventListener('touchend', handleTouchEnd, true);
  document.removeEventListener('touchcancel', handleTouchCancel, true);
}

function updateDocumentProtection() {
  document.documentElement.classList.toggle(DOCUMENT_CLASS, overlays.length > 0);
  if (overlays.length > 0) attachListeners();
  else detachListeners();
}

function registerOverlay(id: string, onClose: () => void) {
  overlays = overlays.filter((entry) => entry.id !== id);
  overlays.push({ id, onClose });

  if (!readOverlayIds(window.history.state).includes(id)) {
    window.history.pushState(withOverlayId(window.history.state, id), '', window.location.href);
  }
  updateDocumentProtection();
}

function unregisterOverlay(id: string) {
  overlays = overlays.filter((entry) => entry.id !== id);
  updateDocumentProtection();
}

export function useBrowserBackOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const idRef = useRef<string>();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  if (!idRef.current) idRef.current = `echo-overlay-${++nextOverlayId}`;

  useEffect(() => {
    if (!open) return;
    const id = idRef.current!;
    registerOverlay(id, () => onCloseRef.current());
    return () => unregisterOverlay(id);
  }, [open]);

  return useCallback(() => {
    requestOverlayClose(idRef.current!, () => onCloseRef.current());
  }, []);
}
