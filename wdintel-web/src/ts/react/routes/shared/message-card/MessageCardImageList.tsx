import { Box } from '@mui/material';

import type { MessageMediaInfo } from '../../../../../Bindings';
import type { MessageCardImage } from './message-card-image-utils';
import { MessageCardImageThumb } from './MessageCardImageThumb';
import { MessageCardVideoThumb } from './MessageCardVideoThumb';

export function MessageCardImageList({
  images,
  videos = [],
  onOpen,
  onOpenVideo,
}: {
  images: MessageCardImage[];
  videos?: MessageMediaInfo[];
  onOpen: (index: number) => void;
  onOpenVideo?: (index: number) => void;
}) {
  const imageCount = images.length;
  const videoCount = videos.length;

  if (imageCount === 0 && videoCount === 0) return null;

  return (
    <Box className="m-1" sx={{ maxWidth: '100%' }}>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 1,
          alignItems: 'flex-start',
          justifyContent: 'flex-start',
          maxWidth: '100%',
        }}
      >
        {images.map((image, index) => (
          <MessageCardImageThumb
            key={`${image.href}-${index}`}
            image={image}
            index={index}
            variant={imageCount === 1 && videoCount === 0 ? 'single' : 'multi'}
            onOpen={onOpen}
          />
        ))}
        {videos.map((attachment, index) => (
          <MessageCardVideoThumb
            key={attachment.id ?? `${attachment.href}-${index}`}
            attachment={attachment}
            index={index}
            onOpen={onOpenVideo ?? (() => {})}
          />
        ))}
      </Box>
    </Box>
  );
}
