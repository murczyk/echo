import { Fab } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import {
  POWER_FLOATING_CONTROL_EDGE_INSET,
  POWER_FLOATING_CONTROL_SIZE,
} from './floating-control-geometry';

type Props = {
  onClick: () => void;
  rightInset?: number;
};

export function CreateMessageFab({
  onClick,
  rightInset = POWER_FLOATING_CONTROL_EDGE_INSET,
}: Props) {
  return (
    <Fab
      color="primary"
      aria-label="Додати повідомлення"
      onClick={(event) => {
        event.currentTarget.blur();
        onClick();
      }}
      sx={{
        position: 'absolute',
        right: {
          xs: `max(${rightInset}px, env(safe-area-inset-right, 0px))`,
          sm: rightInset,
        },
        bottom: {
          xs: `max(${POWER_FLOATING_CONTROL_EDGE_INSET}px, env(safe-area-inset-bottom, 0px))`,
          sm: POWER_FLOATING_CONTROL_EDGE_INSET,
        },
        zIndex: 1000,
        width: POWER_FLOATING_CONTROL_SIZE,
        minWidth: POWER_FLOATING_CONTROL_SIZE,
        height: POWER_FLOATING_CONTROL_SIZE,
        minHeight: POWER_FLOATING_CONTROL_SIZE,
        boxShadow: 'none',
        '&:hover': {
          boxShadow: 'none',
        },
        '& .MuiSvgIcon-root': { fontSize: 20 },
      }}
    >
      <AddIcon />
    </Fab>
  );
}
