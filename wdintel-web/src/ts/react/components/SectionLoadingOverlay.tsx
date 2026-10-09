import { Box, CircularProgress } from '@mui/material';

import { loadingOverlayBackdropSx } from './loadingOverlayStyles';

type Props = {
  open: boolean;
  ariaLabel: string;
  announce?: boolean;
  showSpinner?: boolean;
  sx?: object;
};

export function SectionLoadingOverlay({
  open,
  ariaLabel,
  announce = true,
  showSpinner = true,
  sx,
}: Props) {
  if (!open) return null;

  return (
    <Box
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
      aria-label={announce ? ariaLabel : undefined}
      sx={(theme) => ({
        ...loadingOverlayBackdropSx(theme),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'auto',
        cursor: 'progress',
        ...(sx ?? {}),
      })}
    >
      {showSpinner ? <CircularProgress color="inherit" size={30} thickness={4} /> : null}
    </Box>
  );
}
