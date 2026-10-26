import { Typography } from '@mui/material';

import type { DeviceRecentActivity } from '../device-activity';
import { DeviceActivityChart } from './DeviceActivityChart';

/** `null` means stats are unavailable, as opposed to a device that never uploaded. */
export function DeviceRecentActivityCell({ activity }: { activity: DeviceRecentActivity | null }) {
  if (activity === null) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }
  switch (activity.kind) {
    case 'recent':
      return <DeviceActivityChart days={activity.days} />;
    case 'lastActive':
      return <DeviceActivityChart days={[activity.day]} faded />;
    case 'none':
      return (
        <Typography variant="body2" color="text.secondary">
          Нема активності
        </Typography>
      );
  }
}
