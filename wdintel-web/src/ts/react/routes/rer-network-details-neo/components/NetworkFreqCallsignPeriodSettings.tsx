import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import {
  Box,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Popover,
  Select,
  Tooltip,
} from '@mui/material';
import { useId, useState } from 'react';

import type { NetworkFreqCallsignsPeriod } from '../../../../../Bindings';

type Props = {
  period: NetworkFreqCallsignsPeriod;
  disabled: boolean;
  onChange: (period: NetworkFreqCallsignsPeriod) => void;
};

export function NetworkFreqCallsignPeriodSettings({ period, disabled, onChange }: Props) {
  const popoverId = useId().replace(/:/g, '-');
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  return (
    <>
      <Tooltip title="Налаштування позивних">
        <IconButton
          size="small"
          aria-label="Налаштування позивних"
          aria-describedby={anchorEl ? popoverId : undefined}
          onClick={(event) => setAnchorEl(event.currentTarget)}
        >
          <SettingsOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Popover
        id={popoverId}
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Box sx={{ p: 2, width: 240 }}>
          <FormControl fullWidth size="small" disabled={disabled}>
            <InputLabel id={`${popoverId}-period-label`}>Період позивних</InputLabel>
            <Select
              labelId={`${popoverId}-period-label`}
              value={period}
              label="Період позивних"
              onChange={(event) => onChange(event.target.value as NetworkFreqCallsignsPeriod)}
            >
              <MenuItem value="Last21Days">21 день</MenuItem>
              <MenuItem value="Last7Days">7 днів</MenuItem>
              <MenuItem value="Unlimited">Без обмежень</MenuItem>
            </Select>
          </FormControl>
        </Box>
      </Popover>
    </>
  );
}
