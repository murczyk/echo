import { Box } from '@mui/material';

import type { MessageCardImage } from './message-card-image-utils';
import { MessageCardImageThumb } from './MessageCardImageThumb';

export function MessageCardImageList({
  images,
  onOpen,
}: {
  images: MessageCardImage[];
  onOpen: (index: number) => void;
}) {
  const imageCount = images.length;

  if (imageCount === 0) return null;

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
            variant={imageCount === 1 ? 'single' : 'multi'}
            onOpen={onOpen}
          />
        ))}
      </Box>
    </Box>
  );
}
