import { Box, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

type Props = {
  title: string;
  children: ReactNode;
  muted?: boolean;
  hint?: ReactNode;
};

export function NetworkFreqSectionCard({ title, children, muted = false, hint }: Props) {
  return (
    <Box
      sx={{
        p: 2,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        bgcolor: muted ? 'action.hover' : 'transparent',
        opacity: muted ? 0.82 : 1,
      }}
    >
      <Stack spacing={2}>
        <Typography variant="subtitle1" fontWeight={700}>
          {title}
        </Typography>
        {children}
        {hint ? (
          <Typography variant="body2" color="text.secondary">
            {hint}
          </Typography>
        ) : null}
      </Stack>
    </Box>
  );
}
