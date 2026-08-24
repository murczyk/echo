import DescriptionIcon from '@mui/icons-material/Description';
import ImageIcon from '@mui/icons-material/Image';
import { Box, Collapse, FormControlLabel, Stack, Switch, Typography } from '@mui/material';

import { PowerAlert } from '../../components/PowerAlert';

const cardSx = {
  border: 1,
  borderColor: 'divider',
  borderRadius: 2,
  bgcolor: 'background.paper',
  p: { xs: 2, sm: 2.5 },
};

function MessageCardSummaryPreviewMock({ mediaSummaryEnabled }: { mediaSummaryEnabled: boolean }) {
  return (
    <Box
      data-message-card-mock="true"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      sx={{
        p: 1.5,
        borderRadius: 1.5,
        border: 1,
        borderColor: 'divider',
        bgcolor: (theme) =>
          theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.02)' : 'rgba(0, 0, 0, 0.02)',
        maxWidth: 420,
        cursor: 'default',
      }}
    >
      <Stack spacing={1}>
        {/* Header skeleton */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box
              sx={{
                width: 80,
                height: 9,
                borderRadius: 0.75,
                bgcolor: 'text.disabled',
                opacity: 0.45,
              }}
            />
            <Box
              sx={{
                width: 40,
                height: 9,
                borderRadius: 0.75,
                bgcolor: 'text.disabled',
                opacity: 0.25,
              }}
            />
          </Box>
          <Box
            sx={{
              width: 26,
              height: 9,
              borderRadius: 0.75,
              bgcolor: 'text.disabled',
              opacity: 0.25,
            }}
          />
        </Box>

        {/* Attachment skeleton */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box
            sx={{
              width: 22,
              height: 22,
              borderRadius: 0.75,
              bgcolor: 'primary.main',
              opacity: 0.85,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'primary.contrastText',
              flexShrink: 0,
            }}
          >
            <ImageIcon sx={{ fontSize: 14 }} />
          </Box>
          <Box
            sx={{
              width: 120,
              height: 9,
              borderRadius: 0.75,
              bgcolor: 'text.disabled',
              opacity: 0.35,
            }}
          />
        </Box>

        {/* Animated AI Summary skeleton */}
        <Collapse in={mediaSummaryEnabled} timeout={250} unmountOnExit={false}>
          <Box
            data-media-summary-mock="true"
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 0.75,
              p: 0.75,
              borderRadius: 1,
              bgcolor: (theme) =>
                theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.04)',
              borderLeft: 3,
              borderColor: 'primary.main',
            }}
          >
            <DescriptionIcon
              sx={{
                fontSize: 15,
                color: 'primary.main',
                flexShrink: 0,
                mt: 0.25,
              }}
            />
            <Stack spacing={0.5} sx={{ flex: 1, pt: 0.5 }}>
              <Box
                sx={{
                  width: '90%',
                  height: 7,
                  borderRadius: 0.75,
                  bgcolor: 'primary.main',
                  opacity: 0.55,
                }}
              />
              <Box
                sx={{
                  width: '60%',
                  height: 7,
                  borderRadius: 0.75,
                  bgcolor: 'primary.main',
                  opacity: 0.4,
                }}
              />
            </Stack>
          </Box>
        </Collapse>

        {/* Message body skeleton */}
        <Stack spacing={0.5} sx={{ pt: 0.25 }}>
          <Box
            sx={{
              width: '85%',
              height: 7,
              borderRadius: 0.75,
              bgcolor: 'text.disabled',
              opacity: 0.3,
            }}
          />
          <Box
            sx={{
              width: '50%',
              height: 7,
              borderRadius: 0.75,
              bgcolor: 'text.disabled',
              opacity: 0.25,
            }}
          />
        </Stack>

        {/* Tags skeleton */}
        <Box sx={{ display: 'flex', gap: 0.5, pt: 0.25 }}>
          <Box
            sx={{
              width: 32,
              height: 12,
              borderRadius: 0.5,
              bgcolor: 'text.disabled',
              opacity: 0.2,
            }}
          />
          <Box
            sx={{
              width: 28,
              height: 12,
              borderRadius: 0.5,
              bgcolor: 'text.disabled',
              opacity: 0.2,
            }}
          />
        </Box>
      </Stack>
    </Box>
  );
}

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
          Загальні
        </Typography>
        {prefsLoadError ? <PowerAlert severity="warning">{prefsLoadError}</PowerAlert> : null}
        {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}
        <Stack spacing={3} sx={{ minWidth: 0 }}>
          <Box sx={cardSx}>
            <Stack spacing={2}>
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
                  <Stack spacing={1.5} sx={{ pt: 0.25 }}>
                    <Stack spacing={0.75}>
                      <Typography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.35 }}>
                        Стислий опис файлів у картках
                      </Typography>
                      <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
                        Відображати блок стислого опису для зображень та документів у картках
                        повідомлень стрічки.
                      </Typography>
                    </Stack>
                    <MessageCardSummaryPreviewMock mediaSummaryEnabled={mediaSummaryEnabled} />
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
