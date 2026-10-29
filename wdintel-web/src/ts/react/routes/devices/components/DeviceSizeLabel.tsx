import { Tooltip } from '@mui/material';

import type { DeviceRowView } from '../helpers';

export function DeviceSizeLabel({ row }: { row: DeviceRowView }) {
  if (!row.stats?.contentPending) return <span>{row.sizeLabel}</span>;
  return (
    <Tooltip title="Статистика неповна: частину файлів ще не пораховано" disableInteractive>
      <span>
        {row.sizeLabel}
        <span aria-hidden style={{ color: 'var(--bs-warning)' }}>
          {' *'}
        </span>
      </span>
    </Tooltip>
  );
}
