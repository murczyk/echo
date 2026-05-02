import type { SxProps, Theme } from '@mui/material/styles';

export const DUTY_TOP_ACTION_BUTTON_SIZE = 32;

export const dutyTopActionButtonSx: SxProps<Theme> = {
  width: DUTY_TOP_ACTION_BUTTON_SIZE,
  minWidth: DUTY_TOP_ACTION_BUTTON_SIZE,
  height: DUTY_TOP_ACTION_BUTTON_SIZE,
  minHeight: DUTY_TOP_ACTION_BUTTON_SIZE,
  boxSizing: 'border-box',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  borderRadius: 0,
  px: 0,
  py: 0,
  backgroundColor: 'background.paper',
  borderColor: 'divider',
  transition: 'background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease',
  '&:hover': {
    backgroundColor: 'action.hover',
    borderColor: 'primary.main',
    color: 'primary.main',
  },
  '& .MuiSvgIcon-root': { fontSize: 23 },
};

export const dutyTopScrollButtonSx: SxProps<Theme> = {
  width: 35,
  minWidth: 35,
  height: 35,
  minHeight: 35,
  boxSizing: 'border-box',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  borderRadius: '50%',
  px: 0,
  py: 0,
  backgroundColor: 'background.paper',
  border: '2px solid',
  borderColor: 'grey.400',
  boxShadow: 'none',
  transition: 'background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease',
  '&:hover': {
    backgroundColor: 'action.hover',
    borderColor: 'primary.main',
    color: 'primary.main',
    boxShadow: 'none',
  },
  '& .MuiSvgIcon-root': { fontSize: 20 },
};

export const dutyTopAddFabSx: SxProps<Theme> = {
  width: 35,
  minWidth: 35,
  height: 35,
  minHeight: 35,
  boxSizing: 'border-box',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  borderRadius: '50%',
  px: 0,
  py: 0,
  backgroundColor: 'primary.main',
  color: 'primary.contrastText',
  boxShadow: 'none',
  transition: 'background-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease',
  '&:hover': {
    backgroundColor: 'primary.dark',
    boxShadow: 'none',
  },
  '& .MuiSvgIcon-root': { fontSize: 20 },
};
