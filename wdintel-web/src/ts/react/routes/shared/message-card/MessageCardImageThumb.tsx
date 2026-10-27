import { useState } from 'react';
import type { MouseEvent } from 'react';
import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import { ButtonBase, Skeleton, Typography } from '@mui/material';

import {
  deriveImageDownloadName,
  derivePreviewFileName,
  type MessageCardImage,
} from './message-card-image-utils';
import { blurActiveElement } from '../../../utils/focus';
import {
  messageCardMediaDownloadKey,
  mediaAttachmentThumbnailUrl,
  MessageMediaThumbnailDownloadLink,
  resolveMediaAttachmentId,
  type MessageCardDownloadGuardProps,
} from './MessageCardMedia';
import { useMediaThumbnail, useThumbnailRequestActivation } from './MessageCardVideoThumb';

type PreviewVariant = 'single' | 'multi';

export function MessageCardImageThumb({
  image,
  index,
  variant,
  compact = false,
  selected = false,
  onOpen,
  isDownloadStarting,
  onDownloadStart,
}: {
  image: MessageCardImage;
  index: number;
  variant: PreviewVariant;
  compact?: boolean;
  selected?: boolean;
  onOpen: (index: number) => void;
} & MessageCardDownloadGuardProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const mediaId = resolveMediaAttachmentId(image);
  const thumbnailUrl = mediaId === '' ? '' : mediaAttachmentThumbnailUrl(mediaId);
  const thumbnailRequest = useThumbnailRequestActivation();
  const thumbnail = useMediaThumbnail(thumbnailUrl, thumbnailRequest.isActive);
  const useOriginal = thumbnail.state === 'failed';
  const imageSrc = useOriginal ? image.href : thumbnail.imageSrc;
  const canOpen = image.href.trim() !== '';
  const displayName = derivePreviewFileName(image, index);
  const downloadName = deriveImageDownloadName(image, index);
  const downloadKey = messageCardMediaDownloadKey(image.id ?? image.href);

  const showImage = useOriginal ? loaded && !failed : thumbnail.state === 'loaded';
  const imageFailed = useOriginal && failed;
  const imageLoadingProps = {
    loading: 'lazy',
    decoding: 'async',
    fetchpriority: 'low',
  } as const;
  const handleOpenClick = (_event: MouseEvent<HTMLButtonElement>) => {
    blurActiveElement();
    onOpen(index);
  };

  return (
    <div className="message-card-thumbnail-shell relative inline-flex self-start">
      <ButtonBase
        ref={thumbnailRequest.targetRef}
        component="button"
        type="button"
        onClick={canOpen ? handleOpenClick : undefined}
        disabled={!canOpen}
        aria-label="Відкрити зображення"
        aria-current={selected ? 'true' : undefined}
        data-summary-selected={selected ? 'true' : undefined}
        data-picture-thumb-state={imageFailed ? 'failed' : showImage ? 'loaded' : 'loading'}
        data-picture-thumb-layout={variant}
        className={`message-card-thumbnail-control inline-flex h-full w-full min-w-full max-w-full flex-[0_0_100%] overflow-hidden rounded-md text-left text-inherit ring-1 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-action)] disabled:cursor-default disabled:text-[var(--color-text-disabled)] ${
          selected
            ? 'bg-[color-mix(in_srgb,var(--color-action)_14%,transparent)] ring-[var(--color-action)] shadow-sm'
            : 'bg-[color-mix(in_srgb,var(--color-action)_8%,transparent)] ring-[var(--color-divider)] shadow-none'
        } ${canOpen ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <div className="relative flex h-full w-full min-w-full max-w-full flex-[0_0_100%] items-center justify-center overflow-hidden">
          {!showImage && !imageFailed && (
            <Skeleton
              variant="rectangular"
              animation="wave"
              data-message-card-thumbnail-skeleton="true"
              className="absolute inset-0 z-0 !h-full !w-full"
            />
          )}
          {imageSrc !== null && imageSrc !== '' ? (
            <img
              src={imageSrc}
              alt="Зображення повідомлення"
              onLoad={() => {
                if (useOriginal) {
                  setLoaded(true);
                  setFailed(false);
                } else {
                  thumbnail.markLoaded();
                }
              }}
              onError={() => {
                if (useOriginal) {
                  setFailed(true);
                  setLoaded(false);
                } else {
                  thumbnail.markFailed();
                }
              }}
              {...imageLoadingProps}
              className={`pointer-events-none absolute inset-0 block h-full w-full object-cover transition-opacity duration-[120ms] ease-out ${
                showImage ? 'opacity-100' : 'opacity-0'
              }`}
            />
          ) : null}
          {imageFailed ? (
            <div className="absolute inset-0 z-[1] flex h-full w-full flex-col items-center justify-center gap-0.5 px-1.5 py-1 text-[var(--color-text-muted)]">
              <BrokenImageOutlinedIcon aria-hidden />
              <Typography variant="caption" component="span" className="text-center">
                Зображення недоступне
              </Typography>
            </div>
          ) : null}
        </div>
        <span className="sr-only">Зображення {index + 1}</span>
      </ButtonBase>
      <MessageMediaThumbnailDownloadLink
        href={image.href}
        displayName={displayName}
        downloadName={downloadName}
        downloadKey={downloadKey}
        isDownloadStarting={isDownloadStarting}
        onDownloadStart={onDownloadStart}
      />
    </div>
  );
}
