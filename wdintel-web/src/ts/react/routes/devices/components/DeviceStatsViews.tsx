import { Stack, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { useMemo, useState, type ReactNode } from 'react';

import type { DeviceStats } from '../../../../../Bindings';
import { buildDeviceActivity, buildDeviceTypeBreakdown } from '../device-activity';
import { DeviceActivityChart } from './DeviceActivityChart';
import { DeviceTypeBarChart } from './DeviceTypeBarChart';

enum DeviceStatsView {
  Days = 'days',
  Count = 'count',
  Bytes = 'bytes',
  Audio = 'audio',
}

/** Switches between the chronological chart and category/extension totals by count or size. */
export function DeviceStatsViews({
  stats,
  highlightSelection = false,
  audio,
}: {
  stats: DeviceStats | null;
  highlightSelection?: boolean;
  audio?: ReactNode;
}) {
  const [view, setView] = useState(DeviceStatsView.Days);
  const selectedView = stats === null && audio !== undefined ? DeviceStatsView.Audio : view;
  const activity = useMemo(() => buildDeviceActivity(stats), [stats]);
  const breakdown = useMemo(() => buildDeviceTypeBreakdown(stats), [stats]);

  return (
    <Stack spacing={1.5}>
      <ToggleButtonGroup
        className="max-w-full flex-wrap"
        size="small"
        exclusive
        value={selectedView}
        onChange={(_, next: DeviceStatsView | null) => {
          if (next !== null) setView(next);
        }}
        aria-label="Вигляд статистики"
        sx={{
          alignSelf: 'flex-start',
          '& .MuiToggleButton-root': { textTransform: 'none' },
          ...(highlightSelection
            ? {
                '& .MuiToggleButton-root.Mui-selected': {
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  '&:hover': { bgcolor: 'primary.dark' },
                },
              }
            : {}),
        }}
      >
        {stats !== null ? (
          <>
            <ToggleButton value={DeviceStatsView.Days}>За днями</ToggleButton>
            <ToggleButton value={DeviceStatsView.Count}>За кількістю</ToggleButton>
            <ToggleButton value={DeviceStatsView.Bytes}>За розміром</ToggleButton>
          </>
        ) : null}
        {audio !== undefined ? (
          <ToggleButton value={DeviceStatsView.Audio}>Аудіо</ToggleButton>
        ) : null}
      </ToggleButtonGroup>
      {selectedView === DeviceStatsView.Audio ? (
        audio
      ) : selectedView === DeviceStatsView.Days ? (
        <DeviceActivityChart days={activity} variant="detailed" />
      ) : (
        <DeviceTypeBarChart breakdown={breakdown} metric={selectedView} />
      )}
    </Stack>
  );
}
