import { Box, Popover, Stack, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import { getAttachmentPreviewPopoverPaperSx } from './message-card-attachment-preview';

export type AttachmentPreviewInfoField = {
  label: string;
  value: string;
};

export function MessageCardAttachmentPreviewInfoPopover({
  open,
  anchorEl,
  fields,
  onClose,
}: {
  open: boolean;
  anchorEl: HTMLButtonElement | null;
  fields: AttachmentPreviewInfoField[];
  onClose: () => void;
}) {
  const theme = useTheme();

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      slotProps={{ paper: { sx: getAttachmentPreviewPopoverPaperSx(theme) } }}
    >
      <Stack spacing={1}>
        {fields.map((field) => (
          <Box key={field.label}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {field.label}
            </Typography>
            <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
              {field.value}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Popover>
  );
}
