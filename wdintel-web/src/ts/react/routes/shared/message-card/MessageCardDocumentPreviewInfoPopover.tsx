import { Box, Popover, Stack, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import { formatSizeBytes } from './message-card-image-utils';
import type { MessageCardDocument } from './document-preview.types';
import { getMessageCardPreviewPopoverPaperSx } from './message-card-preview-shell';

export function MessageCardDocumentPreviewInfoPopover({
  open,
  anchorEl,
  onClose,
  document,
  fileName,
  fileSize,
}: {
  open: boolean;
  anchorEl: HTMLButtonElement | null;
  onClose: () => void;
  document: MessageCardDocument;
  fileName: string;
  fileSize: string | number | null | undefined;
}) {
  const theme = useTheme();
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
          <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
            URL
          </Typography>
          <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
            {document.href || '—'}
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
          <Typography variant="body2">{document.contentType?.trim() || '—'}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
            Розмір файлу
          </Typography>
          <Typography variant="body2">{normalizedFileSize}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
            Тип перегляду
          </Typography>
          <Typography variant="body2">{document.kind}</Typography>
        </Box>
      </Stack>
    </Popover>
  );
}
