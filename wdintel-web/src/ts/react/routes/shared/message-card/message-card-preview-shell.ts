import { alpha, type SxProps, type Theme } from '@mui/material/styles';

export function blurActivePreviewDialogElement(): void {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return;
  if (activeElement.closest('[role="dialog"]') == null) return;

  activeElement.blur();
}

export function getMessageCardPreviewDialogPaperSx(isFullscreen: boolean): SxProps<Theme> {
  return {
    overflow: 'hidden',
    borderRadius: isFullscreen ? 0 : 2,
  };
}

export function getMessageCardPreviewStageSx(theme: Theme, isFullscreen: boolean): SxProps<Theme> {
  return {
    backgroundColor: 'transparent',
  };
}

export function getMessageCardPreviewActionBarSx(theme: Theme): SxProps<Theme> {
  return {
    px: { xs: 1, sm: 3 },
    py: 2.5,
    backgroundColor: 'transparent',
    display: 'grid',
    gridTemplateColumns: '1fr auto 1fr',
    alignItems: 'center',
    gap: 1,
    '& > :first-child': { minWidth: 0 },
    '& > :last-child': { minWidth: 'max-content' },
    '@media (max-width: 599.95px)': {
      gap: 0.5,
      alignItems: 'flex-start',
    },
  };
}

export function getMessageCardPreviewCounterSx(theme: Theme): SxProps<Theme> {
  return {
    color: theme.palette.text?.secondary ?? 'rgba(244, 247, 251, 0.72)',
    border: `1px solid ${alpha(theme.palette.divider ?? 'rgba(0, 0, 0, 0.12)', 0.12)}`,
    backgroundColor: alpha(theme.palette.text?.primary ?? '#000', 0.04),
  };
}

export function getMessageCardPreviewPopoverPaperSx(theme: Theme): SxProps<Theme> {
  return {
    p: 1.5,
    minWidth: 280,
    maxWidth: 380,
    backgroundColor: theme.palette.background?.paper ?? '#fff',
    color: theme.palette.text?.primary ?? '#f4f7fb',
  };
}
