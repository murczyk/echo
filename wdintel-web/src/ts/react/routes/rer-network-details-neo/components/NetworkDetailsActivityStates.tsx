import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
import { Box, Button, Stack, Typography } from '@mui/material';

import { PowerAlert } from '../../../components/PowerAlert';
import { ELLIPSIS } from '../../../utils/misc';
import { NetworkDetailsEmptyState } from './NetworkDetailsEmptyState';
import { NetworkDetailsLoadingState } from './NetworkDetailsLoadingState';

export function NetworkDetailsActivityLoadingState() {
  return <NetworkDetailsLoadingState message={`Завантажуємо активність мережі${ELLIPSIS}`} />;
}

export function NetworkDetailsActivityEmptyState() {
  return (
    <NetworkDetailsEmptyState
      icon={<MonitorHeartOutlinedIcon />}
      title="Немає даних активності"
      description="Активність буде доступна після першої фіксації сигналу"
      minHeight={360}
    />
  );
}

export function NetworkDetailsActivityErrorState({
  error,
  onReload,
}: {
  error: string;
  onReload: () => void;
}) {
  return (
    <Stack spacing={2} sx={{ alignItems: 'center' }}>
      <PowerAlert severity="error" autoHideDuration={null} sx={{ width: '100%' }}>
        {error}
      </PowerAlert>
      <Button variant="outlined" onClick={onReload}>
        Спробувати ще раз
      </Button>
    </Stack>
  );
}
