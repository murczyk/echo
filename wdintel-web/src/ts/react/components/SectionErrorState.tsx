import { Box, Typography } from '@mui/material';
import React from 'react';

type Props = {
  message: string;
};

export function SectionErrorState({ message }: Props) {
  return (
    <Box sx={{ py: 1.5 }}>
      <Typography variant="body2" color="error">
        {message}
      </Typography>
    </Box>
  );
}
