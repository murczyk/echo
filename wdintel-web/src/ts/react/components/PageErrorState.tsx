import { Box, Button, Stack } from '@mui/material';
import { PowerAlert } from './PowerAlert';

type Props = {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  minHeight?: number | string;
};

export function PageErrorState({ message, actionLabel, onAction, minHeight = 240 }: Props) {
  return (
    <Box
      sx={{
        width: '100%',
        minHeight,
        py: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Stack spacing={3} sx={{ width: '100%', maxWidth: 560, alignItems: 'center' }}>
        <PowerAlert severity="error" sx={{ width: '100%' }}>
          {message}
        </PowerAlert>
        {actionLabel && onAction ? (
          <Button variant="outlined" onClick={onAction}>
            {actionLabel}
          </Button>
        ) : null}
      </Stack>
    </Box>
  );
}
