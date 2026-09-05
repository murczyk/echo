import { useEffect, useRef, useState } from 'react';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { ButtonBase, Skeleton, Typography } from '@mui/material';

import type { MessageMediaInfo } from '../../../../../Bindings';
import {
  mediaAttachmentDisplayName,
  mediaAttachmentThumbnailUrl,
  mediaDownloadAttr,
  messageCardMediaDownloadKey,
  MessageMediaThumbnailDownloadLink,
  resolveMediaAttachmentId,
  type MessageCardDownloadGuardProps,
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
  isDownloadStarting,
  onDownloadStart,
}: {
  attachment: MessageMediaInfo;
  index: number;
  onOpen: (index: number) => void;
} & MessageCardDownloadGuardProps) {
  const fullVideoHref = String(attachment.href ?? '');
  const displayName = mediaAttachmentDisplayName(attachment);
  const downloadName = mediaDownloadAttr(displayName, `video-${index + 1}`);
  const downloadKey = messageCardMediaDownloadKey(attachment.id ?? fullVideoHref);
  const mediaId = resolveMediaAttachmentId(attachment);
  const thumbnailSrc = mediaId === '' ? '' : mediaAttachmentThumbnailUrl(mediaId);
  const canOpen = fullVideoHref.trim() !== '';
  const thumbnailRequest = useThumbnailRequestActivation();
  const thumbnail = useVideoThumbnail(thumbnailSrc, thumbnailRequest.isActive);
  const showThumbnail = thumbnail.state === 'loaded';

  return (
    <div className="relative inline-flex h-[150px] min-w-[85px] max-w-[150px] self-start">
      <ButtonBase
        ref={thumbnailRequest.targetRef}
        component="button"
        type="button"
        onClick={canOpen ? () => onOpen(index) : undefined}
        disabled={!canOpen}
        aria-label="Відкрити відео"
        data-video-thumb-state={thumbnail.state}
        className={`inline-flex h-full w-full overflow-hidden rounded-md border border-solid border-[var(--color-divider)] bg-[color-mix(in_srgb,var(--color-action)_8%,transparent)] text-left text-inherit focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-action)] disabled:cursor-default disabled:text-[var(--color-text-disabled)] ${
          canOpen ? 'cursor-pointer' : 'cursor-default'
        }`}
      >
        <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
          {thumbnail.state === 'loading' && thumbnailSrc !== '' ? (
            <Skeleton
              variant="rectangular"
              animation="wave"
              className="absolute inset-0 z-0 h-full! w-full!"
            />
          ) : null}
          {thumbnail.imageSrc !== null ? (
            <img
              src={thumbnail.imageSrc}
              alt=""
              loading="lazy"
              decoding="async"
              fetchPriority="low"
              onLoad={thumbnail.markLoaded}
              onError={thumbnail.markFailed}
              className={`pointer-events-none block h-[150px] w-auto max-w-[150px] object-cover transition-opacity duration-[120ms] ease-out ${
                showThumbnail ? 'opacity-100' : 'opacity-0'
              }`}
            />
          ) : null}
          <div className="absolute inset-0 z-[1] flex h-full w-full flex-col items-center justify-center bg-transparent transition-colors duration-[120ms] ease-out">
            {showThumbnail ? (
              <PlayArrowIcon className="text-[32px] text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]" />
            ) : (
              <>
                <PlayArrowIcon aria-hidden className="text-[32px] text-[var(--color-text-muted)]" />
                <Typography
                  variant="caption"
                  className="w-full overflow-hidden text-ellipsis whitespace-nowrap px-2 text-center text-[var(--color-text-muted)]"
                >
                  {displayName}
                </Typography>
              </>
            )}
          </div>
        </div>
      </ButtonBase>
      <MessageMediaThumbnailDownloadLink
        href={fullVideoHref}
        displayName={displayName}
        downloadName={downloadName}
        downloadKey={downloadKey}
        isDownloadStarting={isDownloadStarting}
        onDownloadStart={onDownloadStart}
      />
    </div>
  );
}
