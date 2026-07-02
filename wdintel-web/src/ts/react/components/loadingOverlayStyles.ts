import { alpha } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';

export function loadingOverlayBackdropSx(theme: Theme) {
  return {
    position: 'absolute' as const,
    inset: 0,
    zIndex: 10,
    color: theme.palette.text.primary,
    backgroundColor: alpha(
      theme.palette.background.default,
      theme.palette.mode === 'dark' ? 0.52 : 0.62,
    ),
  };
}

export function pageDrawerBackdropSx(theme: Theme) {
  return {
    color: theme.palette.text.primary,
    backgroundColor: alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.52 : 0.24),
  };
}
