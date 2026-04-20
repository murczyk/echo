import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';

import type { TagsLayoutVariant } from '../rer-duty-neo/utils';

const cardSx = {
  border: 1,
  borderColor: 'divider',
  borderRadius: 2,
  bgcolor: 'background.paper',
  p: { xs: 2, sm: 2.5 },
};

export type SettingsTagsLayoutCardProps = {
  title: string;
  description: string;
  note?: string;
  tagsLayout: TagsLayoutVariant;
  onTagsLayoutChange: (layout: TagsLayoutVariant) => void;
  loadInProgress: boolean;
};

export function SettingsTagsLayoutCard({
  title,
  description,
  note,
  tagsLayout,
  onTagsLayoutChange,
  loadInProgress,
}: SettingsTagsLayoutCardProps) {
  return (
    <Box sx={cardSx}>
      <Stack spacing={1.5}>
        <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 0.8 }}>
          {title}
        </Typography>
        <Stack spacing={0.5}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {description}
          </Typography>
          {note ? (
            <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.5 }}>
              {note}
            </Typography>
          ) : null}
        </Stack>
        <ToggleButtonGroup
          value={tagsLayout}
          exclusive
          color="primary"
          onChange={(_, v: TagsLayoutVariant | null) => {
            if (v != null) onTagsLayoutChange(v);
          }}
          size="small"
          disabled={loadInProgress}
          sx={{
            flexWrap: 'wrap',
            '& .MuiToggleButton-root': {
              textTransform: 'none',
              fontSize: 14,
              px: 2,
              py: 1,
              whiteSpace: 'nowrap',
            },
          }}
        >
          <ToggleButton value="full">повний</ToggleButton>
          <ToggleButton value="compact">компактний</ToggleButton>
          <ToggleButton value="hidden">не показувати</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
    </Box>
  );
}
