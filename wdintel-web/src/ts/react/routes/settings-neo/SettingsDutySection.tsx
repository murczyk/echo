import { Box, FormControlLabel, Stack, Switch, Typography } from '@mui/material';

import { PowerAlert } from '../../components/PowerAlert';
import type { TagsLayoutVariant } from '../rer-duty-neo/utils';
import { SettingsAudioTranscriptionCard } from './SettingsAudioTranscriptionCard';
import { SettingsSharedTagsLayoutCard } from './SettingsSharedTagsLayoutCard';

const cardSx = {
  border: 1,
  borderColor: 'divider',
  borderRadius: 2,
  bgcolor: 'background.paper',
  p: { xs: 2, sm: 2.5 },
};

export type SettingsDutySectionProps = {
  loadInProgress: boolean;
  prefsLoadError: string | null;
  saveError: string | null;
  tagsLayout: TagsLayoutVariant;
  onTagsLayoutChange: (layout: TagsLayoutVariant) => void;
  /** When true, duty feed does not auto-scroll / follow new messages. */
  disableAutoScroll: boolean;
  onDisableAutoScrollChange: (value: boolean) => void;
  audioTranscriptionCollapsed: boolean;
  onAudioTranscriptionCollapsedChange: (value: boolean) => void;
  showAudioTranscriptionSettings: boolean;
  showClassicDutySetting: boolean;
  showClassicDuty: boolean;
  onShowClassicDutyChange: (value: boolean) => void;
};

export function SettingsDutySection({
  loadInProgress,
  prefsLoadError,
  saveError,
  tagsLayout,
  onTagsLayoutChange,
  disableAutoScroll,
  onDisableAutoScrollChange,
  audioTranscriptionCollapsed,
  onAudioTranscriptionCollapsedChange,
  showAudioTranscriptionSettings,
  showClassicDutySetting,
  showClassicDuty,
  onShowClassicDutyChange,
}: SettingsDutySectionProps) {
  return (
    <Box
      id="settings-neo-panel-duty"
      role="tabpanel"
      aria-labelledby="settings-neo-tab-duty"
      sx={{ p: 3 }}
    >
      <Stack spacing={3} sx={{ maxWidth: 960 }}>
        <Typography
          component="h2"
          variant="h6"
          sx={{ fontWeight: 700, lineHeight: 1.25, color: 'text.primary' }}
        >
          Оперативний
        </Typography>
        {prefsLoadError ? <PowerAlert severity="warning">{prefsLoadError}</PowerAlert> : null}
        {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}
        <Stack spacing={3} sx={{ minWidth: 0 }}>
          {showClassicDutySetting ? (
            <Box sx={cardSx}>
              <FormControlLabel
                sx={{ m: 0 }}
                control={
                  <Switch
                    checked={showClassicDuty}
                    onChange={(_, checked) => onShowClassicDutyChange(checked)}
                    disabled={loadInProgress}
                  />
                }
                label="Показувати класичний оперативний"
              />
            </Box>
          ) : null}

          <SettingsSharedTagsLayoutCard
            tagsLayout={tagsLayout}
            onTagsLayoutChange={onTagsLayoutChange}
            loadInProgress={loadInProgress}
          />

          {showAudioTranscriptionSettings ? (
            <SettingsAudioTranscriptionCard
              collapsedByDefault={audioTranscriptionCollapsed}
              loadInProgress={loadInProgress}
              onCollapsedByDefaultChange={onAudioTranscriptionCollapsedChange}
            />
          ) : null}

          <Box sx={cardSx}>
            <Stack spacing={1.5}>
              <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 0.8 }}>
                Стрічки
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
                    // inverted switch to avoid a label that starts with "Disable"
                    checked={!disableAutoScroll}
                    onChange={(_, checked) => onDisableAutoScrollChange(!checked)}
                    disabled={loadInProgress}
                  />
                }
                label={
                  <Stack spacing={0.75} sx={{ pt: 0.25 }}>
                    <Typography variant="body1" sx={{ fontWeight: 600, lineHeight: 1.35 }}>
                      Автоматична прокрутка стрічок Оперативного
                    </Typography>
                    <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
                      Якщо перемикач увімкнено, автопрокрутка працює лише внизу стрічки з невеликим
                      зазором. Якщо прокрутити вгору, вона зупиняється і відновлюється після
                      повернення вниз.
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
