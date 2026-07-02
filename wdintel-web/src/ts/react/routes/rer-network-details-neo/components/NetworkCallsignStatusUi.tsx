import { Box, Tooltip } from '@mui/material';

import type { NetworkCallsignStatus } from '../network-callsigns.types';

type Props = {
  statusLabel: string;
  status: NetworkCallsignStatus;
};

export function NetworkCallsignStatusDot({ statusLabel, status }: Props) {
  const color =
    status === 'developing' ? 'warning.main' : status === 'catalog' ? 'info.main' : 'success.main';

  return (
    <Tooltip title={statusLabel} arrow>
      <Box
        component="span"
        aria-label={statusLabel}
        sx={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          bgcolor: color,
          flexShrink: 0,
          cursor: 'default',
        }}
      />
    </Tooltip>
  );
}
