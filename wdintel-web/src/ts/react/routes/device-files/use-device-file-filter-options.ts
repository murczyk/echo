import { useCallback, useEffect, useRef, useState } from 'react';
import { redirectToLogin } from '../../auth-redirect';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { listDeviceFileFilterOptions } from '../../services/api/devices';
import { toDeviceFileLoadError } from './helpers';
import type { DeviceFileLoadError } from './types';

export function useDeviceFileFilterOptions({
  deviceId,
  syncId,
  enabled,
  active = true,
}: {
  deviceId: string;
  syncId: string | null;
  enabled: boolean;
  active?: boolean;
}) {
  const scope = `${deviceId}:${syncId ?? ''}`;
  const requested = useRef({ scope, active });
  if (requested.current.scope !== scope) requested.current = { scope, active };
  if (active) requested.current.active = true;
  const loadEnabled = enabled && requested.current.active;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    scope: string;
    extensions: string[];
    loading: boolean;
    error: DeviceFileLoadError | null;
  }>({ scope: '', extensions: [], loading: loadEnabled, error: null });
  useEffect(() => {
    const controller = new AbortController();
    setState({ scope, extensions: [], loading: loadEnabled, error: null });
    if (loadEnabled)
      void listDeviceFileFilterOptions(
        { deviceId, syncId, filters: null },
        { signal: controller.signal },
      )
        .then((response) => {
          if (!controller.signal.aborted)
            setState({ scope, extensions: response.extensions, loading: false, error: null });
        })
        .catch((cause) => {
          if (controller.signal.aborted || isAbortError(cause)) return;
          if (isUnauthorizedError(cause)) redirectToLogin();
          setState({
            scope,
            extensions: [],
            loading: false,
            error: toDeviceFileLoadError(cause, 'Не вдалося завантажити розширення файлів'),
          });
        });
    return () => controller.abort();
  }, [deviceId, syncId, scope, loadEnabled, attempt]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, extensions: state.scope === scope ? state.extensions : [], reload };
}
