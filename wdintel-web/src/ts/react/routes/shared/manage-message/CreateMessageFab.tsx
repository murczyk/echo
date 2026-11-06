import { useMessageWriteAccess } from '../message-card/MessageWriteAccess';
import { Fab } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { forwardRef } from 'react';
import {
  POWER_FLOATING_CONTROL_EDGE_INSET,
  POWER_FLOATING_CONTROL_SIZE,
} from './floating-control-geometry';

type Props = {
  onClick: (focusTarget?: HTMLElement) => void;
  rightInset?: number;
  // `inline` leaves the position to the parent, e.g. the floating stack of a message feed.
  placement?: 'absolute' | 'inline';
};

export const CreateMessageFab = forwardRef<HTMLButtonElement, Props>(function CreateMessageFab(
  { onClick, rightInset = POWER_FLOATING_CONTROL_EDGE_INSET, placement = 'absolute' },
  ref,
) {
  const canWrite = useMessageWriteAccess();
  if (!canWrite) return null;
  return (
    <Fab
      ref={ref}
      color="primary"
      aria-label="Додати повідомлення"
      onClick={(event) => {
        const focusTarget = event.currentTarget;
        event.currentTarget.blur();
        onClick(focusTarget);
      }}
      sx={{
        ...(placement === 'absolute' && {
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
        }),
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
});
