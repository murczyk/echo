import { Box, Button, Typography } from '@mui/material';

type Props = {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

export function TableEmptyState({ message, actionLabel, onAction }: Props) {
  return (
    <Box
      sx={{
        width: '100%',
        minHeight: 220,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        px: 3,
        py: 4,
        textAlign: 'center',
      }}
    >
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
