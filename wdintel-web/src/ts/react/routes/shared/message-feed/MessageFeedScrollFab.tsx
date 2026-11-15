import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import { Box, CircularProgress, Fab } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import type { ReactNode } from 'react';

import { POWER_FLOATING_CONTROL_SIZE } from '../manage-message/floating-control-geometry';

// The round outlined arrow that jumps to the newest message of a feed.
export const messageFeedScrollFabSx: SxProps<Theme> = {
  width: POWER_FLOATING_CONTROL_SIZE,
  minWidth: POWER_FLOATING_CONTROL_SIZE,
  height: POWER_FLOATING_CONTROL_SIZE,
  minHeight: POWER_FLOATING_CONTROL_SIZE,
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
  '&.Mui-disabled': {
    opacity: 1,
    backgroundColor: 'background.paper',
    borderColor: 'grey.400',
    color: 'grey.400',
    boxShadow: 'none',
  },
  '& .MuiSvgIcon-root': { fontSize: 20 },
};

type Props = {
  onClick: () => void;
  ariaLabel: string;
  // Points to the edge of the newest messages: down for a bottom edge, up for a top edge.
  direction?: 'down' | 'up';
  // Shows the primary colour, e.g. when there is something unread.
  highlighted?: boolean;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  // Sits on the button's corner, e.g. an unread counter.
  badge?: ReactNode;
};

export function MessageFeedScrollFab({
  onClick,
  ariaLabel,
  direction = 'down',
  highlighted = false,
  disabled = false,
  loading = false,
  loadingLabel = 'Завантаження…',
  badge,
}: Props) {
  const Icon = direction === 'down' ? ArrowDownwardIcon : ArrowUpwardIcon;
  return (
    <Box sx={{ position: 'relative', display: 'inline-flex' }}>
      <Fab
        color={highlighted ? 'primary' : 'default'}
        size="small"
        data-message-feed-scroll-fab
        sx={{
          ...messageFeedScrollFabSx,
          position: 'relative',
          zIndex: 0,
          borderColor: highlighted ? 'primary.main' : 'grey.400',
          color: highlighted ? 'primary.main' : 'grey.400',
          '&:hover': {
            backgroundColor: 'background.paper',
            borderColor: 'primary.main',
            color: 'primary.main',
            boxShadow: 'none',
          },
        }}
        aria-label={ariaLabel}
        onClick={onClick}
        disabled={disabled}
      >
        {loading ? (
          <CircularProgress size={20} sx={{ color: 'primary.main' }} aria-label={loadingLabel} />
        ) : (
          <Icon sx={{ fontSize: 20 }} />
        )}
      </Fab>
      {badge}
    </Box>
  );
}
