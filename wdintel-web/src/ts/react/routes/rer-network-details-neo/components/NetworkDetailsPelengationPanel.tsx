import { Box, Button, Stack, Typography } from '@mui/material';
import type { NetworkPoint } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { NetworkDetailsPelengationMap } from './NetworkDetailsPelengationMap';

type Props = {
  pelengPoints: NetworkPoint[];
  pelengPointsLoaded: boolean;
  pelengPointsLoading: boolean;
  pelengPointsError: string | null;
  onReloadPelengPoints: () => void;
};

export function NetworkDetailsPelengationPanel({
  pelengPoints,
  pelengPointsLoaded,
  pelengPointsLoading,
  pelengPointsError,
  onReloadPelengPoints,
}: Props) {
  if (pelengPointsError) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <Typography component="h2" variant="h6">
            ПЕЛЕНГАЦІЯ
          </Typography>
          <PowerAlert severity="error" autoHideDuration={null} sx={{ width: '100%' }}>
            {pelengPointsError}
          </PowerAlert>
          <Button variant="outlined" onClick={onReloadPelengPoints} sx={{ alignSelf: 'flex-start' }}>
            Спробувати ще раз
          </Button>
        </Stack>
      </Box>
    );
  }

  if (pelengPointsLoaded && !pelengPointsLoading && pelengPoints.length === 0) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <Typography component="h2" variant="h6">
            Пеленгація
          </Typography>
          <Box
            sx={{
              minHeight: 220,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 2,
              border: '1px dashed',
              borderColor: 'divider',
              bgcolor: 'background.default',
            }}
          >
            <Typography variant="body2" color="text.secondary">
              Точки перехоплення відсутні
            </Typography>
          </Box>
        </Stack>
      </Box>
    );
  }

  return (
    <NetworkDetailsPelengationMap
      pelengPoints={pelengPoints}
      pelengPointsLoaded={pelengPointsLoaded}
      pelengPointsLoading={pelengPointsLoading}
    />
  );
}
