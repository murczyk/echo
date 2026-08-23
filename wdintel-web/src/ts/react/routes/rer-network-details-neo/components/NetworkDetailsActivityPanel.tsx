import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { useId, useMemo, useState } from 'react';

import type { NetworkGroupActivityPeriod } from '../../../../../Bindings';
import { NetworkDetailsActivityChart } from './NetworkDetailsActivityChart';
import {
  NetworkDetailsActivityEmptyState,
  NetworkDetailsActivityErrorState,
  NetworkDetailsActivityLoadingState,
} from './NetworkDetailsActivityStates';
import {
  type HoveredBar,
  type NetworkActivity,
  buildActivityChartData,
  getGroupColor,
} from './NetworkDetailsActivityPanel.utils';

type Props = {
  networkActivity: NetworkActivity;
  networkActivityPeriod: NetworkGroupActivityPeriod;
  networkActivityLoading: boolean;
  networkActivityLoaded: boolean;
  networkActivityError: string | null;
  onNetworkActivityPeriodChange: (period: NetworkGroupActivityPeriod) => void;
  onReloadNetworkActivity: () => void;
};

const ACTIVITY_PERIODS: Array<{ value: NetworkGroupActivityPeriod; days: number }> = [
  { value: 'Last10Days', days: 10 },
  { value: 'Last30Days', days: 30 },
  { value: 'Last60Days', days: 60 },
];

function activityPeriodDays(period: NetworkGroupActivityPeriod): number {
  return ACTIVITY_PERIODS.find((option) => option.value === period)?.days ?? 10;
}

function ActivityHeading({
  headingId,
  period,
  loading,
  onChange,
}: {
  headingId: string;
  period: NetworkGroupActivityPeriod;
  loading: boolean;
  onChange: (period: NetworkGroupActivityPeriod) => void;
}) {
  return (
    <Stack
      direction="row"
      spacing={2}
      alignItems="center"
      justifyContent="space-between"
      useFlexGap
    >
      <Typography id={headingId} component="h2" variant="h6">
        Активність мережі
      </Typography>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={period}
        disabled={loading}
        aria-label="Період активності мережі в днях"
        onChange={(_, nextPeriod: NetworkGroupActivityPeriod | null) => {
          if (nextPeriod !== null) onChange(nextPeriod);
        }}
        sx={{
          gap: 0.75,
          '& .MuiToggleButtonGroup-grouped': {
            minWidth: 40,
            px: 1.25,
            py: 0.25,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: '999px !important',
          },
        }}
      >
        {ACTIVITY_PERIODS.map((option) => (
          <ToggleButton key={option.value} value={option.value} aria-label={`${option.days} днів`}>
            {option.days}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Stack>
  );
}

export function NetworkDetailsActivityPanel({
  networkActivity,
  networkActivityPeriod,
  networkActivityLoading,
  networkActivityLoaded,
  networkActivityError,
  onNetworkActivityPeriodChange,
  onReloadNetworkActivity,
}: Props) {
  const headingId = useId().replace(/:/g, '-');
  const [hoveredBar, setHoveredBar] = useState<HoveredBar | null>(null);
  const chartData = useMemo(
    () =>
      buildActivityChartData(
        networkActivity,
        Date.now(),
        activityPeriodDays(networkActivityPeriod),
      ),
    [networkActivity, networkActivityPeriod],
  );
  const isLoading =
    networkActivityLoading || (!networkActivityLoaded && networkActivityError === null);

  if (networkActivityError) {
    return (
      <Box
        sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <ActivityHeading
            headingId={headingId}
            period={networkActivityPeriod}
            loading={networkActivityLoading}
            onChange={onNetworkActivityPeriodChange}
          />
          <NetworkDetailsActivityErrorState
            error={networkActivityError}
            onReload={onReloadNetworkActivity}
          />
        </Stack>
      </Box>
    );
  }

  if (isLoading) {
    return (
      <Box
        sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <ActivityHeading
            headingId={headingId}
            period={networkActivityPeriod}
            loading={networkActivityLoading}
            onChange={onNetworkActivityPeriodChange}
          />
          <NetworkDetailsActivityLoadingState />
        </Stack>
      </Box>
    );
  }

  if (chartData.groupNames.length === 0) {
    return (
      <Box
        sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <ActivityHeading
            headingId={headingId}
            period={networkActivityPeriod}
            loading={networkActivityLoading}
            onChange={onNetworkActivityPeriodChange}
          />
          <NetworkDetailsActivityEmptyState />
        </Stack>
      </Box>
    );
  }

  return (
    <Box
      sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <Stack
        spacing={2}
        sx={{ minHeight: 0, minWidth: 0, width: '100%' }}
        onMouseLeave={() => setHoveredBar(null)}
      >
        <ActivityHeading
          headingId={headingId}
          period={networkActivityPeriod}
          loading={networkActivityLoading}
          onChange={onNetworkActivityPeriodChange}
        />

        <NetworkDetailsActivityChart
          headingId={headingId}
          chartData={chartData}
          hoveredBar={hoveredBar}
          onHoveredBarChange={setHoveredBar}
        />

        <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', pt: 0.5 }}>
          {chartData.groupNames.map((groupName) => (
            <Stack
              key={groupName}
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ minWidth: 0 }}
            >
              <Box
                sx={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  bgcolor: chartData.groupColors.get(groupName) ?? getGroupColor(groupName),
                  flexShrink: 0,
                }}
              />
              <Typography variant="body2" sx={{ minWidth: 0 }} noWrap title={groupName}>
                {groupName}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </Stack>
    </Box>
  );
}
