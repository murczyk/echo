import { createTheme, type SxProps, type Theme } from '@mui/material/styles';

const darkPaletteBackgroundDefault = createTheme({ palette: { mode: 'dark' } }).palette.background
  .default;

export function getAttachmentPreviewStageBg(theme: Theme, _isMediaLayout?: boolean): string {
  return theme.palette.mode === 'dark' ? theme.palette.background.default : theme.palette.grey[100];
}

export function blurActiveAttachmentPreviewElement(): void {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return;
  if (activeElement.closest('[role="dialog"]') == null) return;

  activeElement.blur();
}

export function getAttachmentPreviewDialogPaperSx(isFullscreen: boolean): SxProps<Theme> {
  return {
    overflow: 'hidden',
    borderRadius: isFullscreen ? 0 : 2,
  };
}

export function getAttachmentPreviewStageSx(theme: Theme, isFullscreen: boolean): SxProps<Theme> {
  return {
    backgroundColor: 'transparent',
  };
}

export function getAttachmentPreviewActionBarSx(theme: Theme): SxProps<Theme> {
  return {
    px: { xs: 1, sm: 3 },
    py: 2.5,
    backgroundColor: 'transparent',
    display: 'grid',
    gridTemplateColumns: '1fr auto 1fr',
    alignItems: 'center',
    gap: 1,
    '& > :first-of-type': { minWidth: 0 },
    '& > :last-of-type': { minWidth: 'max-content' },
    '@media (max-width: 599.95px)': {
      gap: 0.5,
      alignItems: 'flex-start',
    },
  };
}

export function getAttachmentPreviewPopoverPaperSx(theme: Theme): SxProps<Theme> {
  return {
    p: 1.5,
    minWidth: 280,
    maxWidth: 380,
    backgroundColor: theme.palette.background?.paper ?? '#fff',
    color: theme.palette.text?.primary ?? '#f4f7fb',
  };
}
