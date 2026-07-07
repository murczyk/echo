import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AreaOfResponsibility, DeviceDetails, Unit } from '../../../../Bindings';
import { listAors } from '../../services/api/aor';
import {
  archiveDevice,
  getDeviceDetail,
  restoreDevice,
  updateDevice,
} from '../../services/api/devices';
import { getUnitsList } from '../../services/api/units';
import { hasRole } from '../../utils/roles';
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
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [lookupsLoading, setLookupsLoading] = useState(false);
  const [lookupsLoaded, setLookupsLoaded] = useState(false);
  const [editForm, setEditForm] = useState<DeviceUpsertForm | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editServerFieldErrors, setEditServerFieldErrors] = useState<DeviceServerFieldErrors>({});
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);

  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const aorOptions = useMemo(() => resolveAorOptions(aors), [aors]);
  const unitOptions = useMemo(() => resolveUnitOptions(units), [units]);
  const editHasChanges = useMemo(() => {
    if (device === null || editForm === null) return false;
    return hasDeviceUpdatePatchChanges(buildUpdateDevicePatch(device, editForm));
  }, [device, editForm]);

  useEffect(() => {
    setDevice(null);
    setLoading(true);
    setStatus(null);
    setEditForm(null);
    setEditError(null);
    setEditServerFieldErrors({});
    setArchiveDialogOpen(false);
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
    if (!permissions.canEdit || lookupsLoaded || lookupsLoading) return;

    setLookupsLoading(true);
    try {
      const [nextAors, nextUnits] = await Promise.all([listAors({ sortBy: null }), getUnitsList()]);
      setAors(nextAors);
      setUnits(nextUnits);
      setLookupsLoaded(true);
    } catch (error) {
      setEditError(`Помилка завантаження довідників: ${formatDeviceErrorMessage(error)}`);
    } finally {
      setLookupsLoading(false);
    }
  }, [lookupsLoaded, lookupsLoading, permissions.canEdit]);

  const openEditDrawer = useCallback(() => {
    if (!permissions.canEdit || !device || device.archived) return;
    setEditForm(deviceDetailsToUpsertForm(device));
    setEditError(null);
    setEditServerFieldErrors({});
    void loadLookups();
  }, [device, loadLookups, permissions.canEdit]);

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
      if (validateDeviceUpsertForm(form) !== null) {
        setEditError('Перевірте поля форми.');
        return false;
      }

      const patch = buildUpdateDevicePatch(device, form);
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
        const fieldErrors = parseDeviceServerFieldErrors(error);
        setEditServerFieldErrors(fieldErrors);
        setEditError(
          Object.keys(fieldErrors).length > 0
            ? null
            : `Помилка оновлення пристрою: ${formatDeviceErrorMessage(error)}`,
        );
        return false;
      } finally {
        setEditSubmitting(false);
      }
    },
    [device, editSubmitting, permissions.canEdit],
  );

  const openArchiveDialog = useCallback(() => {
    if (!permissions.canEdit || !device || device.archived || mutating) return;
    setArchiveDialogOpen(true);
  }, [device, mutating, permissions.canEdit]);

  const closeArchiveDialog = useCallback(() => {
    if (mutating) return;
    setArchiveDialogOpen(false);
  }, [mutating]);

  const confirmArchiveCurrentDevice = useCallback(async () => {
    if (!permissions.canEdit || !device || device.archived || mutating) return;

    setMutating(true);
    setStatus(null);
    try {
      const nextDevice = await archiveDevice({ deviceId });
      setDevice(nextDevice);
      setArchiveDialogOpen(false);
      setStatus({ kind: 'success', text: 'Пристрій архівовано.' });
    } catch (error) {
      setStatus({
        kind: 'error',
        text: `Помилка архівування пристрою: ${formatDeviceErrorMessage(error)}`,
      });
    } finally {
      setMutating(false);
    }
  }, [device, deviceId, mutating, permissions.canEdit]);

  const restoreCurrentDevice = useCallback(async () => {
    if (!permissions.canEdit || !device || !device.archived || mutating) return;

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
    aorOptions,
    unitOptions,
    lookupsLoading,
    editForm,
    editError,
    editServerFieldErrors,
    editSubmitting,
    editHasChanges,
    archiveDialogOpen,
    initialLoadFailed,
    reload,
    openEditDrawer,
    closeEditDrawer,
    setEditForm: changeEditForm,
    saveEditDevice,
    openArchiveDialog,
    closeArchiveDialog,
    confirmArchiveCurrentDevice,
    restoreCurrentDevice,
  };
}
