import type { AnchorSnapshot } from '../message-feed.types';

export const DEFAULT_TOP_LOAD_BUFFER_PX = 160;
export const DEFAULT_BOTTOM_LOAD_BUFFER_PX = 320;
export const DEFAULT_AT_BOTTOM_THRESHOLD_PX = 25;
export const FEED_ITEM_SCROLL_MS = 300;
export const INITIAL_BOTTOM_SETTLE_FRAMES = 12;
export const INITIAL_BOTTOM_SETTLE_TIMEOUT_MS = 2000;
/** Wait for scroll to settle before prefetching newer — avoids mid-fling window commits. */
export const LOAD_NEWER_SCROLL_IDLE_MS = 140;
/** Same idle gate: push buffered newer pages into the DOM only when the finger stops. */
export const FLUSH_PENDING_SCROLL_IDLE_MS = LOAD_NEWER_SCROLL_IDLE_MS;

export function areNumberArraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  if (a[0] !== b[0] || a[a.length - 1] !== b[b.length - 1]) return false;
  for (let i = 1; i < a.length - 1; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function distanceToBottom(el: HTMLElement): number {
  return Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
}

export function hasViewportSizeChanged(
  scroller: HTMLElement,
  snapshot: AnchorSnapshot | null,
): boolean {
  return (
    snapshot !== null &&
    (((snapshot.clientWidth ?? 0) > 0 && snapshot.clientWidth !== scroller.clientWidth) ||
      ((snapshot.clientHeight ?? 0) > 0 && snapshot.clientHeight !== scroller.clientHeight))
  );
}

export function isAtPhysicalBottom(scroller: HTMLElement): boolean {
  const distance = distanceToBottom(scroller);
  if (distance <= 1) return true;
  if (distance > 2 || !scroller.lastElementChild) return false;
  // CSS zoom can compound rounding of the integer scrollHeight/clientHeight.
  const viewport = scroller.getBoundingClientRect();
  const content = scroller.lastElementChild.getBoundingClientRect();
  if (viewport.height <= 0 || content.height <= 0) return false;
  const scale = scroller.offsetHeight > 0 ? viewport.height / scroller.offsetHeight : 1;
  const style = getComputedStyle(scroller);
  const trailingInset =
    (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  return Math.abs(content.bottom + trailingInset * scale - viewport.bottom) <= 1;
}

export function effectiveBottomLoadBufferPx(
  scroller: HTMLElement,
  bottomLoadBufferPx: number,
  unreadPrefetchNeeded: boolean,
): number {
  if (!unreadPrefetchNeeded) return bottomLoadBufferPx;
  const viewportCap = Math.max(bottomLoadBufferPx, scroller.clientHeight * 2);
  return Math.min(viewportCap, bottomLoadBufferPx * 2);
}

export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
