import { useCallback, useEffect, useRef } from 'react';
import { requestTraversal } from '../../browser/navigation-guard';

const HISTORY_STATE_KEY = '__echoBrowserBackOverlayIds';
const DOCUMENT_CLASS = 'echo-browser-back-overlay-open';
const EDGE_START_MAX_PX = 32;
const EDGE_SWIPE_MIN_PX = 72;
const EDGE_SWIPE_HORIZONTAL_RATIO = 1.2;

type OverlayEntry = {
  id: string;
  onClose: () => boolean | void;
};

type EdgeGesture = {
  startX: number;
  startY: number;
} | null;

let nextOverlayId = 0;
let overlays: OverlayEntry[] = [];
let edgeGesture: EdgeGesture = null;
let listenersAttached = false;
let unmountHistoryCleanupScheduled = false;
const pendingUnmountedOverlayIds = new Set<string>();

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

function requestOverlayClose(id: string, onClose: () => boolean | void) {
  const overlay = overlays.find((entry) => entry.id === id);
  if (!overlay) {
    onClose();
    return;
  }
  if (overlay !== topOverlay()) return;
  if (onClose() === false) return;

  const historyIds = readOverlayIds(window.history.state);
  overlays = overlays.filter((entry) => entry !== overlay);
  updateDocumentProtection();
  if (historyIds.includes(id)) {
    void requestTraversal(-1);
  }
}

function handlePopState(event: PopStateEvent) {
  const restoredIds = new Set(readOverlayIds(event.state));
  const dismissed = overlays.filter((entry) => !restoredIds.has(entry.id)).reverse();
  if (dismissed.length === 0) return;

  const dismissedIds = new Set(dismissed.map((entry) => entry.id));
  overlays = overlays.filter((entry) => !dismissedIds.has(entry.id));
  updateDocumentProtection();
  for (const [index, entry] of dismissed.entries()) {
    if (entry.onClose() !== false) continue;
    dismissed
      .slice(index)
      .reverse()
      .forEach((dismissedEntry) => registerOverlay(dismissedEntry.id, dismissedEntry.onClose));
    break;
  }
}

function handleTouchStart(event: TouchEvent) {
  if (event.target instanceof Element && event.target.closest('[data-mobile-video-timeline]')) {
    edgeGesture = null;
    return;
  }
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

function registerOverlay(id: string, onClose: () => boolean | void) {
  overlays = overlays.filter((entry) => entry.id !== id);
  overlays.push({ id, onClose });

  if (!readOverlayIds(window.history.state).includes(id)) {
    window.history.pushState(withOverlayId(window.history.state, id), '', window.location.href);
  }
  updateDocumentProtection();
}

function unregisterOverlay(id: string, consumeHistory = false) {
  const overlay = overlays.find((entry) => entry.id === id);
  if (!overlay) return;
  const shouldConsumeHistory =
    consumeHistory && overlay === topOverlay() && readOverlayIds(window.history.state).includes(id);
  overlays = overlays.filter((entry) => entry.id !== id);
  updateDocumentProtection();
  if (shouldConsumeHistory) void requestTraversal(-1);
}

function unregisterOverlayAfterUnmount(id: string) {
  const wasRegistered = overlays.some((entry) => entry.id === id);
  if (wasRegistered) pendingUnmountedOverlayIds.add(id);
  unregisterOverlay(id);
  if (!wasRegistered || unmountHistoryCleanupScheduled) return;

  unmountHistoryCleanupScheduled = true;
  queueMicrotask(() => {
    unmountHistoryCleanupScheduled = false;
    const historyIds = readOverlayIds(window.history.state);
    let historyLayerCount = 0;
    for (let index = historyIds.length - 1; index >= 0; index -= 1) {
      const historyId = historyIds[index]!;
      if (!pendingUnmountedOverlayIds.has(historyId)) break;
      if (overlays.some((entry) => entry.id === historyId)) break;
      historyLayerCount += 1;
    }
    pendingUnmountedOverlayIds.clear();

    if (historyLayerCount === 1) void requestTraversal(-1);
    else if (historyLayerCount > 1) void requestTraversal(-historyLayerCount);
  });
}

export function useBrowserBackOverlay({
  open,
  onClose,
  onBrowserBack = onClose,
}: {
  open: boolean;
  onClose: () => boolean | void;
  onBrowserBack?: () => boolean | void;
}) {
  const idRef = useRef<string>();
  const onCloseRef = useRef(onClose);
  const onBrowserBackRef = useRef(onBrowserBack);
  const wasOpenRef = useRef(false);
  onCloseRef.current = onClose;
  onBrowserBackRef.current = onBrowserBack;
  if (!idRef.current) idRef.current = `echo-overlay-${++nextOverlayId}`;

  useEffect(() => {
    const id = idRef.current!;
    if (open) {
      registerOverlay(id, () => onBrowserBackRef.current());
      wasOpenRef.current = true;
    } else if (wasOpenRef.current) {
      unregisterOverlay(id, true);
      wasOpenRef.current = false;
    }
  }, [open]);

  useEffect(
    () => () => {
      unregisterOverlayAfterUnmount(idRef.current!);
      wasOpenRef.current = false;
    },
    [],
  );

  return useCallback(() => {
    requestOverlayClose(idRef.current!, () => onCloseRef.current());
  }, []);
}
