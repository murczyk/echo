import { Divider, Paper, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

type Props = {
  title: string;
  action?: ReactNode;
  children: ReactNode;
};

export function MessengerCard({ title, action, children }: Props) {
  return (
    <Paper variant="outlined" component="section" aria-label={title} data-messenger-card>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ px: 2, py: 1 }}
      >
        <Typography variant="overline" color="text.secondary">
          {title}
        </Typography>
        {action}
      </Stack>
      <Divider />
      <Stack spacing={1.5} sx={{ p: 2 }}>
        {children}
      </Stack>
    </Paper>
  );
}
