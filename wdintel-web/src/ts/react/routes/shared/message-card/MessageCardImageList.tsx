import type { MessageMediaInfo } from '../../../../../Bindings';
import type { ReactNode } from 'react';
import type { MessageCardImage } from './message-card-image-utils';
import { MessageCardImageThumb } from './MessageCardImageThumb';
import { MessageCardVideoThumb } from './MessageCardVideoThumb';

export function MessageCardImageList({
  images,
  videos = [],
  selectedImageIndex = null,
  selectedVideoIndex = null,
  trailingContent,
  onOpen,
  onOpenVideo,
}: {
  images: MessageCardImage[];
  videos?: MessageMediaInfo[];
  selectedImageIndex?: number | null;
  selectedVideoIndex?: number | null;
  trailingContent?: ReactNode;
  onOpen: (index: number) => void;
  onOpenVideo?: (index: number) => void;
}) {
  const imageCount = images.length;
  const videoCount = videos.length;

  if (imageCount === 0 && videoCount === 0 && trailingContent == null) return null;

  return (
    <div className="message-card-gallery">
      {images.map((image, index) => (
        <MessageCardImageThumb
          key={`${image.href}-${index}`}
          image={image}
          index={index}
          variant={imageCount === 1 && videoCount === 0 ? 'single' : 'multi'}
          selected={selectedImageIndex === index}
          onOpen={onOpen}
        />
      ))}
      {videos.map((attachment, index) => (
        <MessageCardVideoThumb
          key={attachment.id ?? `${attachment.href}-${index}`}
          attachment={attachment}
          index={index}
          selected={selectedVideoIndex === index}
          onOpen={onOpenVideo ?? (() => {})}
        />
      ))}
      {trailingContent}
    </div>
  );
}
