import { useEffect, useState } from 'react';
import type {
  DeviceAudioForwardingGroup,
  DeviceAudioForwardingSettings,
  DeviceListItem,
} from '../../../../Bindings';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { isAbortError } from '../../services/api/client';
import { getDeviceAudioForwarding, updateDevice } from '../../services/api/devices';
import { formatDeviceErrorMessage } from '../devices/helpers';

export function useAddForwarding(onSaved: () => void) {
  const [device, setDevice] = useState<DeviceListItem | null>(null);
  const [settings, setSettings] = useState<DeviceAudioForwardingSettings | null>(null);
  const [group, setGroup] = useState<DeviceAudioForwardingGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    if (!device) return;
    const controller = new AbortController();
    void getDeviceAudioForwarding(device.id, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setSettings(result);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        const message = `Не вдалося завантажити групи: ${formatDeviceErrorMessage(error)}`;
        setError(message);
        notify({ severity: 'error', message });
      });
    return () => controller.abort();
  }, [device, attempt, notify]);

  const reload = () => {
    setSettings(null);
    setGroup(null);
    setError(null);
    setAttempt((value) => value + 1);
  };
  const save = async () => {
    if (!device || !settings || !group || busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateDevice({
        deviceId: device.id,
        audioForwarding: {
          version: settings.version,
          enabled: true,
          addGroups: [group.masterKey],
          removeGroups: [],
        },
      });
      notify({ severity: 'success', message: 'Пересилання додано' });
      onSaved();
    } catch (error) {
      const message = `Не вдалося додати пересилання: ${formatDeviceErrorMessage(error)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setBusy(false);
    }
  };
  return { device, setDevice, settings, group, setGroup, busy, error, reload, save };
}
