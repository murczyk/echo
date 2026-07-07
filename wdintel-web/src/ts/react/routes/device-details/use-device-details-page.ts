import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DeviceDetails } from '../../../../Bindings';
import { deleteDevice, getDeviceDetail, restoreDevice } from '../../services/api/devices';
import { hasRole } from '../../utils/roles';
import { formatDeviceErrorMessage } from '../devices/helpers';

export type DeviceDetailsUiMessage = {
  kind: 'success' | 'error' | 'warning' | 'info';
  text: string;
} | null;

export function useDeviceDetailsPage({
  deviceId,
  authUserRoles = [],
}: {
  deviceId: string;
  authUserRoles?: string[];
}) {
  const permissions = useMemo(
    () => ({
      canRead: hasRole(authUserRoles, 'Cyber') || hasRole(authUserRoles, 'DevicesEditor'),
      canEdit: hasRole(authUserRoles, 'DevicesEditor'),
    }),
    [authUserRoles],
  );

  const [device, setDevice] = useState<DeviceDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<DeviceDetailsUiMessage>(null);
  const [mutating, setMutating] = useState(false);

  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setDevice(null);
    setLoading(true);
    setStatus(null);
    abortRef.current?.abort();
  }, [deviceId]);

  const loadDevice = useCallback(
    async ({ preserveData }: { preserveData: boolean }) => {
      if (!permissions.canRead) {
        setLoading(false);
        setRefreshing(false);
        setStatus({ kind: 'error', text: 'Немає доступу до пристроїв.' });
        return;
      }

      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (preserveData) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setStatus(null);

      try {
        const nextDevice = await getDeviceDetail(
          { deviceId, includeDeleted: true },
          { signal: controller.signal },
        );
        if (requestSeqRef.current !== seq || controller.signal.aborted) return;
        setDevice(nextDevice);
      } catch (error) {
        if (controller.signal.aborted) return;
        setStatus({
          kind: 'error',
          text: `Помилка завантаження пристрою: ${formatDeviceErrorMessage(error)}`,
        });
      } finally {
        if (requestSeqRef.current === seq) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [deviceId, permissions.canRead],
  );

  useEffect(() => {
    void loadDevice({ preserveData: false });
    return () => abortRef.current?.abort();
  }, [loadDevice]);

  const reload = useCallback(
    () => loadDevice({ preserveData: device !== null }),
    [device, loadDevice],
  );

  const showEditNotice = useCallback(() => {
    if (!permissions.canEdit || !device || device.deleted) return;
    setStatus({ kind: 'info', text: 'Форма редагування пристрою буде додана на Етапі 17.' });
  }, [device, permissions.canEdit]);

  const deleteCurrentDevice = useCallback(async () => {
    if (!permissions.canEdit || !device || device.deleted || mutating) return;
    if (!window.confirm(`Видалити пристрій «${device.name}»?`)) return;

    setMutating(true);
    setStatus(null);
    try {
      const nextDevice = await deleteDevice({ deviceId });
      setDevice(nextDevice);
      setStatus({ kind: 'success', text: 'Пристрій видалено.' });
    } catch (error) {
      setStatus({
        kind: 'error',
        text: `Помилка видалення пристрою: ${formatDeviceErrorMessage(error)}`,
      });
    } finally {
      setMutating(false);
    }
  }, [device, deviceId, mutating, permissions.canEdit]);

  const restoreCurrentDevice = useCallback(async () => {
    if (!permissions.canEdit || !device || !device.deleted || mutating) return;

    setMutating(true);
    setStatus(null);
    try {
      const nextDevice = await restoreDevice({ deviceId });
      setDevice(nextDevice);
      setStatus({ kind: 'success', text: 'Пристрій відновлено.' });
    } catch (error) {
      setStatus({
        kind: 'error',
        text: `Помилка відновлення пристрою: ${formatDeviceErrorMessage(error)}`,
      });
    } finally {
      setMutating(false);
    }
  }, [device, deviceId, mutating, permissions.canEdit]);

  const initialLoadFailed = !loading && device === null && status?.kind === 'error';

  return {
    permissions,
    device,
    loading,
    refreshing,
    status,
    mutating,
    initialLoadFailed,
    reload,
    showEditNotice,
    deleteCurrentDevice,
    restoreCurrentDevice,
  };
}
