import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Portal from '@mui/material/Portal';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  consumeExitFallback,
  releaseExitFallback,
  replaceExitFallback,
  type ExitFallback,
} from './power-snackbar-exit-ownership';

export type PowerSnackbarSeverity = 'success' | 'info' | 'warning' | 'error';

export type PowerSnackbarNotification = {
  message: ReactNode;
  severity: PowerSnackbarSeverity;
  durationMs?: number;
};

type QueuedNotification = PowerSnackbarNotification & { id: number };
type PowerSnackbarContextValue = {
  notify: (notification: PowerSnackbarNotification) => number;
};

const PowerSnackbarContext = createContext<PowerSnackbarContextValue | null>(null);

const DEFAULT_DURATION_MS: Record<PowerSnackbarSeverity, number> = {
  success: 3000,
  info: 5000,
  warning: 8000,
  error: 10000,
};
const DEFAULT_NARROW_INSET = 8;
const DEFAULT_DESKTOP_INSET = 24;

export function PowerSnackbarProvider({
  children,
  bottomInset,
  rightInset,
}: {
  children: ReactNode;
  bottomInset?: number | string;
  rightInset?: number | string;
}) {
  const nextIdRef = useRef(0);
  const [current, setCurrent] = useState<QueuedNotification | null>(null);
  const [queue, setQueue] = useState<QueuedNotification[]>([]);
  const [open, setOpen] = useState(false);
  const exitFallbackRef = useRef<ExitFallback | null>(null);

  const notify = useCallback((notification: PowerSnackbarNotification) => {
    const id = ++nextIdRef.current;
    setQueue((previous) => [...previous, { ...notification, id }]);
    return id;
  }, []);

  useEffect(() => {
    if (current || queue.length === 0) return;
    const [next, ...remaining] = queue;
    setQueue(remaining);
    setCurrent(next ?? null);
    setOpen(true);
  }, [current, queue]);

  const handleClose = useCallback(
    (_event?: unknown, reason?: string) => {
      if (reason === 'clickaway') return;
      setOpen(false);
      const exitingId = current?.id;
      if (exitingId !== undefined) {
        const timerId = setTimeout(() => {
          if (exitFallbackRef.current?.notificationId !== exitingId) return;
          exitFallbackRef.current = consumeExitFallback(exitFallbackRef.current, exitingId);
          setCurrent((previous) => (previous?.id === exitingId ? null : previous));
        }, 300);
        exitFallbackRef.current = replaceExitFallback(exitFallbackRef.current, exitingId, timerId);
      }
    },
    [current],
  );

  const handleExited = useCallback((exitingId: number) => {
    exitFallbackRef.current = releaseExitFallback(exitFallbackRef.current, exitingId);
    setCurrent((previous) => (previous?.id === exitingId ? null : previous));
  }, []);

  useEffect(
    () => () => {
      if (exitFallbackRef.current) clearTimeout(exitFallbackRef.current.timerId);
    },
    [],
  );

  const inset = (value: number | string) => (typeof value === 'number' ? `${value}px` : value);
  const bottom =
    bottomInset === undefined
      ? {
          xs: `calc(${DEFAULT_NARROW_INSET}px + env(safe-area-inset-bottom, 0px))`,
          sm: `calc(${DEFAULT_DESKTOP_INSET}px + env(safe-area-inset-bottom, 0px))`,
        }
      : `calc(${inset(bottomInset)} + env(safe-area-inset-bottom, 0px))`;
  const right =
    rightInset === undefined
      ? {
          xs: `calc(${DEFAULT_NARROW_INSET}px + env(safe-area-inset-right, 0px))`,
          sm: `calc(${DEFAULT_DESKTOP_INSET}px + env(safe-area-inset-right, 0px))`,
        }
      : `calc(${inset(rightInset)} + env(safe-area-inset-right, 0px))`;

  const contextValue = useMemo(() => ({ notify }), [notify]);

  return (
    <PowerSnackbarContext.Provider value={contextValue}>
      {children}
      {current ? (
        <Portal>
          <Snackbar
            key={current.id}
            open={open}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            autoHideDuration={current.durationMs ?? DEFAULT_DURATION_MS[current.severity]}
            onClose={handleClose}
            slotProps={{ transition: { onExited: () => handleExited(current.id) } }}
            sx={{
              bottom,
              right,
              left: 'auto',
              maxWidth: 'calc(100vw - 16px)',
              '& .MuiAlert-root': { width: '100%' },
            }}
          >
            <Alert
              severity={current.severity}
              closeText="Закрити сповіщення"
              role={
                current.severity === 'success' || current.severity === 'info' ? 'status' : 'alert'
              }
              onClose={() => handleClose()}
            >
              {current.message}
            </Alert>
          </Snackbar>
        </Portal>
      ) : null}
    </PowerSnackbarContext.Provider>
  );
}

export function usePowerSnackbar(): PowerSnackbarContextValue {
  const context = useContext(PowerSnackbarContext);
  if (!context) {
    throw new Error('usePowerSnackbar must be used within a PowerSnackbarProvider');
  }
  return context;
}

export const POWER_SNACKBAR_DEFAULT_DURATION_MS = DEFAULT_DURATION_MS;
