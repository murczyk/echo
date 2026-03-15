import { Box, Button, Stack, Typography } from '@mui/material';
import React from 'react';

type Props = {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  minHeight?: number | string;
};

export function PageEmptyState({ message, actionLabel, onAction, minHeight = 240 }: Props) {
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
      <Stack spacing={2} sx={{ width: '100%', maxWidth: 560, alignItems: 'center' }}>
        <Typography variant="body1" color="text.secondary" align="center">
          {message}
        </Typography>
        {actionLabel && onAction ? (
          <Button variant="outlined" onClick={onAction}>
            {actionLabel}
          </Button>
        ) : null}
      </Stack>
    </Box>
  );
}
