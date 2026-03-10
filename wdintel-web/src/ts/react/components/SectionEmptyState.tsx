import { Box, Typography } from '@mui/material';
import React from 'react';

type Props = {
  message: string;
};

export function SectionEmptyState({ message }: Props) {
  return (
    <Box sx={{ py: 1.5 }}>
      <Typography variant="body2" color="text.secondary">
        {message}
      </Typography>
    </Box>
  );
}
