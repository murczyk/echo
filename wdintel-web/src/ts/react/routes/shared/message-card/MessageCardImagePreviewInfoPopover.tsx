import { Box, Popover, Stack, Typography } from '@mui/material';

import { formatSizeBytes, type MessageCardImage } from './message-card-image-utils';

type StageSize = {
  width: number;
  height: number;
};

export function MessageCardImagePreviewInfoPopover({
  open,
  anchorEl,
  onClose,
  image,
  fileName,
  fileSize,
  imageSize,
}: {
  open: boolean;
  anchorEl: HTMLButtonElement | null;
  onClose: () => void;
  image: MessageCardImage;
  fileName: string;
  fileSize: string | number | null | undefined;
  imageSize: StageSize | null;
}) {
  const imageId = image.id?.trim() ?? '';
  const showImageId = imageId !== '';
  const contentType = image.contentType?.trim() || '—';
  const normalizedFileSize = typeof fileSize === 'string' ? fileSize : formatSizeBytes(fileSize);

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      slotProps={{
        paper: {
          sx: {
            p: 1.5,
            minWidth: 280,
            maxWidth: 360,
            backgroundColor: '#111821',
            color: '#f4f7fb',
          },
        },
      }}
    >
      <Stack spacing={1}>
        <Box>
          <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
            URL
          </Typography>
          <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
            {image.href || '—'}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
            Файл
          </Typography>
          <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
            {fileName}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
            Тип
          </Typography>
          <Typography variant="body2">{contentType}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
            Розмір файлу
          </Typography>
          <Typography variant="body2">{normalizedFileSize}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
            Розмір зображення
          </Typography>
          <Typography variant="body2">{imageSize != null ? `${imageSize.width} × ${imageSize.height}` : '—'}</Typography>
        </Box>
        {showImageId ? (
          <Box>
            <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
              ID
            </Typography>
            <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
              {imageId}
            </Typography>
          </Box>
        ) : null}
      </Stack>
    </Popover>
  );
}
