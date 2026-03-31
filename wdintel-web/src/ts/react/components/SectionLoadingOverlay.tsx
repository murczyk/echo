import { Box } from '@mui/material';

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
        ...(sx ?? {}),
      })}
    />
  );
}
