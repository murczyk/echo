import { Box, CircularProgress } from '@mui/material';
import type { Theme } from '@mui/material/styles';
import React from 'react';

import { loadingOverlayBackdropSx } from './loadingOverlayStyles';

type SpinnerMode = 'center' | 'sticky';

type Props = {
  open: boolean;
  ariaLabel: string;
  spinnerSize?: number;
  spinnerMode?: SpinnerMode;
  sx?: object;
};

export function SectionLoadingOverlay({
  open,
  ariaLabel,
  spinnerSize = 22,
  spinnerMode = 'center',
  sx,
}: Props) {
  if (!open) return null;

  return (
    <Box
      sx={(theme) => ({
        ...loadingOverlayBackdropSx(theme),
        pointerEvents: 'auto',
        cursor: 'progress',
        ...(sx ?? {}),
      })}
    >
      <Box
        sx={{
          position: spinnerMode === 'sticky' ? 'sticky' : 'absolute',
          top: spinnerMode === 'sticky' ? '50%' : '50%',
          left: spinnerMode === 'sticky' ? undefined : '50%',
          transform: spinnerMode === 'sticky' ? 'translateY(-50%)' : 'translate(-50%, -50%)',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <CircularProgress
          size={spinnerSize}
          color="primary"
          role="status"
          aria-live="polite"
          aria-label={ariaLabel}
        />
      </Box>
    </Box>
  );
}
