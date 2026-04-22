import * as React from 'react';
import Alert, { AlertProps } from '@mui/material/Alert';

type PowerAlertProps = AlertProps & {
  autoHideDuration?: number | null;
  dismissible?: boolean;
};

const DEFAULT_SUCCESS_AUTO_HIDE_MS = 6000;

export function PowerAlert(props: PowerAlertProps) {
  const { autoHideDuration, dismissible, onClose, severity = 'success', children, ...rest } = props;
  const [open, setOpen] = React.useState(true);
  const isDismissible = dismissible ?? severity !== 'success';

  React.useEffect(() => {
    setOpen(true);
  }, [children, severity]);

  const resolvedAutoHideDuration =
    autoHideDuration === undefined ? (severity === 'success' ? DEFAULT_SUCCESS_AUTO_HIDE_MS : null) : autoHideDuration;

  const handleClose = React.useCallback(
    (event?: React.SyntheticEvent) => {
      setOpen(false);
      if (onClose) {
        onClose(event ?? ({ type: 'auto-hide' } as React.SyntheticEvent));
      }
    },
    [onClose],
  );

  React.useEffect(() => {
    if (!open || resolvedAutoHideDuration == null || resolvedAutoHideDuration <= 0) {
      return;
    }
    const timerId = window.setTimeout(() => {
      handleClose();
    }, resolvedAutoHideDuration);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [handleClose, open, resolvedAutoHideDuration]);

  if (!open) {
    return null;
  }

  const alertOnClose = isDismissible || onClose
    ? (event: React.SyntheticEvent) => {
        handleClose(event);
      }
    : undefined;

  return (
    <Alert
      {...rest}
      severity={severity}
      onClose={alertOnClose}
    >
      {children}
    </Alert>
  );
}
