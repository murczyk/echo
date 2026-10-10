import { useEffect, useState } from 'react';
import type { LocateDeviceFileReq, LocateDeviceFileRsp } from '../../../../Bindings';
import { emitUnauthorizedEvent } from '../../auth-redirect';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { locateDeviceFile } from '../../services/api/devices';
import { toDeviceFileLoadError } from './helpers';

export function useLocatedDeviceFile(request: LocateDeviceFileReq) {
  const [loaded, setLoaded] = useState<{ key: string; result: LocateDeviceFileRsp } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { notify } = usePowerSnackbar();
  const { deviceId, fileId, revision } = request;
  const key = `${deviceId}:${fileId}:${revision}`;
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
    setError(null);
    void locateDeviceFile({ deviceId, fileId, revision }, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setLoaded({ key, result });
      })
      .catch((error) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (isUnauthorizedError(error)) emitUnauthorizedEvent();
        const message = toDeviceFileLoadError(error, 'Не вдалося завантажити файл').message;
        setError(message);
        notify({ severity: 'error', message });
      });
    return () => controller.abort();
  }, [deviceId, fileId, revision, key, attempt, notify]);
  return {
    result: loaded?.key === key ? loaded.result : null,
    error,
    retry: () => {
      setLoaded(null);
      setError(null);
      setAttempt((value) => value + 1);
    },
  };
}
