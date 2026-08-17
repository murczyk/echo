import { Box } from '@mui/material';

import type { MessageMediaInfo } from '../../../../../Bindings';
import type { MessageCardImage } from './message-card-image-utils';
import { MessageCardMediaSummary } from './attachment-preview/MediaSummaryPreview';
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
        {images.map((image, index) => {
          const single = imageCount === 1 && videoCount === 0;
          return (
            <Box
              key={`${image.href}-${index}`}
              sx={{
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                maxWidth: image.summary == null ? 150 : single ? 460 : 300,
              }}
            >
              <MessageCardImageThumb
                image={image}
                index={index}
                variant={single ? 'single' : 'multi'}
                onOpen={onOpen}
              />
              <MessageCardMediaSummary mediaId={image.id} status={image.summary} />
            </Box>
          );
        })}
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
