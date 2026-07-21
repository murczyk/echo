import { useEffect, useRef, useState } from 'react';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { Box, ButtonBase, Typography, Skeleton } from '@mui/material';

import type { MessageMediaInfo } from '../../../../../Bindings';
import {
  mediaAttachmentDisplayName,
  mediaAttachmentThumbnailUrl,
  resolveMediaAttachmentId,
} from './MessageCardMedia';
import { handleUnauthorizedMediaResponse } from './message-card-media-fetch';

const VIDEO_THUMBNAIL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const VIDEO_THUMBNAIL_MAX_TRANSIENT_FAILURES = 4;
const VIDEO_THUMBNAIL_PENDING_STATUS = 202;
const VIDEO_THUMBNAIL_TERMINAL_STATUS = 422;

type VideoThumbnailState = 'loading' | 'loaded' | 'failed';

function thumbnailRequestUrl(thumbnailSrc: string, attempt: number): string {
  if (attempt === 0) return thumbnailSrc;
  const separator = thumbnailSrc.includes('?') ? '&' : '?';
  return `${thumbnailSrc}${separator}retry=${attempt}`;
}

function thumbnailRetryDelay(response: Response | null, attempt: number): number {
  const fallback =
    VIDEO_THUMBNAIL_RETRY_DELAYS_MS[Math.min(attempt, VIDEO_THUMBNAIL_RETRY_DELAYS_MS.length - 1)];
  const retryAfterSeconds = Number(response?.headers.get('Retry-After') ?? Number.NaN);
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) return fallback;
  return Math.max(fallback, retryAfterSeconds * 1_000);
}

function responseCanBeRetried(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function requestWasAborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function useThumbnailRequestActivation() {
  const targetRef = useRef<HTMLButtonElement | null>(null);
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    if (target === null || typeof IntersectionObserver === 'undefined') {
      setIsActive(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setIsActive(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return { targetRef, isActive };
}

function useVideoThumbnail(thumbnailSrc: string, isActive: boolean) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [state, setState] = useState<VideoThumbnailState>(
    thumbnailSrc === '' ? 'failed' : 'loading',
  );

  useEffect(() => {
    let stopped = false;
    let retryTimer: number | null = null;
    let requestController: AbortController | null = null;
    let objectUrl: string | null = null;
    let requestAttempt = 0;
    let transientFailures = 0;

    setImageSrc(null);
    setState(thumbnailSrc === '' ? 'failed' : 'loading');
    if (thumbnailSrc === '' || !isActive) return undefined;

    const fail = () => {
      if (!stopped) setState('failed');
    };
    const scheduleRetry = (response: Response | null) => {
      const delay = thumbnailRetryDelay(response, requestAttempt);
      requestAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void requestThumbnail();
      }, delay);
    };
    const handleTransientFailure = (response: Response | null) => {
      transientFailures += 1;
      if (transientFailures > VIDEO_THUMBNAIL_MAX_TRANSIENT_FAILURES) {
        fail();
        return;
      }
      scheduleRetry(response);
    };
    const requestThumbnail = async () => {
      requestController = new AbortController();
      let response: Response;
      try {
        response = await fetch(thumbnailRequestUrl(thumbnailSrc, requestAttempt), {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'image/jpeg' },
          signal: requestController.signal,
        });
      } catch (error) {
        if (!stopped && !requestWasAborted(error)) handleTransientFailure(null);
        return;
      }
      handleUnauthorizedMediaResponse(response, thumbnailSrc);
      if (stopped) return;
      if (response.status === VIDEO_THUMBNAIL_PENDING_STATUS) {
        transientFailures = 0;
        scheduleRetry(response);
        return;
      }
      if (response.status === VIDEO_THUMBNAIL_TERMINAL_STATUS) {
        fail();
        return;
      }
      if (!response.ok) {
        if (responseCanBeRetried(response.status)) handleTransientFailure(response);
        else fail();
        return;
      }

      try {
        const thumbnail = await response.blob();
        if (stopped) return;
        objectUrl = URL.createObjectURL(thumbnail);
        setImageSrc(objectUrl);
      } catch {
        if (!stopped) handleTransientFailure(response);
      }
    };

    void requestThumbnail();
    return () => {
      stopped = true;
      requestController?.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [isActive, thumbnailSrc]);

  return {
    imageSrc,
    state,
    markLoaded: () => setState('loaded'),
    markFailed: () => setState('failed'),
  };
}

export function MessageCardVideoThumb({
  attachment,
  index,
  onOpen,
}: {
  attachment: MessageMediaInfo;
  index: number;
  onOpen: (index: number) => void;
}) {
  const fullVideoHref = String(attachment.href ?? '');
  const displayName = mediaAttachmentDisplayName(attachment);
  const mediaId = resolveMediaAttachmentId(attachment);
  const thumbnailSrc = mediaId === '' ? '' : mediaAttachmentThumbnailUrl(mediaId);
  const canOpen = fullVideoHref.trim() !== '';
  const thumbnailRequest = useThumbnailRequestActivation();
  const thumbnail = useVideoThumbnail(thumbnailSrc, thumbnailRequest.isActive);
  const showThumbnail = thumbnail.state === 'loaded';

  return (
    <ButtonBase
      ref={thumbnailRequest.targetRef}
      component="button"
      type="button"
      onClick={canOpen ? () => onOpen(index) : undefined}
      disabled={!canOpen}
      aria-label="Відкрити відео"
      data-video-thumb-state={thumbnail.state}
      sx={{
        display: 'inline-flex',
        maxWidth: 150,
        height: 150,
        minWidth: 85,
        alignSelf: 'flex-start',
        textAlign: 'left',
        cursor: canOpen ? 'pointer' : 'default',
        color: 'inherit',
        borderRadius: 1.5,
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'divider',
        backgroundColor: 'action.hover',
        '&:disabled': {
          color: 'text.disabled',
        },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: '-2px',
        },
      }}
    >
      <Box
        sx={{
          position: 'relative',
          display: 'flex',
          width: '100%',
          height: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {thumbnail.state === 'loading' && thumbnailSrc !== '' ? (
          <Skeleton
            variant="rectangular"
            animation="wave"
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              zIndex: 0,
            }}
          />
        ) : null}
        {thumbnail.imageSrc !== null ? (
          <Box
            component="img"
            src={thumbnail.imageSrc}
            alt=""
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            onLoad={thumbnail.markLoaded}
            onError={thumbnail.markFailed}
            sx={{
              display: 'block',
              maxWidth: 150,
              height: 150,
              width: 'auto',
              objectFit: 'cover',
              opacity: showThumbnail ? 1 : 0,
              transition: 'opacity 120ms ease-out',
              pointerEvents: 'none',
            }}
          />
        ) : null}
        <Box
          sx={{
            backgroundColor: 'transparent',
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background-color 120ms ease-out',
          }}
        >
          {showThumbnail ? (
            <PlayArrowIcon
              sx={{
                fontSize: 32,
                color: '#fff',
                filter: 'drop-shadow(0px 2px 4px rgba(0,0,0,0.5))',
              }}
            />
          ) : (
            <>
              <PlayArrowIcon
                aria-hidden
                sx={{
                  fontSize: 32,
                  color: 'text.secondary',
                }}
              />
              <Typography
                variant="caption"
                sx={{
                  px: 1,
                  width: '100%',
                  textAlign: 'center',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'text.secondary',
                }}
              >
                {displayName}
              </Typography>
            </>
          )}
        </Box>
      </Box>
    </ButtonBase>
  );
}
