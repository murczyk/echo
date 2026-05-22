import { Box, FormControlLabel, Stack, Switch, Typography } from '@mui/material';
import { useEffect, useState } from 'react';

import {
  getBrowserNotificationPermission,
  getStoredDutyNotificationSettingsForFeed,
  requestBrowserNotificationPermission,
  resumeDutyNotificationAudioFromUserGesture,
  setStoredDutyNotificationSettingsForFeed,
} from './notifications';

export type FeedNotificationPanelProps = {
  feedId: string;
  /** Bump when settings are written outside the panel (e.g. header bell) so switches reload from storage. */
  storageSyncKey?: number;
  /** After settings are saved to localStorage (from switches or external sync). */
  onPersisted?: () => void;
};

export function FeedNotificationPanel({ feedId, storageSyncKey = 0, onPersisted }: FeedNotificationPanelProps) {
  const [dutyNotificationSettings, setDutyNotificationSettings] = useState(() =>
    getStoredDutyNotificationSettingsForFeed(feedId),
  );
  const [browserPermission, setBrowserPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    getBrowserNotificationPermission(),
  );

  useEffect(() => {
    const next = getStoredDutyNotificationSettingsForFeed(feedId);
    setDutyNotificationSettings((prev) =>
      prev.soundEnabled === next.soundEnabled && prev.browserEnabled === next.browserEnabled ? prev : next,
    );
    setBrowserPermission(getBrowserNotificationPermission());
  }, [feedId, storageSyncKey]);

  useEffect(() => {
    setStoredDutyNotificationSettingsForFeed(feedId, dutyNotificationSettings);
    onPersisted?.();
  }, [feedId, dutyNotificationSettings, onPersisted]);

  return (
    <Box
      sx={{
        borderTop: '1px solid rgba(148, 163, 184, 0.28)',
        bgcolor: 'background.paper',
        width: '100%',
        maxWidth: '100%',
        px: { xs: 2, sm: 2.5 },
        py: 2,
      }}
    >
      <Stack spacing={1.5}>
        <Stack spacing={1.5}>
          <FormControlLabel
            sx={{ alignItems: 'center', m: 0, gap: 1.5 }}
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
            label={<Typography variant="body1">Звукове сповіщення</Typography>}
          />
          <FormControlLabel
            sx={{ alignItems: 'center', m: 0, gap: 1.5 }}
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
            label={<Typography variant="body1">Браузерне сповіщення</Typography>}
          />
          {browserPermission === 'denied' ? (
            <Typography variant="caption" color="error">
              Браузерні сповіщення вимкнені у налаштуваннях браузера.
            </Typography>
          ) : null}
          {browserPermission === 'unsupported' ? (
            <Typography variant="caption" color="text.secondary">
              Ваш браузер не підтримує браузерні сповіщення.
            </Typography>
          ) : null}
        </Stack>
      </Stack>
    </Box>
  );
}
