import { Box, CircularProgress } from '@mui/material';
import React from 'react';

type Props = {
  minHeight?: number | string;
};

export function PageLoadingState({ minHeight = 240 }: Props) {
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
      <CircularProgress size={32} />
    </Box>
  );
}
