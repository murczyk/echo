import { Box, Stack, Typography } from '@mui/material';
import { useId, useMemo, useState } from 'react';

import {
  NetworkDetailsActivityChart,
} from './NetworkDetailsActivityChart';
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
  networkActivityLoading: boolean;
  networkActivityLoaded: boolean;
  networkActivityError: string | null;
  onReloadNetworkActivity: () => void;
};

export function NetworkDetailsActivityPanel({
  networkActivity,
  networkActivityLoading,
  networkActivityLoaded,
  networkActivityError,
  onReloadNetworkActivity,
}: Props) {
  const headingId = useId().replace(/:/g, '-');
  const [hoveredBar, setHoveredBar] = useState<HoveredBar | null>(null);

  const chartData = useMemo(() => buildActivityChartData(networkActivity, Date.now()), [networkActivity]);
  const isLoading = networkActivityLoading || (!networkActivityLoaded && networkActivityError === null);

  if (networkActivityError) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <Typography id={headingId} component="h2" variant="h6">
            Активність мережі
          </Typography>
          <NetworkDetailsActivityErrorState error={networkActivityError} onReload={onReloadNetworkActivity} />
        </Stack>
      </Box>
    );
  }

  if (isLoading) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <Typography id={headingId} component="h2" variant="h6">
            Активність мережі
          </Typography>
          <NetworkDetailsActivityLoadingState />
        </Stack>
      </Box>
    );
  }

  if (chartData.groupNames.length === 0) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <Typography id={headingId} component="h2" variant="h6">
            Активність мережі
          </Typography>
          <NetworkDetailsActivityEmptyState />
        </Stack>
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
      <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }} onMouseLeave={() => setHoveredBar(null)}>
        <Typography id={headingId} component="h2" variant="h6">
          Активність мережі
        </Typography>

        <NetworkDetailsActivityChart
          headingId={headingId}
          chartData={chartData}
          hoveredBar={hoveredBar}
          onHoveredBarChange={setHoveredBar}
        />

        <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', pt: 0.5 }}>
          {chartData.groupNames.map((groupName) => (
            <Stack key={groupName} direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
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
