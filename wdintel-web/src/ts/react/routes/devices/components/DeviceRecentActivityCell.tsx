import { Typography } from '@mui/material';

import type { DeviceRecentActivity } from '../device-activity';
import { DeviceActivityChart } from './DeviceActivityChart';

/** `null` means stats are unavailable, as opposed to a device that never uploaded. */
export function DeviceRecentActivityCell({
  activity,
  splitFilesAudio = false,
}: {
  activity: DeviceRecentActivity | null;
  splitFilesAudio?: boolean;
}) {
  const ariaLabel = splitFilesAudio
    ? 'Завантаження файлів та аудіо за днями'
    : 'Завантаження файлів за днями';
  if (activity === null) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }
  switch (activity.kind) {
    case 'recent':
      return <DeviceActivityChart days={activity.days} ariaLabel={ariaLabel} />;
    case 'lastActive':
      return <DeviceActivityChart days={[activity.day]} faded ariaLabel={ariaLabel} />;
    case 'none':
      return (
        <Typography variant="body2" color="text.secondary">
          Нема активності
        </Typography>
      );
  }
}
