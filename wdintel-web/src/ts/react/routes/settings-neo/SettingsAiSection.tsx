import { Box, FormControlLabel, Stack, Switch, Typography } from '@mui/material';

import { PowerAlert } from '../../components/PowerAlert';

const cardSx = {
  border: 1,
  borderColor: 'divider',
  borderRadius: 2,
  bgcolor: 'background.paper',
  p: { xs: 2, sm: 2.5 },
};

export type SettingsAiSectionProps = {
  loadInProgress: boolean;
  prefsLoadError: string | null;
  saveError: string | null;
  mediaSummaryEnabled: boolean;
  onMediaSummaryEnabledChange: (value: boolean) => void;
};

export function SettingsAiSection({
  loadInProgress,
  prefsLoadError,
  saveError,
  mediaSummaryEnabled,
  onMediaSummaryEnabledChange,
}: SettingsAiSectionProps) {
  return (
    <Box
      id="settings-neo-panel-ai"
      role="tabpanel"
      aria-labelledby="settings-neo-tab-ai"
      sx={{ p: 3 }}
    >
      <Stack spacing={3} sx={{ maxWidth: 960 }}>
        <Typography
          component="h2"
          variant="h6"
          sx={{ fontWeight: 700, lineHeight: 1.25, color: 'text.primary' }}
        >
          Штучний інтелект
        </Typography>
        {prefsLoadError ? <PowerAlert severity="warning">{prefsLoadError}</PowerAlert> : null}
        {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}
        <Stack spacing={3} sx={{ minWidth: 0 }}>
          <Box sx={cardSx}>
            <Stack spacing={1.5}>
              <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 0.8 }}>
                Стислий опис файлів
              </Typography>
              <FormControlLabel
                sx={{
                  alignItems: 'flex-start',
                  m: 0,
                  gap: 1.5,
                  '& .MuiFormControlLabel-label': { width: '100%' },
                }}
                control={
                  <Switch
                    checked={mediaSummaryEnabled}
                    onChange={(_, checked) => onMediaSummaryEnabledChange(checked)}
                    disabled={loadInProgress}
                  />
                }
                label={
                  <Stack spacing={0.75} sx={{ pt: 0.25 }}>
                    <Typography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.35 }}>
                      Стислий опис файлів у картках
                    </Typography>
                    <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
                      Відображати блок стислого опису для зображень та документів у картках
                      повідомлень стрічки.
                    </Typography>
                  </Stack>
                }
              />
            </Stack>
          </Box>
        </Stack>
      </Stack>
    </Box>
  );
}
