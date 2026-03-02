import { Box, Button, Typography } from '@mui/material';

type Props = {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

export function TableEmptyState({ message, actionLabel, onAction }: Props) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, py: 3 }}>
      <Typography variant="body2" color="text.secondary" align="center">
        {message}
      </Typography>
      {actionLabel && onAction ? (
        <Button size="small" onClick={onAction} sx={{ px: 1.5 }}>
          {actionLabel}
        </Button>
      ) : null}
    </Box>
  );
}
