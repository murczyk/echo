import { Box, Skeleton } from '@mui/material';

import type { Placement } from './NetworkDetailsLeftPanel.shared';

function LeftPanelSkeleton() {
  const rowHeights = [36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36, 36];

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25,
        height: '100%',
      }}
    >
      <Skeleton variant="text" width="38%" height={30} />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minHeight: 0 }}>
        {rowHeights.map((height, index) => (
          <Skeleton key={index} variant="rounded" height={height} />
        ))}
      </Box>
    </Box>
  );
}

function TopPanelSkeleton() {
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 2.5,
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Skeleton variant="text" width="32%" height={30} />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
            <Skeleton variant="text" width="42%" height={28} />
            <Skeleton variant="rounded" height={24} />
            <Skeleton variant="rounded" height={24} />
            <Skeleton variant="rounded" height={24} />
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
            <Skeleton variant="text" width="40%" height={28} />
            <Skeleton variant="rounded" height={24} />
            <Skeleton variant="rounded" height={24} />
            <Skeleton variant="rounded" height={24} />
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
            <Skeleton variant="text" width="36%" height={28} />
            <Skeleton variant="rounded" height={24} />
            <Skeleton variant="rounded" height={24} />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

export function NetworkDetailsLeftPanelSkeleton({ placement }: { placement: Placement }) {
  return placement === 'top' ? <TopPanelSkeleton /> : <LeftPanelSkeleton />;
}

