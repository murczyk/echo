import { Box, Popover, Stack, Typography } from '@mui/material';
import type { VideoPreviewSource } from './message-card-video-utils';
import { formatVideoTime } from './message-card-video-utils';
import { formatSizeBytes } from './message-card-image-utils';

export function MessageCardVideoPreviewInfoPopover({
  open,
  anchorEl,
  onClose,
  video,
  duration,
}: {
  open: boolean;
  anchorEl: HTMLButtonElement | null;
  onClose: () => void;
  video: VideoPreviewSource;
  duration: number;
}) {
  const videoId = video.id?.trim() ?? '';
  const showVideoId = videoId !== '';
  const contentType = video.mimeType?.trim() || '—';
  const normalizedFileSize = video.sizeBytes != null ? formatSizeBytes(video.sizeBytes) : '—';
  const url = typeof video.source === 'string' ? video.source : 'Local File';

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
            backgroundColor: 'background.paper',
            color: 'text.primary',
          },
        },
      }}
    >
      <Stack spacing={1}>
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            URL
          </Typography>
          <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
            {url}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Файл
          </Typography>
          <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
            {video.name}
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
            Тривалість
          </Typography>
          <Typography variant="body2">{formatVideoTime(duration)}</Typography>
        </Box>
        {showVideoId ? (
          <Box>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              ID
            </Typography>
            <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
              {videoId}
            </Typography>
          </Box>
        ) : null}
      </Stack>
    </Popover>
  );
}
