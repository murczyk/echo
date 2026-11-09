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
import { useMediaThumbnail, useThumbnailRequestActivation } from '../use-media-thumbnail';

export function MessageCardVideoThumb({
  attachment,
  index,
  selected = false,
  onOpen,
  isDownloadStarting,
  onDownloadStart,
}: {
  attachment: MessageMediaInfo;
  index: number;
  selected?: boolean;
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
  const thumbnail = useMediaThumbnail(thumbnailSrc, thumbnailRequest.isActive);
  const showThumbnail = thumbnail.state === 'loaded';

  return (
    <div className="message-card-thumbnail-shell relative inline-flex self-start">
      <ButtonBase
        ref={thumbnailRequest.targetRef}
        component="button"
        type="button"
        onClick={canOpen ? () => onOpen(index) : undefined}
        disabled={!canOpen}
        aria-label="Відкрити відео"
        data-video-thumb-state={thumbnail.state}
        data-summary-selected={selected ? 'true' : undefined}
        aria-current={selected ? 'true' : undefined}
        className={`message-card-thumbnail-control inline-flex h-full w-full min-w-full max-w-full flex-[0_0_100%] overflow-hidden rounded-md text-left text-inherit ring-1 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-action)] disabled:cursor-default disabled:text-[var(--color-text-disabled)] ${
          selected
            ? 'bg-[color-mix(in_srgb,var(--color-action)_14%,transparent)] ring-[var(--color-action)] shadow-sm'
            : 'bg-[color-mix(in_srgb,var(--color-action)_8%,transparent)] ring-[var(--color-divider)] shadow-none'
        } ${canOpen ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <div className="relative flex h-full w-full min-w-full max-w-full flex-[0_0_100%] items-center justify-center overflow-hidden">
          {thumbnail.state === 'loading' && thumbnailSrc !== '' ? (
            <Skeleton
              variant="rectangular"
              animation="wave"
              data-message-card-thumbnail-skeleton="true"
              className="absolute inset-0 z-0 !h-full !w-full"
            />
          ) : null}
          {thumbnail.imageSrc !== null ? (
            <img
              key={thumbnail.imageSrc}
              src={thumbnail.imageSrc}
              alt=""
              loading="lazy"
              decoding="async"
              fetchPriority="low"
              onLoad={thumbnail.markLoaded}
              onError={thumbnail.markFailed}
              className={`pointer-events-none absolute inset-0 block h-full w-full object-cover transition-opacity duration-[120ms] ease-out ${
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
