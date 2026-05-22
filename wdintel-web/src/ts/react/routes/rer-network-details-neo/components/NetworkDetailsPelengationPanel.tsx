import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import { Box, Button, Stack, Typography } from '@mui/material';
import type { NetworkPoint } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { NetworkDetailsEmptyState } from './NetworkDetailsEmptyState';
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
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%', alignItems: 'center' }}>
          <Typography component="h2" variant="h6">
            ПЕЛЕНГАЦІЯ
          </Typography>
          <PowerAlert severity="error" autoHideDuration={null} sx={{ width: '100%' }}>
            {pelengPointsError}
          </PowerAlert>
          <Button variant="outlined" onClick={onReloadPelengPoints}>
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
          <NetworkDetailsEmptyState
            icon={<LocationOnOutlinedIcon />}
            title="Немає пеленгації"
            description="Підключіть пости, щоб бачити геопросторові дані."
            minHeight={360}
          />
        </Stack>
      </Box>
    );
  }

  return (
    <NetworkDetailsPelengationMap
      pelengPoints={pelengPoints}
    />
  );
}
