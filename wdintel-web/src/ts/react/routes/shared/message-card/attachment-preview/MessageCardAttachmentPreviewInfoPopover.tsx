import { Box, Chip, Divider, Popover, Stack, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import { getAttachmentPreviewPopoverPaperSx } from './message-card-attachment-preview';

export type AttachmentPreviewInfoField = {
  label: string;
  value: string;
};

export type AttachmentPreviewInfoSection = {
  title: string;
  fields: AttachmentPreviewInfoField[];
  status?: {
    label: string;
    severity: 'warning' | 'error';
  };
};

export function MessageCardAttachmentPreviewInfoPopover({
  open,
  anchorEl,
  fields,
  sections = [],
  onClose,
}: {
  open: boolean;
  anchorEl: HTMLButtonElement | null;
  fields: AttachmentPreviewInfoField[];
  sections?: AttachmentPreviewInfoSection[];
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
        {sections.map((section) => (
          <Stack key={section.title} spacing={1}>
            <Divider />
            <Typography variant="subtitle2">{section.title}</Typography>
            {section.status == null ? null : (
              <Chip
                size="small"
                variant="outlined"
                color={section.status.severity}
                label={section.status.label}
                sx={{ alignSelf: 'flex-start', opacity: 0.72 }}
              />
            )}
            {section.fields.map((field) => (
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
        ))}
      </Stack>
    </Popover>
  );
}
