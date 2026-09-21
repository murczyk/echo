import { useEffect, useRef } from 'react';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';

export function useDeviceFileErrorNotification(message: string | null | undefined) {
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  useEffect(() => {
    if (message) notifyRef.current({ severity: 'error', message });
  }, [message]);
}
