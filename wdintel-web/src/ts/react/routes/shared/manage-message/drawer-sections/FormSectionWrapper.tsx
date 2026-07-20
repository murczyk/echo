import React, { ReactNode } from 'react';
import { Box, Typography, Stack } from '@mui/material';

export function FormSectionWrapper({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack spacing={2}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          minHeight: 32,
        }}
      >
        <Typography variant="subtitle2">{title}</Typography>
        {action}
      </Box>
      {children}
    </Stack>
  );
}
