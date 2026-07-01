import { Box, Popover, Stack, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import { formatSizeBytes, type MessageCardImage } from './message-card-image-utils';
import { getMessageCardPreviewPopoverPaperSx } from './message-card-preview-shell';

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
  const theme = useTheme();
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
          sx: getMessageCardPreviewPopoverPaperSx(theme),
        },
      }}
    >
      <Stack spacing={1}>
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            URL
          </Typography>
          <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
            {image.href || '—'}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Файл
          </Typography>
          <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
            {fileName}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Тип
          </Typography>
          <Typography variant="body2">{contentType}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Розмір файлу
          </Typography>
          <Typography variant="body2">{normalizedFileSize}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Розмір зображення
          </Typography>
          <Typography variant="body2">{imageSize != null ? `${imageSize.width} × ${imageSize.height}` : '—'}</Typography>
        </Box>
        {showImageId ? (
          <Box>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
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
