import { Box, FormControlLabel, Stack, Switch, Typography } from '@mui/material';

export type SettingsAudioTranscriptionCardProps = {
  collapsedByDefault: boolean;
  loadInProgress: boolean;
  onCollapsedByDefaultChange: (value: boolean) => void;
};

export function SettingsAudioTranscriptionCard({
  collapsedByDefault,
  loadInProgress,
  onCollapsedByDefaultChange,
}: SettingsAudioTranscriptionCardProps) {
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
      <Stack spacing={1.5}>
        <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 0.8 }}>
          Транскрипція аудіо
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
              checked={collapsedByDefault}
              onChange={(_, checked) => onCollapsedByDefaultChange(checked)}
              disabled={loadInProgress}
            />
          }
          label={
            <Stack spacing={0.75} sx={{ pt: 0.25 }}>
              <Typography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.35 }}>
                Згортати транскрипцію за замовчуванням
              </Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
                Замість тексту показується кнопка, якою можна відкрити транскрипцію.
              </Typography>
            </Stack>
          }
        />
      </Stack>
    </Box>
  );
}
