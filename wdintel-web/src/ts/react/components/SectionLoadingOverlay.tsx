import { Box, Skeleton, Stack } from '@mui/material';

import { loadingOverlayBackdropSx } from './loadingOverlayStyles';

type Props = {
  open: boolean;
  ariaLabel: string;
  sx?: object;
};

export function SectionLoadingOverlay({
  open,
  ariaLabel,
  sx,
}: Props) {
  if (!open) return null;

  return (
    <Box
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      sx={(theme) => ({
        ...loadingOverlayBackdropSx(theme),
        pointerEvents: 'auto',
        cursor: 'progress',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
        ...(sx ?? {}),
      })}
    >
      <Box
        sx={(theme) => ({
          width: 'min(100%, 420px)',
          borderRadius: 2,
          px: 2,
          py: 1.5,
          backdropFilter: 'blur(3px)',
          backgroundColor: theme.palette.mode === 'dark'
            ? 'rgba(18, 18, 18, 0.38)'
            : 'rgba(255, 255, 255, 0.42)',
          boxShadow: theme.shadows[1],
        })}
      >
        <Stack spacing={1.25}>
          <Skeleton variant="text" width="38%" height={28} />
          <Skeleton variant="rounded" height={44} />
          <Skeleton variant="rounded" height={44} />
          <Skeleton variant="rounded" width="72%" height={44} />
        </Stack>
      </Box>
    </Box>
  );
}
