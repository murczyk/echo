import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AreaOfResponsibility, DeviceDetails, Unit } from '../../../../Bindings';
import {
  getDeviceDetail,
  listDeviceAors,
  listDeviceUnits,
  updateDevice,
} from '../../services/api/devices';
import { isNetworkRequestError } from '../../services/api/client';
import { resolveDevicesCapabilities } from '../../utils/roles';
import {
  buildUpdateDevicePatch,
  deviceDetailsToUpsertForm,
  hasDeviceUpdatePatchChanges,
  parseDeviceServerFieldErrors,
  validateDeviceUpsertForm,
  type DeviceServerFieldErrors,
  type DeviceUpsertForm,
} from '../devices/device-form';
import {
  formatDeviceErrorMessage,
  resolveAorOptions,
  resolveUnitOptions,
} from '../devices/helpers';

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
  const capabilities = useMemo(() => resolveDevicesCapabilities(authUserRoles), [authUserRoles]);
  const permissions = useMemo(
    () => ({
      canRead: capabilities.canRead,
      canEdit: capabilities.canWriteSourceData || capabilities.canWriteAnalyticalData,
      fieldPermissions: {
        sourceData: capabilities.canWriteSourceData,
        analyticalData: capabilities.canWriteAnalyticalData,
      },
    }),
    [capabilities],
  );

  const [device, setDevice] = useState<DeviceDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<DeviceDetailsUiMessage>(null);
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [lookupsLoading, setLookupsLoading] = useState(false);
  const [lookupsLoaded, setLookupsLoaded] = useState(false);
  const [editForm, setEditForm] = useState<DeviceUpsertForm | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editServerFieldErrors, setEditServerFieldErrors] = useState<DeviceServerFieldErrors>({});
  const [editSubmitting, setEditSubmitting] = useState(false);

  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const aorOptions = useMemo(() => resolveAorOptions(aors), [aors]);
  const unitOptions = useMemo(() => resolveUnitOptions(units), [units]);
  const editHasChanges = useMemo(() => {
    if (device === null || editForm === null) return false;
    return hasDeviceUpdatePatchChanges(
      buildUpdateDevicePatch(device, editForm, permissions.fieldPermissions),
    );
  }, [device, editForm, permissions.fieldPermissions]);

  useEffect(() => {
    setDevice(null);
    setLoading(true);
    setStatus(null);
    setEditForm(null);
    setEditError(null);
    setEditServerFieldErrors({});
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
          { deviceId, includeArchived: true },
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

  const loadLookups = useCallback(async () => {
    if (
      !permissions.canEdit ||
      !permissions.fieldPermissions.analyticalData ||
      lookupsLoaded ||
      lookupsLoading
    )
      return;

    setLookupsLoading(true);
    try {
      const [nextAors, nextUnits] = await Promise.all([listDeviceAors(), listDeviceUnits()]);
      setAors(nextAors);
      setUnits(nextUnits);
      setLookupsLoaded(true);
    } catch (error) {
      setEditError(`Помилка завантаження довідників: ${formatDeviceErrorMessage(error)}`);
    } finally {
      setLookupsLoading(false);
    }
  }, [lookupsLoaded, lookupsLoading, permissions]);

  const openEditDrawer = useCallback(() => {
    if (!permissions.canEdit || !device || device.archived) return;
    setEditForm(deviceDetailsToUpsertForm(device));
    setEditError(null);
    setEditServerFieldErrors({});
    if (permissions.fieldPermissions.analyticalData) void loadLookups();
  }, [device, loadLookups, permissions]);

  const closeEditDrawer = useCallback(() => {
    if (editSubmitting) return;
    setEditForm(null);
    setEditError(null);
    setEditServerFieldErrors({});
  }, [editSubmitting]);

  const changeEditForm = useCallback((form: DeviceUpsertForm | null) => {
    setEditForm(form);
    setEditError(null);
    setEditServerFieldErrors({});
  }, []);

  const saveEditDevice = useCallback(
    async (form: DeviceUpsertForm): Promise<boolean> => {
      if (!permissions.canEdit || !device || device.archived || editSubmitting) return false;
      if (validateDeviceUpsertForm(form, permissions.fieldPermissions) !== null) {
        setEditError('Перевірте поля форми.');
        return false;
      }

      const patch = buildUpdateDevicePatch(device, form, permissions.fieldPermissions);
      if (!hasDeviceUpdatePatchChanges(patch)) {
        setEditError('Немає змін для збереження.');
        return false;
      }

      setEditSubmitting(true);
      setEditError(null);
      setEditServerFieldErrors({});
      setStatus(null);
      try {
        const nextDevice = await updateDevice(patch);
        setDevice(nextDevice);
        setEditForm(null);
        setStatus({ kind: 'success', text: 'Пристрій оновлено.' });
        return true;
      } catch (error) {
        const resultUncertain = isNetworkRequestError(error);
        const fieldErrors = parseDeviceServerFieldErrors(error);
        setEditServerFieldErrors(fieldErrors);
        setEditError(
          Object.keys(fieldErrors).length > 0
            ? null
            : resultUncertain
              ? `Результат оновлення пристрою невідомий. Дані перезавантажено для перевірки. ${formatDeviceErrorMessage(error)}`
              : `Помилка оновлення пристрою: ${formatDeviceErrorMessage(error)}`,
        );
        if (resultUncertain) await loadDevice({ preserveData: true });
        return false;
      } finally {
        setEditSubmitting(false);
      }
    },
    [device, editSubmitting, loadDevice, permissions],
  );

  const initialLoadFailed = !loading && device === null && status?.kind === 'error';

  return {
    permissions,
    device,
    loading,
    refreshing,
    status,
    aorOptions,
    unitOptions,
    lookupsLoading,
    editForm,
    editError,
    editServerFieldErrors,
    editSubmitting,
    editHasChanges,
    initialLoadFailed,
    reload,
    openEditDrawer,
    closeEditDrawer,
    setEditForm: changeEditForm,
    saveEditDevice,
  };
}
