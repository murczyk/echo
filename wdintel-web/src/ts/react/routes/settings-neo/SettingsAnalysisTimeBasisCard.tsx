import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { MessageTimeBasis } from '../../services/api/user-settings';
import { isPresent } from '../../utils/misc';

export function SettingsAnalysisTimeBasisCard({
  messageSortBy,
  onMessageSortByChange,
  loadInProgress,
}: {
  messageSortBy: MessageTimeBasis;
  onMessageSortByChange: (value: MessageTimeBasis) => void;
  loadInProgress: boolean;
}) {
  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        bgcolor: 'background.paper',
        p: { xs: 2, sm: 2.5 },
      }}
    >
      <Stack spacing={1}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Сортування:
        </Typography>
        <Box>
          <ToggleButtonGroup
            value={messageSortBy}
            exclusive
            color="primary"
            onChange={(_, value: MessageTimeBasis | null) => {
              if (isPresent(value)) onMessageSortByChange(value);
            }}
            size="small"
            disabled={loadInProgress}
            aria-label="Сортування повідомлень"
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
            <ToggleButton value="interception">За датою перехоплення</ToggleButton>
            <ToggleButton value="creation">За датою створення</ToggleButton>
          </ToggleButtonGroup>
        </Box>
      </Stack>
    </Box>
  );
}
