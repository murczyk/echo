import { Box, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

type Props = {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  minHeight?: number;
  action?: ReactNode;
};

export function NetworkDetailsEmptyState({ icon, title, description, minHeight = 220, action }: Props) {
  return (
    <Box
      sx={{
        minHeight,
        width: '100%',
        display: 'grid',
        placeItems: 'center',
        borderRadius: 2,
        border: '1px dashed',
        borderColor: 'divider',
        bgcolor: 'background.default',
        px: 3,
        py: 4,
        textAlign: 'center',
      }}
    >
      <Stack spacing={1.5} alignItems="center" sx={{ maxWidth: 640 }}>
        <Box
          sx={{
            display: 'grid',
            placeItems: 'center',
            color: 'text.secondary',
            '& svg': {
              fontSize: 52,
            },
          }}
        >
          {icon}
        </Box>
        <Stack spacing={1} alignItems="center">
          <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
            {title}
          </Typography>
          {description ? (
            <Typography variant="body1" color="text.secondary" sx={{ lineHeight: 1.5 }}>
              {description}
            </Typography>
          ) : null}
        </Stack>
        {action ? <Box sx={{ pt: 0.5 }}>{action}</Box> : null}
      </Stack>
    </Box>
  );
}
