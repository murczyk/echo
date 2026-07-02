import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { isPresent } from '../../utils/misc';

import { PowerAlert } from '../../components/PowerAlert';
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
  description?: ReactNode;
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
          {description ? <Box sx={{ color: 'text.secondary' }}>{description}</Box> : null}
        </Stack>
        <ToggleButtonGroup
          value={tagsLayout}
          exclusive
          color="primary"
          onChange={(_, v: TagsLayoutVariant | null) => {
            if (isPresent(v)) onTagsLayoutChange(v);
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
          <ToggleButton value="compact">щільний</ToggleButton>
          <ToggleButton value="hidden">без тегів</ToggleButton>
        </ToggleButtonGroup>
        {note ? (
          <PowerAlert
            severity="info"
            sx={{
              mt: 0.25,
              alignItems: 'center',
              '& .MuiAlert-message': {
                py: 0,
                display: 'flex',
                alignItems: 'center',
              },
              '& .MuiAlert-icon': {
                py: 0,
                alignItems: 'center',
              },
            }}
          >
            <Typography variant="body2" sx={{ lineHeight: 1.45 }}>
              {note}
            </Typography>
          </PowerAlert>
        ) : null}
      </Stack>
    </Box>
  );
}
