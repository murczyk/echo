import { Box, Tooltip } from '@mui/material';

type Props = {
  statusLabel: string;
  developing: boolean;
};

export function NetworkCallsignStatusDot({ statusLabel, developing }: Props) {
  return (
    <Tooltip title={statusLabel} arrow>
      <Box
        component="span"
        aria-label={statusLabel}
        sx={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          bgcolor: developing ? 'warning.main' : 'success.main',
          flexShrink: 0,
          cursor: 'default',
        }}
      />
    </Tooltip>
  );
}
