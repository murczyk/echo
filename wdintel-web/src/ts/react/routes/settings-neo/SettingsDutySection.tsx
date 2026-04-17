import { Box, CircularProgress, FormControlLabel, Stack, Switch, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useEffect, useState, type FormEvent } from 'react';

import { PowerButton } from '../../components/PowerButton';
import {
  getBrowserNotificationPermission,
  getStoredDutyNotificationSettings,
  requestBrowserNotificationPermission,
  resumeDutyNotificationAudioFromUserGesture,
  setStoredDutyNotificationSettings,
} from '../rer-duty-neo/notifications';
import type { TagsLayoutVariant } from '../rer-duty-neo/utils';
import { PowerAlert } from '../../components/PowerAlert';

export type SettingsDutySectionProps = {
  loadInProgress: boolean;
  prefsLoadError: string | null;
  saveError: string | null;
  saveSuccess: string | null;
  tagsLayout: TagsLayoutVariant;
  onTagsLayoutChange: (layout: TagsLayoutVariant) => void;
  /** When true, duty feed does not auto-scroll / follow new messages. */
  disableAutoScroll: boolean;
  onDisableAutoScrollChange: (value: boolean) => void;
  onSave: (event?: FormEvent) => void | Promise<void>;
  isDirty: boolean;
  saveInProgress: boolean;
};

export function SettingsDutySection({
  loadInProgress,
  prefsLoadError,
  saveError,
  saveSuccess,
  tagsLayout,
  onTagsLayoutChange,
  disableAutoScroll,
  onDisableAutoScrollChange,
  onSave,
  isDirty,
  saveInProgress,
}: SettingsDutySectionProps) {
  const [dutyNotificationSettings, setDutyNotificationSettings] = useState(() => getStoredDutyNotificationSettings());
  const [browserPermission, setBrowserPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    getBrowserNotificationPermission(),
  );

  useEffect(() => {
    setStoredDutyNotificationSettings(dutyNotificationSettings);
  }, [dutyNotificationSettings]);

  return (
    <Box id="settings-neo-panel-duty" role="tabpanel" aria-labelledby="settings-neo-tab-duty" sx={{ p: 3 }}>
      <Stack spacing={2} sx={{ maxWidth: 960 }}>
        <Typography
          component="h2"
          variant="subtitle1"
          sx={{
            fontWeight: 600,
            lineHeight: 1.45,
            color: 'text.primary',
          }}
        >
          Оперативний
        </Typography>
        {prefsLoadError ? <PowerAlert severity="warning">{prefsLoadError}</PowerAlert> : null}
        {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}
        <Box component="form" onSubmit={onSave} noValidate>
          <Stack spacing={2}>
            <Box className="flex flex-col gap-0.5">
              <Typography variant="caption" sx={{ fontSize: 12, color: 'text.secondary' }}>
                вигляд тегів у стрічці
              </Typography>
              <Box className="flex flex-wrap items-center gap-2">
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
                    flexShrink: 0,
                    '& .MuiToggleButton-root': { textTransform: 'none', fontSize: 12 },
                  }}
                >
                  <ToggleButton value="full">повний</ToggleButton>
                  <ToggleButton value="compact">компактний</ToggleButton>
                  <ToggleButton value="hidden">не показувати</ToggleButton>
                </ToggleButtonGroup>
              </Box>
            </Box>
            <FormControlLabel
              control={
                <Switch
                  // inverted switch to not start option name with Disable (avoid on = disable, off = enable)
                  checked={!disableAutoScroll}
                  onChange={(_, checked) => onDisableAutoScrollChange(!checked)}
                  disabled={loadInProgress}
                />
              }
              label={
                <Typography variant="body2" component="span" display="block">
                  Автоматична прокрутка стрічки Оперативного{' '}
                </Typography>
              }
            />

            <Typography variant="caption" className="mt-0">
              Якщо перемикач увімкнено, автопрокрутка працює лише внизу стрічки (з невеликим зазором); якщо прокрутити
              вгору — вона зупиняється і відновлюється після повернення вниз.
            </Typography>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 1.5, pt: 1 }}>
              {saveSuccess ? (
                <Typography variant="caption" color="success.main" role="status">
                  {saveSuccess}
                </Typography>
              ) : null}
              <PowerButton
                variant="contained"
                type="submit"
                disabled={saveInProgress || !isDirty || loadInProgress}
                startIcon={saveInProgress ? <CircularProgress size={18} /> : undefined}
                sx={{ fontWeight: 500 }}
              >
                зберегти
              </PowerButton>
            </Box>
          </Stack>
          <Stack spacing={2} sx={{ maxWidth: 560 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Нотифікації про нові повідомлення
            </Typography>
            <FormControlLabel
              control={
                <Switch
                  checked={dutyNotificationSettings.soundEnabled}
                  onChange={(_, checked) => {
                    if (checked) {
                      resumeDutyNotificationAudioFromUserGesture();
                    }
                    setDutyNotificationSettings((prev) => ({ ...prev, soundEnabled: checked }));
                  }}
                />
              }
              label="Звукова нотифікація"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={dutyNotificationSettings.browserEnabled}
                  onChange={async (_, checked) => {
                    if (checked) {
                      const permission = await requestBrowserNotificationPermission();
                      setBrowserPermission(permission);
                      if (permission !== 'granted') {
                        setDutyNotificationSettings((prev) => ({ ...prev, browserEnabled: false }));
                        return;
                      }
                    }
                    setDutyNotificationSettings((prev) => ({ ...prev, browserEnabled: checked }));
                  }}
                />
              }
              label="Браузерна нотифікація"
            />
            {browserPermission === 'denied' ? (
              <Typography variant="caption" color="error">
                Браузерні нотифікації вимкнені у налаштуваннях браузера.
              </Typography>
            ) : null}
            {browserPermission === 'unsupported' ? (
              <Typography variant="caption" color="text.secondary">
                Ваш браузер не підтримує browser-нотифікації.
              </Typography>
            ) : null}
          </Stack>
        </Box>
      </Stack>
    </Box>
  );
}
