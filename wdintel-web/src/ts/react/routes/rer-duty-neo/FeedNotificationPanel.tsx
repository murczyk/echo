import { Box, Button, FormControlLabel, Stack, Switch, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';

import {
  DutyBrowserNotificationStatus,
  DutySoundStatus,
  getBrowserNotificationStatus,
  getDutySoundStatus,
  getLastSuccessfulDutyCountCheck,
  getStoredDutyNotificationSettingsForFeed,
  requestBrowserNotificationPermission,
  playNotificationSound,
  resumeDutyNotificationAudioFromUserGesture,
  setStoredDutyNotificationSettingsForFeed,
  testBrowserNotification,
} from './notifications';

export type FeedNotificationPanelProps = {
  feedId: string;
  /** Bump when settings are written outside the panel (e.g. header bell) so switches reload from storage. */
  storageSyncKey?: number;
  /** After settings are saved to localStorage (from switches or external sync). */
  onPersisted?: () => void;
  storageError: string | null;
  onStorageErrorChange: (error: string | null) => void;
  onNotificationStatusChanged: () => void;
};

export function FeedNotificationPanel({
  feedId,
  storageSyncKey = 0,
  onPersisted,
  storageError,
  onStorageErrorChange,
  onNotificationStatusChanged,
}: FeedNotificationPanelProps) {
  const [dutyNotificationSettings, setDutyNotificationSettings] = useState(() =>
    getStoredDutyNotificationSettingsForFeed(feedId),
  );
  const [soundStatus, setSoundStatus] = useState(getDutySoundStatus);
  const [browserStatus, setBrowserStatus] = useState(getBrowserNotificationStatus);
  const [lastSuccessfulPoll, setLastSuccessfulPoll] = useState<Date | null>(() =>
    getLastSuccessfulDutyCountCheck(feedId),
  );
  const refreshStatus = useCallback(() => {
    setSoundStatus(getDutySoundStatus());
    setBrowserStatus(getBrowserNotificationStatus());
  }, []);

  useEffect(() => {
    const next = getStoredDutyNotificationSettingsForFeed(feedId);
    setDutyNotificationSettings((prev) =>
      prev.soundEnabled === next.soundEnabled && prev.browserEnabled === next.browserEnabled
        ? prev
        : next,
    );
    refreshStatus();
    setLastSuccessfulPoll(getLastSuccessfulDutyCountCheck(feedId));
  }, [feedId, storageSyncKey, refreshStatus]);

  useEffect(() => {
    const refresh = () => refreshStatus();
    const onPollSuccess = (event: Event) => {
      if ((event as CustomEvent<{ feedId: string }>).detail.feedId === feedId) {
        setLastSuccessfulPoll((event as CustomEvent<{ feedId: string; at: Date }>).detail.at);
      }
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('duty-notification-poll-success', onPollSuccess);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('duty-notification-poll-success', onPollSuccess);
    };
  }, [feedId, refreshStatus]);

  const persist = useCallback(
    (patch: Partial<typeof dutyNotificationSettings>) => {
      const next = { ...getStoredDutyNotificationSettingsForFeed(feedId), ...patch };
      const result = setStoredDutyNotificationSettingsForFeed(feedId, next);
      if (result.ok) {
        onStorageErrorChange(null);
        setDutyNotificationSettings(next);
        onPersisted?.();
      } else {
        onStorageErrorChange(result.error);
      }
    },
    [feedId, onPersisted, onStorageErrorChange],
  );

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        width: '100%',
        maxWidth: '100%',
        px: { xs: 2, sm: 2.5 },
        py: 2,
      }}
    >
      <Stack spacing={1.25}>
        <Typography variant="subtitle2">Сповіщення цієї стрічки</Typography>
        <Stack spacing={1.25}>
          <FormControlLabel
            sx={{ alignItems: 'center', m: 0, gap: 1.5 }}
            control={
              <Switch
                checked={dutyNotificationSettings.soundEnabled}
                onChange={async (_, checked) => {
                  if (checked) {
                    setSoundStatus(await resumeDutyNotificationAudioFromUserGesture());
                    onNotificationStatusChanged();
                  }
                  persist({ soundEnabled: checked });
                }}
              />
            }
            label={
              <Typography variant="body1">
                Звукове сповіщення — {soundStatusLabel[soundStatus]}
              </Typography>
            }
          />
          <Button
            size="small"
            variant="outlined"
            sx={{ alignSelf: 'flex-start' }}
            onClick={async () => {
              setSoundStatus(await playNotificationSound());
              onNotificationStatusChanged();
            }}
          >
            Перевірити звук
          </Button>
          <FormControlLabel
            sx={{ alignItems: 'center', m: 0, gap: 1.5 }}
            control={
              <Switch
                checked={dutyNotificationSettings.browserEnabled}
                onChange={async (_, checked) => {
                  if (checked) {
                    const permission = await requestBrowserNotificationPermission();
                    refreshStatus();
                    onNotificationStatusChanged();
                    if (permission !== 'granted') {
                      return;
                    }
                  }
                  persist({ browserEnabled: checked });
                }}
              />
            }
            label={
              <Typography variant="body1">
                Браузерне сповіщення — {browserStatusLabel[browserStatus]}
              </Typography>
            }
          />
          <Button
            size="small"
            variant="outlined"
            sx={{ alignSelf: 'flex-start' }}
            onClick={() => {
              setBrowserStatus(testBrowserNotification());
              refreshStatus();
              onNotificationStatusChanged();
            }}
          >
            Перевірити браузерне сповіщення
          </Button>
          <Typography variant="caption" color="text.secondary">
            Остання успішна перевірка сервера:{' '}
            {lastSuccessfulPoll ? lastSuccessfulPoll.toLocaleTimeString() : 'ще не було'}
          </Typography>
          <Typography variant="caption" color="warning.main">
            Працює лише поки «Оперативний» відкритий. На заблокованому телефоні не працює.
          </Typography>
          <Typography component="a" href="/docs/duty-notifications/" variant="caption">
            Як налаштувати браузер і систему
          </Typography>
          {storageError ? (
            <Typography variant="caption" color="error">
              Не вдалося зберегти налаштування: {storageError}
            </Typography>
          ) : null}
        </Stack>
      </Stack>
    </Box>
  );
}

const soundStatusLabel: Record<DutySoundStatus, string> = {
  [DutySoundStatus.Ready]: 'Готово',
  [DutySoundStatus.InteractionRequired]: 'Потрібна взаємодія',
  [DutySoundStatus.Blocked]: 'Заблоковано браузером',
  [DutySoundStatus.Unsupported]: 'Не підтримується',
};

const browserStatusLabel: Record<DutyBrowserNotificationStatus, string> = {
  [DutyBrowserNotificationStatus.NotRequested]: 'Не запитано',
  [DutyBrowserNotificationStatus.Granted]: 'Дозволено',
  [DutyBrowserNotificationStatus.Denied]: 'Відмовлено',
  [DutyBrowserNotificationStatus.Unsupported]: 'Не підтримується',
  [DutyBrowserNotificationStatus.RuntimeFailure]: 'Помилка браузера',
};
