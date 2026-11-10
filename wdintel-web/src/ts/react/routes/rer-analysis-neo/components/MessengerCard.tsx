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
        // `xs` is the phone (below `sm`), where the chat room is tight too.
        sx={{ px: { xs: 1, sm: 2 }, py: { xs: 0.5, sm: 1 } }}
      >
        <Typography variant="overline" color="text.secondary">
          {title}
        </Typography>
        {action}
      </Stack>
      <Divider />
      <Stack spacing={{ xs: 1, sm: 1.5 }} sx={{ p: { xs: 1, sm: 2 } }}>
        {children}
      </Stack>
    </Paper>
  );
}
