import { CircularProgress } from '@mui/material';
import { useMemo } from 'react';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { DeviceActivityChart } from '../../devices/components/DeviceActivityChart';
import { buildDeviceAudioActivity } from '../../devices/device-activity';
import type { DeviceAudioActivityState } from '../use-device-audio-activity';

export function DeviceAudioActivityView({ activity }: { activity: DeviceAudioActivityState }) {
  const days = useMemo(
    () => buildDeviceAudioActivity(activity.value?.days ?? []),
    [activity.value],
  );
  if (activity.loading)
    return <CircularProgress size={24} aria-label="Завантаження статистики аудіо" />;
  if (activity.error)
    return (
      <PowerAlert
        severity="error"
        autoHideDuration={null}
        action={
          <PowerButton size="small" onClick={activity.reload}>
            Повторити
          </PowerButton>
        }
      >
        {activity.error}
      </PowerAlert>
    );
  if (days.length === 0)
    return <p className="m-0 text-echo-text-muted">Завантажених аудіо ще немає.</p>;
  return (
    <DeviceActivityChart days={days} variant="detailed" ariaLabel="Завантаження аудіо за днями" />
  );
}
