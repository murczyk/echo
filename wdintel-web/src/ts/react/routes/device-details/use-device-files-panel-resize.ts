import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

const MIN_WIDTH = 240;
const INITIAL_WIDTH = 320;
const CONTENT_MIN_WIDTH = 320;
const SESSIONS_WIDTH = 344;
const PANEL_GAP = 16;

export function useDeviceFilesPanelResize(sessionsOpen: boolean, enabled: boolean) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(INITIAL_WIDTH);
  const [maxWidth, setMaxWidth] = useState(INITIAL_WIDTH);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const resize = (next: number) => setWidth(Math.max(MIN_WIDTH, Math.min(maxWidth, next)));

  useEffect(() => {
    if (!container || !enabled) return;
    const updateBounds = () => {
      const available = Math.max(
        MIN_WIDTH,
        container.clientWidth -
          CONTENT_MIN_WIDTH -
          PANEL_GAP -
          (sessionsOpen ? SESSIONS_WIDTH + PANEL_GAP : 0),
      );
      setMaxWidth(available);
      setWidth((current) => Math.min(current, available));
    };
    updateBounds();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateBounds);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, sessionsOpen, enabled]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start?.pointerId === event.pointerId) resize(start.width + event.clientX - start.x);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = width - 10;
        break;
      case 'ArrowRight':
        next = width + 10;
        break;
      case 'Home':
        next = MIN_WIDTH;
        break;
      case 'End':
        next = maxWidth;
        break;
      default:
        return;
    }
    event.preventDefault();
    resize(next);
  };

  return {
    containerRef: setContainer,
    width,
    separatorProps: {
      'aria-valuemin': MIN_WIDTH,
      'aria-valuemax': maxWidth,
      'aria-valuenow': width,
      'aria-valuetext': `${width} px`,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onLostPointerCapture: () => {
        drag.current = null;
      },
      onKeyDown,
    },
  };
}
