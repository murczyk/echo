import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceAudioActivityRsp } from '../../../../Bindings';
import { redirectToLogin } from '../../auth-redirect';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { getDeviceAudioActivity } from '../../services/api/device-audio';
import { toDeviceFileLoadError } from '../device-files/helpers';
import { useDeviceFileErrorNotification } from '../device-files/use-device-file-error-notification';

export function useDeviceAudioActivity(deviceId: string, enabled: boolean, refreshVersion: number) {
  const [state, setState] = useState<{
    deviceId: string;
    value: DeviceAudioActivityRsp | null;
    loading: boolean;
    error: string | null;
  }>({ deviceId, value: null, loading: enabled, error: null });
  const abortRef = useRef<AbortController | null>(null);
  const current =
    state.deviceId === deviceId ? state : { deviceId, value: null, loading: enabled, error: null };
  useDeviceFileErrorNotification(current.error);
  const load = useCallback(async () => {
    if (!enabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ deviceId, value: null, loading: true, error: null });
    try {
      const value = await getDeviceAudioActivity({ deviceId }, { signal: controller.signal });
      if (!controller.signal.aborted) setState({ deviceId, value, loading: false, error: null });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      setState({
        deviceId,
        value: null,
        loading: false,
        error: toDeviceFileLoadError(error, 'Помилка завантаження статистики аудіо').message,
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [deviceId, enabled]);
  useEffect(() => {
    setState({ deviceId, value: null, loading: enabled, error: null });
    void load();
    return () => abortRef.current?.abort();
  }, [deviceId, enabled, refreshVersion, load]);
  return { ...current, reload: () => void load() };
}

export type DeviceAudioActivityState = ReturnType<typeof useDeviceAudioActivity>;
