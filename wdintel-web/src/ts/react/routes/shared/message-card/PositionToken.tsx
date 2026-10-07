import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import type { CnPosition } from '../../../../../Bindings';
import { CoordinateAttachmentHoverPreview } from './CoordinateAttachmentHoverPreview';
import { resolvePositionCoordinatePreviewPoints } from './message-position-coordinates';

const OPEN_DELAY_MS = 600;
const CLOSE_DELAY_MS = 120;

export function PositionToken({
  position,
  title,
  className,
  onOpen,
  children,
}: {
  position: CnPosition;
  title: string;
  className: string;
  onOpen?: (position: CnPosition) => void;
  children: ReactNode;
}) {
  const points = useMemo(() => resolvePositionCoordinatePreviewPoints(position), [position]);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerInsideRef = useRef(false);
  const focusInsideRef = useRef(false);
  const [open, setOpen] = useState(false);
  const previewId = useId();
  const located = points.length > 0;
  const interactive = located && onOpen != null;
  const clearTimer = () => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const close = () => {
    clearTimer();
    setOpen(false);
  };
  const scheduleClose = () => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      if (!pointerInsideRef.current && !focusInsideRef.current) setOpen(false);
    }, CLOSE_DELAY_MS);
  };
  const openMap = () => {
    close();
    onOpen?.(position);
  };

  useEffect(() => {
    close();
  }, [position]);
  useEffect(() => clearTimer, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => close();
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (triggerRef.current?.contains(target) ||
          document.getElementById(previewId)?.contains(target))
      )
        return;
      close();
    };
    document.addEventListener('keydown', dismissOnEscape, true);
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('wheel', dismiss, true);
    return () => {
      document.removeEventListener('keydown', dismissOnEscape, true);
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('wheel', dismiss, true);
    };
  }, [open, previewId]);

  return (
    <>
      <span
        ref={triggerRef}
        className={className}
        title={located ? undefined : title}
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={interactive ? `${title}. Відкрити мапу повідомлення` : undefined}
        aria-describedby={open ? previewId : undefined}
        onPointerEnter={(event) => {
          if (!located || event.pointerType === 'touch') return;
          pointerInsideRef.current = true;
          clearTimer();
          timerRef.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
        }}
        onPointerLeave={() => {
          pointerInsideRef.current = false;
          scheduleClose();
        }}
        onFocus={() => {
          if (!located) return;
          focusInsideRef.current = true;
          clearTimer();
          setOpen(true);
        }}
        onBlur={() => {
          focusInsideRef.current = false;
          scheduleClose();
        }}
        onClick={
          interactive
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                openMap();
              }
            : undefined
        }
        onKeyDown={
          interactive
            ? (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                openMap();
              }
            : undefined
        }
      >
        {children}
      </span>
      {open ? (
        <CoordinateAttachmentHoverPreview
          anchorEl={triggerRef.current}
          open
          points={points}
          id={previewId}
          title={title}
          onEnter={() => {
            pointerInsideRef.current = true;
            clearTimer();
          }}
          onLeave={() => {
            pointerInsideRef.current = false;
            scheduleClose();
          }}
        />
      ) : null}
    </>
  );
}
