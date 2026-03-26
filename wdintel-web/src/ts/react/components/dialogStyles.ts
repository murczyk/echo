import type { SxProps, Theme } from '@mui/material';

export const STANDARD_DIALOG_ACTIONS_SX: SxProps<Theme> = {
  px: 3,
  py: 3,
  gap: 1.5,
  '& > :not(style) ~ :not(style)': {
    ml: 0,
  },
};
