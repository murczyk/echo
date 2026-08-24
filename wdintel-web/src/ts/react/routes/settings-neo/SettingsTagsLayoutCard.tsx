import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { isPresent } from '../../utils/misc';

import { PowerAlert } from '../../components/PowerAlert';
import type { MessageTextPreviewLineLimit } from '../../services/api/user-settings';
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
  messageTextPreviewLines: MessageTextPreviewLineLimit;
  onMessageTextPreviewLinesChange: (value: MessageTextPreviewLineLimit) => void;
  loadInProgress: boolean;
};

export function SettingsTagsLayoutCard({
  title,
  description,
  note,
  tagsLayout,
  onTagsLayoutChange,
  messageTextPreviewLines,
  onMessageTextPreviewLinesChange,
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
          <ToggleButton value="full">Повний</ToggleButton>
          <ToggleButton value="compact">Щільний</ToggleButton>
          <ToggleButton value="hidden">Без тегів</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Скорочення тексту:
        </Typography>
        <ToggleButtonGroup
          value={messageTextPreviewLines === null ? 'off' : String(messageTextPreviewLines)}
          exclusive
          color="primary"
          onChange={(_, value: '20' | '40' | 'off' | null) => {
            if (value === null) return;

            onMessageTextPreviewLinesChange(value === 'off' ? null : (Number(value) as 20 | 40));
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
          <ToggleButton value="20">20 рядків</ToggleButton>
          <ToggleButton value="40">40 рядків</ToggleButton>
          <ToggleButton value="off">Без скорочення</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Визначає, коли з’являється кнопка «Показати більше».
        </Typography>
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
