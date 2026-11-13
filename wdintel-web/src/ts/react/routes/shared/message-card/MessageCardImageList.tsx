import type { MessageMediaInfo } from '../../../../../Bindings';
import type { ReactNode } from 'react';
import type { MessageCardDownloadGuardProps } from './MessageCardMedia';
import type { MessageCardImage } from './message-card-image-utils';
import { MessageCardImageThumb } from './MessageCardImageThumb';
import { MessageCardVideoThumb } from './MessageCardVideoThumb';

export function MessageCardImageList({
  images,
  videos = [],
  attachmentOrder = [],
  selectedImageIndex = null,
  selectedVideoIndex = null,
  trailingContent,
  onOpen,
  onOpenVideo,
  isDownloadStarting,
  onDownloadStart,
}: {
  images: MessageCardImage[];
  videos?: MessageMediaInfo[];
  attachmentOrder?: MessageMediaInfo[];
  selectedImageIndex?: number | null;
  selectedVideoIndex?: number | null;
  trailingContent?: ReactNode;
  onOpen: (index: number) => void;
  onOpenVideo?: (index: number) => void;
} & MessageCardDownloadGuardProps) {
  const imageCount = images.length;
  const videoCount = videos.length;

  if (imageCount === 0 && videoCount === 0 && trailingContent == null) return null;

  const positions = new Map(
    attachmentOrder.some((media) => media.orderF64 != null)
      ? attachmentOrder.map((media, index) => [media.id, index] as const)
      : [],
  );
  const rank = (key: string | number | null) =>
    positions.get(String(key)) ?? Number.MAX_SAFE_INTEGER;
  return (
    <div className="message-card-gallery">
      {[
        ...images.map((image, index) => (
          <MessageCardImageThumb
            key={image.id ?? `${image.href}-${index}`}
            image={image}
            index={index}
            variant={imageCount === 1 && videoCount === 0 ? 'single' : 'multi'}
            selected={selectedImageIndex === index}
            onOpen={onOpen}
            isDownloadStarting={isDownloadStarting}
            onDownloadStart={onDownloadStart}
          />
        )),
        ...videos.map((attachment, index) => (
          <MessageCardVideoThumb
            key={attachment.id ?? `${attachment.href}-${index}`}
            attachment={attachment}
            index={index}
            selected={selectedVideoIndex === index}
            onOpen={onOpenVideo ?? (() => {})}
            isDownloadStarting={isDownloadStarting}
            onDownloadStart={onDownloadStart}
          />
        )),
      ].sort((a, b) => rank(a.key) - rank(b.key))}
      {trailingContent}
    </div>
  );
}
