import { Stack, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { useMemo, useState } from 'react';

import type { DeviceStats } from '../../../../../Bindings';
import { buildDeviceActivity, buildDeviceTypeBreakdown } from '../device-activity';
import { DeviceActivityChart } from './DeviceActivityChart';
import { DeviceTypeBarChart } from './DeviceTypeBarChart';

type DeviceStatsView = 'days' | 'count' | 'bytes';

/** Switches between the chronological chart and category/extension totals by count or size. */
export function DeviceStatsViews({ stats }: { stats: DeviceStats }) {
  const [view, setView] = useState<DeviceStatsView>('days');
  const activity = useMemo(() => buildDeviceActivity(stats), [stats]);
  const breakdown = useMemo(() => buildDeviceTypeBreakdown(stats), [stats]);

  return (
    <Stack spacing={1.5}>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={view}
        onChange={(_, next: DeviceStatsView | null) => {
          if (next !== null) setView(next);
        }}
        aria-label="Вигляд статистики"
        sx={{ alignSelf: 'flex-start', '& .MuiToggleButton-root': { textTransform: 'none' } }}
      >
        <ToggleButton value="days">За днями</ToggleButton>
        <ToggleButton value="count">За кількістю</ToggleButton>
        <ToggleButton value="bytes">За розміром</ToggleButton>
      </ToggleButtonGroup>
      {view === 'days' ? (
        <DeviceActivityChart days={activity} variant="detailed" />
      ) : (
        <DeviceTypeBarChart breakdown={breakdown} metric={view} />
      )}
    </Stack>
  );
}
