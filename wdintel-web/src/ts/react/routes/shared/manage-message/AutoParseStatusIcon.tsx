import { Box, CircularProgress } from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';

import { DEFAULT_MESSAGE_PARSE_DEBOUNCE_MS, type MessageParseStatus } from './useMessageParser';

type Props = {
  status: MessageParseStatus;
  debounceKey: number;
};

const ICON_TRANSITION_MS = 180;
const SUCCESS_TRANSITION_MS = 220;

function layerSx(active: boolean, duration = ICON_TRANSITION_MS) {
  return {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    opacity: active ? 1 : 0,
    transform: active ? 'scale(1)' : 'scale(0.72)',
    transition: `opacity ${duration}ms ease, transform ${duration}ms ease`,
    pointerEvents: 'none',
    '@media (prefers-reduced-motion: reduce)': {
      transition: 'none',
    },
  } as const;
}

export function AutoParseStatusIcon({ status, debounceKey }: Props) {
  return (
    <Box
      component="span"
      aria-hidden="true"
      data-testid="auto-parse-status"
      data-state={status}
      sx={{ position: 'relative', display: 'inline-flex', width: 20, height: 20 }}
    >
      <Box component="span" aria-hidden="true" sx={layerSx(status === 'idle')}>
        <AutoFixHighIcon sx={{ fontSize: 20 }} />
      </Box>
      <Box
        key={debounceKey}
        component="span"
        aria-hidden="true"
        sx={layerSx(status === 'debouncing')}
      >
        <CircularProgress
          variant="determinate"
          value={100}
          size={20}
          thickness={4.5}
          data-testid={
            status === 'debouncing' ? 'auto-parse-countdown' : 'auto-parse-countdown-hidden'
          }
          sx={{
            color: 'primary.main',
            transform: 'rotate(-90deg)',
            '& .MuiCircularProgress-circle': {
              transition: 'none',
              animation: `auto-parse-countdown ${DEFAULT_MESSAGE_PARSE_DEBOUNCE_MS}ms linear forwards`,
            },
            '@keyframes auto-parse-countdown': {
              from: { strokeDashoffset: 0 },
              to: { strokeDashoffset: 95.19 },
            },
            '@media (prefers-reduced-motion: reduce)': {
              '& .MuiCircularProgress-circle': { animation: 'none' },
            },
          }}
        />
      </Box>
      <Box component="span" aria-hidden="true" sx={layerSx(status === 'parsing')}>
        <CircularProgress
          size={20}
          thickness={4.5}
          color="inherit"
          data-testid={status === 'parsing' ? 'spinner' : 'auto-parse-spinner-hidden'}
          sx={{
            '@media (prefers-reduced-motion: reduce)': {
              animation: 'none',
              '& .MuiCircularProgress-circle': { animation: 'none' },
            },
          }}
        />
      </Box>
      <Box
        component="span"
        aria-hidden="true"
        sx={layerSx(status === 'success', SUCCESS_TRANSITION_MS)}
      >
        <CheckCircleIcon
          fontSize="small"
          color="success"
          data-testid={status === 'success' ? 'check-icon' : 'auto-parse-check-hidden'}
        />
      </Box>
      <Box component="span" aria-hidden="true" sx={layerSx(status === 'error')}>
        <ErrorOutlineIcon
          fontSize="small"
          color="error"
          data-testid={status === 'error' ? 'error-icon' : 'auto-parse-error-hidden'}
        />
      </Box>
    </Box>
  );
}
