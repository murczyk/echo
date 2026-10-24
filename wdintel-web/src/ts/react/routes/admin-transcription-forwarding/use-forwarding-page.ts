import { useEffect, useState } from 'react';
import type {
  DeviceAudioForwardingEntry,
  ListDeviceAudioForwardingReq,
  ListDeviceAudioForwardingRsp,
} from '../../../../Bindings';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { isAbortError } from '../../services/api/client';
import {
  listDeviceAudioForwarding,
  removeDeviceAudioForwarding,
} from '../../services/api/device-audio-forwarding';
import { formatDeviceErrorMessage } from '../devices/helpers';

export function useForwardingPage() {
  const [page, setPage] = useState<ListDeviceAudioForwardingRsp | null>(null);
  const [cursors, setCursors] = useState<ListDeviceAudioForwardingReq['cursor'][]>([null]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<DeviceAudioForwardingEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const { notify } = usePowerSnackbar();
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setPage(null);
    setError(null);
    void listDeviceAudioForwarding({ cursor }, { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setPage(response);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        const message = `Не вдалося завантажити пересилання: ${formatDeviceErrorMessage(error)}`;
        setError(message);
        notify({ severity: 'error', message });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cursor, revision, notify]);

  const reload = () => setRevision((value) => value + 1);
  const refresh = () => {
    setCursors([null]);
    reload();
  };
  const remove = async () => {
    if (!removing || busy) return;
    setBusy(true);
    try {
      await removeDeviceAudioForwarding({
        deviceId: removing.deviceId,
        groupMasterKey: removing.groupMasterKey,
        version: removing.version,
      });
      notify({ severity: 'success', message: 'Пересилання видалено' });
      setRemoving(null);
      refresh();
    } catch (error) {
      notify({
        severity: 'error',
        message: `Не вдалося видалити пересилання: ${formatDeviceErrorMessage(error)}`,
      });
      setRemoving(null);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return {
    page,
    cursors,
    setCursors,
    loading,
    error,
    adding,
    setAdding,
    removing,
    setRemoving,
    busy,
    reload,
    refresh,
    remove,
  };
}
