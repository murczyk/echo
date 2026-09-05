import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import WebAssetIcon from '@mui/icons-material/WebAsset';
import { Switch, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { PowerButton } from '../../components/PowerButton';
import {
  DutyNotificationsHelpDialog,
  DutyNotificationsHelpTopic,
} from './DutyNotificationsHelpDialog';
import {
  DUTY_NOTIFICATION_STATUS_CHANGE_EVENT,
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

function NotificationChannelCard({ children }: { children: ReactNode }) {
  return (
    <article className="flex h-full flex-col items-stretch gap-3 rounded-echo-lg border border-echo-border bg-echo-surface-raised p-echo-lg">
      {children}
    </article>
  );
}

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
  const [helpTopic, setHelpTopic] = useState<DutyNotificationsHelpTopic | null>(null);
  const [browserTestSucceeded, setBrowserTestSucceeded] = useState(false);
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
    setBrowserTestSucceeded(false);
  }, [feedId, storageSyncKey, refreshStatus]);

  useEffect(() => {
    const refresh = () => refreshStatus();
    const onPollSuccess = (event: Event) => {
      if ((event as CustomEvent<{ feedId: string }>).detail.feedId === feedId) {
        setLastSuccessfulPoll((event as CustomEvent<{ feedId: string; at: Date }>).detail.at);
      }
    };
    window.addEventListener('focus', refresh);
    window.addEventListener(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT, refresh);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('duty-notification-poll-success', onPollSuccess);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT, refresh);
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

  const testSound = useCallback(async () => {
    setSoundStatus(await playNotificationSound());
    onNotificationStatusChanged();
  }, [onNotificationStatusChanged]);

  const soundControlId = `duty-notification-sound-${feedId}`;
  const browserControlId = `duty-notification-browser-${feedId}`;
  const hasSoundGuidance =
    dutyNotificationSettings.soundEnabled && soundStatus !== DutySoundStatus.Ready;
  const hasBrowserGuidance =
    browserStatus !== DutyBrowserNotificationStatus.Granted &&
    browserStatus !== DutyBrowserNotificationStatus.NotRequested;

  return (
    <section className="w-full max-w-full border border-echo-border bg-echo-surface-raised px-echo-lg py-echo-md">
      <Typography variant="subtitle2">Сповіщення цієї стрічки</Typography>
      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-3">
        <NotificationChannelCard>
          <label className="w-full min-w-0 cursor-pointer" htmlFor={soundControlId}>
            <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-echo-md">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-echo-pill bg-echo-primary text-echo-on-primary">
                <VolumeUpIcon fontSize="small" />
              </span>
              <span className="min-w-0">
                <Typography component="span" fontWeight={600} variant="body1">
                  Звуковий сигнал
                </Typography>
              </span>
              <Switch
                checked={dutyNotificationSettings.soundEnabled}
                className="shrink-0"
                id={soundControlId}
                onChange={async (_, checked) => {
                  if (checked) {
                    setSoundStatus(await resumeDutyNotificationAudioFromUserGesture());
                    onNotificationStatusChanged();
                  }
                  persist({ soundEnabled: checked });
                }}
              />
            </span>
          </label>
          {dutyNotificationSettings.soundEnabled ? (
            <div className="flex flex-wrap items-center gap-2">
              <PowerButton
                className="self-start"
                size="small"
                variant="outlined"
                onClick={testSound}
              >
                Перевірити звук
              </PowerButton>
              {hasSoundGuidance ? (
                <>
                  <Typography color="warning.main" variant="caption">
                    {soundGuidance[soundStatus]}
                  </Typography>
                  {soundStatus !== DutySoundStatus.Unsupported ? (
                    <PowerButton
                      size="small"
                      variant="text"
                      onClick={() => setHelpTopic(DutyNotificationsHelpTopic.Feed)}
                    >
                      Як виправити
                    </PowerButton>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </NotificationChannelCard>
        <NotificationChannelCard>
          <label className="w-full min-w-0 cursor-pointer" htmlFor={browserControlId}>
            <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-echo-md">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-echo-pill bg-echo-primary text-echo-on-primary">
                <WebAssetIcon fontSize="small" />
              </span>
              <span className="min-w-0">
                <Typography component="span" fontWeight={600} variant="body1">
                  Системний банер
                </Typography>
              </span>
              <Switch
                checked={dutyNotificationSettings.browserEnabled}
                className="shrink-0"
                id={browserControlId}
                onChange={async (_, checked) => {
                  if (checked) {
                    const permission = await requestBrowserNotificationPermission();
                    refreshStatus();
                    onNotificationStatusChanged();
                    if (permission !== 'granted') return;
                  }
                  persist({ browserEnabled: checked });
                  if (!checked) setBrowserTestSucceeded(false);
                }}
              />
            </span>
          </label>
          {dutyNotificationSettings.browserEnabled &&
          browserStatus === DutyBrowserNotificationStatus.Granted ? (
            <PowerButton
              className="self-start"
              size="small"
              variant="outlined"
              onClick={() => {
                const status = testBrowserNotification();
                setBrowserStatus(status);
                setBrowserTestSucceeded(status === DutyBrowserNotificationStatus.Granted);
                refreshStatus();
                onNotificationStatusChanged();
              }}
            >
              Перевірити банер
            </PowerButton>
          ) : null}
          {hasBrowserGuidance ? (
            <div className="flex flex-wrap items-center gap-2">
              <Typography color="warning.main" variant="caption">
                {browserGuidance[browserStatus]}
              </Typography>
              {browserStatus === DutyBrowserNotificationStatus.Denied ? (
                <PowerButton
                  size="small"
                  variant="text"
                  onClick={() => setHelpTopic(DutyNotificationsHelpTopic.Chrome)}
                >
                  Як виправити
                </PowerButton>
              ) : browserStatus === DutyBrowserNotificationStatus.RuntimeFailure ? (
                <PowerButton
                  size="small"
                  variant="text"
                  onClick={() => setHelpTopic(DutyNotificationsHelpTopic.Troubleshooting)}
                >
                  Як виправити
                </PowerButton>
              ) : null}
            </div>
          ) : null}
          {browserTestSucceeded ? (
            <div className="grid gap-1">
              <Typography color="text.secondary" variant="caption">
                Банер не з’явився? Chrome може мати дозвіл сайту, але macOS або Windows блокувати
                його.
              </Typography>
              <PowerButton
                className="justify-self-start"
                size="small"
                style={{ whiteSpace: 'normal' }}
                variant="text"
                onClick={() => setHelpTopic(DutyNotificationsHelpTopic.System)}
              >
                Перевірити системні налаштування
              </PowerButton>
            </div>
          ) : null}
        </NotificationChannelCard>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-echo-divider-subtle pt-3">
        <Typography color="text.secondary" variant="caption">
          Для коректної роботи не закривайте сторінку.
        </Typography>
        <PowerButton
          className="justify-self-start"
          size="small"
          variant="outlined"
          onClick={() =>
            setHelpTopic(
              browserStatus === DutyBrowserNotificationStatus.Granted
                ? DutyNotificationsHelpTopic.Feed
                : DutyNotificationsHelpTopic.Chrome,
            )
          }
        >
          Інструкція
        </PowerButton>
      </div>
      {storageError ? (
        <Typography className="mt-2 block" color="error" variant="caption">
          Не вдалося зберегти налаштування: {storageError}
        </Typography>
      ) : null}
      <DutyNotificationsHelpDialog
        initialTopic={helpTopic ?? DutyNotificationsHelpTopic.Feed}
        lastSuccessfulPoll={lastSuccessfulPoll}
        onClose={() => setHelpTopic(null)}
        onTestSound={testSound}
        open={helpTopic !== null}
      />
    </section>
  );
}

const soundGuidance: Record<DutySoundStatus, string> = {
  [DutySoundStatus.Ready]: '',
  [DutySoundStatus.InteractionRequired]: 'Натисніть «Перевірити звук», щоб активувати аудіоканал.',
  [DutySoundStatus.Blocked]: 'Браузер не дозволив відтворити сигнал.',
  [DutySoundStatus.Unsupported]: 'Цей браузер не підтримує потрібне відтворення звуку.',
};

const browserGuidance: Record<DutyBrowserNotificationStatus, string> = {
  [DutyBrowserNotificationStatus.NotRequested]: 'Увімкніть канал, щоб Chrome запросив дозвіл.',
  [DutyBrowserNotificationStatus.Granted]: '',
  [DutyBrowserNotificationStatus.Denied]: 'Сповіщення заборонені в налаштуваннях сайту.',
  [DutyBrowserNotificationStatus.Unsupported]: 'Цей браузер не підтримує браузерні сповіщення.',
  [DutyBrowserNotificationStatus.RuntimeFailure]: 'Браузеру не вдалося створити системний банер.',
};
