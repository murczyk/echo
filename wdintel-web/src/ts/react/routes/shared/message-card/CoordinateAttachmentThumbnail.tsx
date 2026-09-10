import 'leaflet/dist/leaflet.css';

import { ButtonBase, Skeleton, Typography } from '@mui/material';
import { useEffect, useId, useRef, useState } from 'react';

import { CoordinateAttachmentHoverPreview } from './CoordinateAttachmentHoverPreview';
import { CoordinatePreviewMapSurface } from './CoordinatePreviewMapSurface';
import type { CoordinatePreviewPoint } from './message-coordinate-preview';

const PREVIEW_ROOT_MARGIN = '160px 0px';
const OPEN_DELAY_MS = 600;
const CLOSE_DELAY_MS = 120;

export function CoordinateAttachmentThumbnail({
  points,
  onOpen,
  fullWidth = false,
  messageCardTile = false,
}: {
  points: CoordinatePreviewPoint[];
  onOpen: () => void;
  fullWidth?: boolean;
  messageCardTile?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const pointerInsideRef = useRef(false);
  const focusInsideRef = useRef(false);
  const suppressPointerFocusRef = useRef(false);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [isHoverPreviewOpen, setIsHoverPreviewOpen] = useState(false);
  const previewId = useId();
  const point = points[0];
  const clearTimers = () => {
    if (openTimerRef.current != null) window.clearTimeout(openTimerRef.current);
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    openTimerRef.current = null;
    closeTimerRef.current = null;
  };
  const closePreview = () => {
    clearTimers();
    setIsHoverPreviewOpen(false);
  };
  const scheduleClose = () => {
    if (pointerInsideRef.current || focusInsideRef.current) return;
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (!pointerInsideRef.current && !focusInsideRef.current) setIsHoverPreviewOpen(false);
    }, CLOSE_DELAY_MS);
  };
  const openForPointer = (pointerType?: string) => {
    if (pointerType === 'touch' || window.matchMedia?.('(hover: none)').matches) return;
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    if (isHoverPreviewOpen || openTimerRef.current != null) return;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      if (pointerInsideRef.current) setIsHoverPreviewOpen(true);
    }, OPEN_DELAY_MS);
  };
  useEffect(() => {
    const host = hostRef.current;
    if (host == null || typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setIsNearViewport(true);
      },
      { rootMargin: PREVIEW_ROOT_MARGIN, threshold: 0.01 },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    closePreview();
  }, [points]);
  useEffect(() => {
    if (!isHoverPreviewOpen) return;
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (hostRef.current?.contains(target) || document.getElementById(previewId)?.contains(target))
      )
        return;
      closePreview();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closePreview();
      }
    };
    const dismiss = () => closePreview();
    document.addEventListener('pointerdown', dismissOnOutsidePointer, true);
    document.addEventListener('keydown', dismissOnEscape, true);
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('wheel', dismiss, true);
    document.addEventListener('touchmove', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOnOutsidePointer, true);
      document.removeEventListener('keydown', dismissOnEscape, true);
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('wheel', dismiss, true);
      document.removeEventListener('touchmove', dismiss, true);
    };
  }, [isHoverPreviewOpen, previewId]);
  useEffect(() => clearTimers, []);
  if (point == null) return null;
  const tileClassName = `message-card-thumbnail-control${fullWidth ? ' coordinate-thumbnail--full-width' : ''}`;
  return (
    <div
      ref={hostRef}
      data-coordinate-preview-tile="true"
      data-message-card-tile={messageCardTile ? 'true' : undefined}
      className={`coordinate-thumbnail${fullWidth ? ' coordinate-thumbnail--full-width' : ''}`}
      style={{
        flex: fullWidth ? '1 1 auto' : messageCardTile ? '0 0 auto' : '0 0 120px',
        width: fullWidth || messageCardTile ? '100%' : '180px',
        height: fullWidth || messageCardTile ? '100%' : '120px',
        maxWidth: fullWidth ? '100%' : 'none',
      }}
    >
      {!isNearViewport ? (
        <Skeleton variant="rounded" className={tileClassName} animation="wave" />
      ) : (
        <ButtonBase
          ref={triggerRef}
          type="button"
          style={{
            flex: fullWidth ? '1 1 auto' : messageCardTile ? '0 0 auto' : '0 0 120px',
            width: fullWidth || messageCardTile ? '100%' : '180px',
            height: fullWidth || messageCardTile ? '100%' : '120px',
            maxWidth: fullWidth ? '100%' : 'none',
          }}
          onClick={() => {
            closePreview();
            onOpen();
          }}
          onPointerDown={() => {
            suppressPointerFocusRef.current = true;
          }}
          onPointerEnter={(event) => {
            pointerInsideRef.current = true;
            openForPointer(event.pointerType);
          }}
          onPointerLeave={() => {
            pointerInsideRef.current = false;
            if (openTimerRef.current != null) window.clearTimeout(openTimerRef.current);
            openTimerRef.current = null;
            scheduleClose();
          }}
          onFocus={() => {
            if (suppressPointerFocusRef.current) {
              suppressPointerFocusRef.current = false;
              return;
            }
            focusInsideRef.current = true;
            if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
            setIsHoverPreviewOpen(true);
          }}
          onBlur={() => {
            focusInsideRef.current = false;
            scheduleClose();
          }}
          aria-label={`Open ${point.label} on map`}
          aria-describedby={isHoverPreviewOpen ? previewId : undefined}
          className={tileClassName}
        >
          <CoordinatePreviewMapSurface
            points={points}
            mode="thumbnail"
            className="coordinate-thumbnail__map"
          />
          <span className="coordinate-thumbnail__shade" />
          <span className="coordinate-thumbnail__count">
            <Typography variant="caption" data-coordinate-preview-count="true">
              {points.length}
            </Typography>
          </span>
        </ButtonBase>
      )}
      <CoordinateAttachmentHoverPreview
        anchorEl={triggerRef.current}
        open={isHoverPreviewOpen}
        points={points}
        id={previewId}
        onEnter={() => {
          pointerInsideRef.current = true;
          if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
        }}
        onLeave={() => {
          pointerInsideRef.current = false;
          scheduleClose();
        }}
      />
    </div>
  );
}
