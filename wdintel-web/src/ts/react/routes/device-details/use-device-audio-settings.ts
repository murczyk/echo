import { useEffect, useRef, useState } from 'react';
import type { DeviceAudioAsrSettingsRsp } from '../../../../Bindings';
import { AUTH_UNAUTHORIZED_EVENT } from '../../auth-redirect';
import { FORCED_NAVIGATION_EVENT } from '../../../browser/navigation-guard';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import { getDeviceAudioSettings, setDeviceAudioSettings } from '../../services/api/device-audio';
import { formatDeviceErrorMessage } from '../devices/helpers';

type State = {
  key: string;
  value: DeviceAudioAsrSettingsRsp | null;
  loading: boolean;
  pending: boolean;
  error: boolean;
};
const empty = (key: string): State => ({
  key,
  value: null,
  loading: true,
  pending: false,
  error: false,
});

export function useDeviceAudioSettings(deviceId: string, active: boolean) {
  const key = `${deviceId}:${active}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const [state, setState] = useState(() => empty(key));
  const { notify } = useOptionalPowerSnackbar();
  const notification = useRef(notify);
  notification.current = notify;
  const actions = useRef({ refresh: () => {}, setEnabled: (_enabled: boolean) => {} });

  useEffect(() => {
    const controller = new AbortController();
    let value: DeviceAudioAsrSettingsRsp | null = null;
    let busy = false;
    const current = () => active && !controller.signal.aborted && currentKey.current === key;
    const update = (patch: Partial<State>) => {
      if (current()) setState((previous) => ({ ...previous, ...patch }));
    };
    const report = (error: unknown) =>
      notification.current({
        severity: 'error',
        message: `Помилка налаштувань аудіо: ${formatDeviceErrorMessage(error)}`,
      });
    const read = async () => {
      const result = await getDeviceAudioSettings({ deviceId }, { signal: controller.signal });
      if (!current()) return;
      value = result;
      update({ value, error: false });
    };
    const request = async (target?: boolean) => {
      if (!current() || busy || (target !== undefined && !value?.canManageSetting)) return;
      busy = true;
      update({ loading: target === undefined, pending: target !== undefined });
      try {
        if (target === undefined) await read();
        else {
          const saved = await setDeviceAudioSettings(
            { deviceId, enabled: target },
            { signal: controller.signal },
          );
          if (!current()) return;
          value = saved;
          update({ value, error: false });
        }
      } catch (error) {
        if (!current() || isAbortError(error)) return;
        report(error);
        value = null;
        update({ error: true });
        if (target !== undefined && !(error instanceof HttpRequestError && error.status === 401)) {
          try {
            await read();
          } catch (readError) {
            if (current() && !isAbortError(readError)) report(readError);
          }
        }
      } finally {
        busy = false;
        update({ loading: false, pending: false });
      }
    };
    const stop = () => {
      update({ error: true });
      controller.abort();
    };
    setState(empty(key));
    actions.current = {
      refresh: () => {
        void request();
      },
      setEnabled: (target) => {
        void request(target);
      },
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, stop, true);
    window.addEventListener(FORCED_NAVIGATION_EVENT, stop, true);
    void request();
    return () => {
      controller.abort();
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, stop, true);
      window.removeEventListener(FORCED_NAVIGATION_EVENT, stop, true);
    };
  }, [deviceId, active, key]);

  return {
    ...(state.key === key ? state : empty(key)),
    refresh: () => actions.current.refresh(),
    setEnabled: (target: boolean) => actions.current.setEnabled(target),
  };
}
export type DeviceAudioSettingsState = ReturnType<typeof useDeviceAudioSettings>;
