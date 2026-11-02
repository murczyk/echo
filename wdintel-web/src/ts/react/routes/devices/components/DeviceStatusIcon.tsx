import CircleIcon from '@mui/icons-material/Circle';
import { Tooltip } from '@mui/material';

export function DeviceStatusIcon({ archived }: { archived: boolean }) {
  const label = archived ? 'Архівний' : 'Активний';
  return (
    <Tooltip title={label}>
      <span className="inline-flex shrink-0 text-echo-xs">
        <CircleIcon
          fontSize="inherit"
          color={archived ? 'disabled' : 'success'}
          titleAccess={label}
        />
      </span>
    </Tooltip>
  );
}
