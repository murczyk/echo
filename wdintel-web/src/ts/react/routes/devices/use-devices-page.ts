import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AreaOfResponsibility,
  DeviceDetails,
  DeviceListItem,
  DeviceStatusCountsRsp,
  DeviceUnitStatRow,
  Unit,
} from '../../../../Bindings';
import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import {
  createDevice,
  deleteDevice,
  getDeviceDetail,
  restoreDevice,
  updateDevice,
} from '../../services/api/devices';
import { navigateWithinSpa } from '../../utils/browser';
import { hasRole } from '../../utils/roles';
import {
  buildDeviceRowView,
  createDefaultDevicesFilterState,
  deviceDetailsToListItem,
  formatDeviceErrorMessage,
  hasActiveDevicesFilters,
  isSameDeviceSidebarUnitFilter,
  mergeDeviceUnitStatsWithUnits,
  resolveAorOptions,
  resolveDeviceSidebarUnitIds,
  resolveUnitOptions,
  type DeviceDeletedFilterValue,
  type DeviceLookupOption,
  type DevicesFilterState,
} from './helpers';
import {
  buildCreateDeviceReq,
  buildUpdateDevicePatch,
  createDefaultDeviceUpsertForm,
  deviceDetailsToUpsertForm,
  hasDeviceUpdatePatchChanges,
  parseDeviceServerFieldErrors,
  validateDeviceUpsertForm,
  type DeviceServerFieldErrors,
  type DeviceUpsertForm,
} from './device-form';
import {
  createDevicesLoadActions,
  type DevicesQuerySnapshot,
  type DevicesUiMessage,
} from './use-devices-page.load';
import type { SelectedSidebarUnitFilter } from '../rer-callsigns-neo/types';

export function useDevicesPage({ authUserRoles = [] }: { authUserRoles?: string[] } = {}) {
  const tableStateContext = useTableStateContext();
  const permissions = useMemo(
    () => ({
      canRead: hasRole(authUserRoles, 'Cyber') || hasRole(authUserRoles, 'DevicesEditor'),
      canEdit: hasRole(authUserRoles, 'DevicesEditor'),
    }),
    [authUserRoles],
  );

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [devices, setDevices] = useState<DeviceListItem[]>([]);
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [unitStats, setUnitStats] = useState<DeviceUnitStatRow[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [statusCounts, setStatusCounts] = useState<DeviceStatusCountsRsp | null>(null);
  const [filters, setFilters] = useState<DevicesFilterState>(() =>
    createDefaultDevicesFilterState(),
  );
  const [status, setStatus] = useState<DevicesUiMessage>(null);
  const [bootstrapLoaded, setBootstrapLoaded] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedSidebarUnitFilter, setSelectedSidebarUnitFilter] =
    useState<SelectedSidebarUnitFilter | null>(null);
  const [mutatingDeviceId, setMutatingDeviceId] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<DeviceUpsertForm | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createServerFieldErrors, setCreateServerFieldErrors] = useState<DeviceServerFieldErrors>(
    {},
  );
  const [creating, setCreating] = useState(false);
  const [editDevice, setEditDevice] = useState<DeviceDetails | null>(null);
  const [editLoadingDeviceId, setEditLoadingDeviceId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<DeviceUpsertForm | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editServerFieldErrors, setEditServerFieldErrors] = useState<DeviceServerFieldErrors>({});
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [deleteDialogDevice, setDeleteDialogDevice] = useState<{ id: string; name: string } | null>(
    null,
  );

  const requestSeqRef = useRef(0);
  const bootstrapLoadedRef = useRef(false);
  const mainAbortRef = useRef<AbortController | null>(null);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const devicesLengthRef = useRef(0);
  const latestQuerySnapshotRef = useRef<DevicesQuerySnapshot | null>(null);
  const lastExecutedFullQueryKeyRef = useRef<string | null>(null);
  const filtersRef = useRef(filters);

  useEffect(() => {
    devicesLengthRef.current = devices.length;
  }, [devices.length]);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const rows = useMemo(() => devices.map(buildDeviceRowView), [devices]);
  const unitsById = useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units]);
  const aorOptions = useMemo<DeviceLookupOption[]>(() => resolveAorOptions(aors), [aors]);
  const unitOptions = useMemo<DeviceLookupOption[]>(() => resolveUnitOptions(units), [units]);
  const unitStatsView = useMemo(
    () => mergeDeviceUnitStatsWithUnits(unitStats, unitsById),
    [unitStats, unitsById],
  );
  const editHasChanges = useMemo(() => {
    if (editDevice === null || editForm === null) return false;
    return hasDeviceUpdatePatchChanges(buildUpdateDevicePatch(editDevice, editForm));
  }, [editDevice, editForm]);

  const querySnapshot = useMemo<DevicesQuerySnapshot>(
    () => ({
      globalFilter: tableStateContext.globalFilter,
      filters,
      sorting: tableStateContext.sorting,
      fullQueryKey: JSON.stringify({
        globalFilter: tableStateContext.globalFilter,
        filters,
        sorting: tableStateContext.sorting,
      }),
    }),
    [filters, tableStateContext.globalFilter, tableStateContext.sorting],
  );

  useEffect(() => {
    latestQuerySnapshotRef.current = querySnapshot;
  }, [querySnapshot]);

  const loadActions = useMemo(
    () =>
      createDevicesLoadActions({
        latestQuerySnapshotRef,
        requestSeqRef,
        bootstrapLoadedRef,
        mainAbortRef,
        loadMoreAbortRef,
        devicesLengthRef,
        lastExecutedFullQueryKeyRef,
        setLoading,
        setRefreshing,
        setLoadingMore,
        setDevices,
        setAors,
        setUnits,
        setUnitStats,
        setTotal,
        setHasMore,
        setStatusCounts,
        setStatus,
        setBootstrapLoaded,
      }),
    [],
  );

  useEffect(() => {
    if (!permissions.canRead) {
      setLoading(false);
      setStatus({ kind: 'error', text: 'Немає доступу до пристроїв.' });
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void loadActions.loadDevices(querySnapshot, {
        includeLookups: !bootstrapLoadedRef.current,
      });
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [loadActions, permissions.canRead, querySnapshot]);

  useEffect(() => () => loadActions.dispose(), [loadActions]);

  const setDeletedFilter = useCallback((deletedFilter: DeviceDeletedFilterValue) => {
    setFilters((current) => ({ ...current, deletedFilter }));
  }, []);

  const onPickUnitFilter = useCallback(
    (filter: SelectedSidebarUnitFilter) => {
      if (isSameDeviceSidebarUnitFilter(selectedSidebarUnitFilter, filter)) {
        setSelectedSidebarUnitFilter(null);
        setFilters((current) => ({ ...current, unitIds: [] }));
        return;
      }

      setSelectedSidebarUnitFilter(filter);
      setFilters((current) => ({
        ...current,
        unitIds: resolveDeviceSidebarUnitIds(filter, units),
      }));
    },
    [selectedSidebarUnitFilter, units],
  );

  const onClearUnitFilter = useCallback(() => {
    setSelectedSidebarUnitFilter(null);
    setFilters((current) => ({ ...current, unitIds: [] }));
  }, []);

  const clearFilters = useCallback(() => {
    tableStateContext.onChangeGlobalFilter('');
    setSelectedSidebarUnitFilter(null);
    setFilters(createDefaultDevicesFilterState());
  }, [tableStateContext]);

  const reload = useCallback(() => loadActions.reloadDevices(), [loadActions]);
  const loadMore = useCallback(() => loadActions.loadMoreDevices(), [loadActions]);

  const openCreateDialog = useCallback(() => {
    if (!permissions.canEdit) return;
    setCreateForm(createDefaultDeviceUpsertForm());
    setCreateError(null);
    setCreateServerFieldErrors({});
  }, [permissions.canEdit]);

  const closeCreateDialog = useCallback(() => {
    if (creating) return;
    setCreateForm(null);
    setCreateError(null);
    setCreateServerFieldErrors({});
  }, [creating]);

  const changeCreateForm = useCallback((form: DeviceUpsertForm | null) => {
    setCreateForm(form);
    setCreateError(null);
    setCreateServerFieldErrors({});
  }, []);

  const submitCreateDialog = useCallback(
    async (form: DeviceUpsertForm) => {
      if (!permissions.canEdit || creating) return;
      if (validateDeviceUpsertForm(form) !== null) {
        setCreateError('Перевірте поля форми.');
        return;
      }

      setCreating(true);
      setCreateError(null);
      setCreateServerFieldErrors({});
      setStatus(null);
      try {
        const device = await createDevice(buildCreateDeviceReq(form));
        navigateWithinSpa(`/devices/${device.id}`);
      } catch (error) {
        const fieldErrors = parseDeviceServerFieldErrors(error);
        setCreateServerFieldErrors(fieldErrors);
        setCreateError(
          Object.keys(fieldErrors).length > 0
            ? null
            : `Помилка створення пристрою: ${formatDeviceErrorMessage(error)}`,
        );
      } finally {
        setCreating(false);
      }
    },
    [creating, permissions.canEdit],
  );

  const refreshAfterLifecycleMutation = useCallback(
    async (device: DeviceListItem) => {
      setDevices((current) => {
        const exists = current.some((item) => item.id === device.id);
        if (!exists) return current;
        return current.map((item) => (item.id === device.id ? device : item));
      });
      await loadActions.reloadDevices({ includeUnitStats: true });
    },
    [loadActions],
  );

  const openEditRow = useCallback(
    async (deviceId: string) => {
      if (
        !permissions.canEdit ||
        mutatingDeviceId !== null ||
        editLoadingDeviceId !== null ||
        editSubmitting
      ) {
        return;
      }

      setEditLoadingDeviceId(deviceId);
      setStatus(null);
      setEditError(null);
      setEditServerFieldErrors({});
      try {
        const device = await getDeviceDetail({ deviceId, includeDeleted: true });
        if (device.deleted) {
          setStatus({ kind: 'error', text: 'Видалений пристрій потрібно спочатку відновити.' });
          return;
        }
        setEditDevice(device);
        setEditForm(deviceDetailsToUpsertForm(device));
      } catch (error) {
        setStatus({
          kind: 'error',
          text: `Помилка завантаження пристрою для редагування: ${formatDeviceErrorMessage(error)}`,
        });
      } finally {
        setEditLoadingDeviceId(null);
      }
    },
    [editLoadingDeviceId, editSubmitting, mutatingDeviceId, permissions.canEdit],
  );

  const closeEditDialog = useCallback(() => {
    if (editSubmitting) return;
    setEditDevice(null);
    setEditForm(null);
    setEditError(null);
    setEditServerFieldErrors({});
  }, [editSubmitting]);

  const changeEditForm = useCallback((form: DeviceUpsertForm | null) => {
    setEditForm(form);
    setEditError(null);
    setEditServerFieldErrors({});
  }, []);

  const submitEditDialog = useCallback(
    async (form: DeviceUpsertForm) => {
      if (!permissions.canEdit || editDevice === null || editDevice.deleted || editSubmitting) {
        return;
      }
      if (validateDeviceUpsertForm(form) !== null) {
        setEditError('Перевірте поля форми.');
        return;
      }

      const patch = buildUpdateDevicePatch(editDevice, form);
      if (!hasDeviceUpdatePatchChanges(patch)) {
        setEditError('Немає змін для збереження.');
        return;
      }

      setEditSubmitting(true);
      setEditError(null);
      setEditServerFieldErrors({});
      setStatus(null);
      try {
        const device = await updateDevice(patch);
        setDevices((current) =>
          current.map((item) => (item.id === device.id ? deviceDetailsToListItem(device) : item)),
        );
        setEditDevice(null);
        setEditForm(null);
        setStatus({ kind: 'success', text: 'Пристрій оновлено.' });
        await loadActions.reloadDevices({ includeUnitStats: true });
      } catch (error) {
        const fieldErrors = parseDeviceServerFieldErrors(error);
        setEditServerFieldErrors(fieldErrors);
        setEditError(
          Object.keys(fieldErrors).length > 0
            ? null
            : `Помилка оновлення пристрою: ${formatDeviceErrorMessage(error)}`,
        );
      } finally {
        setEditSubmitting(false);
      }
    },
    [editDevice, editSubmitting, loadActions, permissions.canEdit],
  );

  const deleteRow = useCallback(
    (deviceId: string, deviceName: string) => {
      if (!permissions.canEdit || mutatingDeviceId !== null || editLoadingDeviceId !== null) return;
      setDeleteDialogDevice({ id: deviceId, name: deviceName });
    },
    [editLoadingDeviceId, mutatingDeviceId, permissions.canEdit],
  );

  const closeDeleteDialog = useCallback(() => {
    if (mutatingDeviceId !== null) return;
    setDeleteDialogDevice(null);
  }, [mutatingDeviceId]);

  const confirmDeleteRow = useCallback(async () => {
    if (!permissions.canEdit || deleteDialogDevice === null || mutatingDeviceId !== null) return;

    setMutatingDeviceId(deleteDialogDevice.id);
    setStatus(null);
    try {
      const device = await deleteDevice({ deviceId: deleteDialogDevice.id });
      await refreshAfterLifecycleMutation(deviceDetailsToListItem(device));
      setDeleteDialogDevice(null);
      setStatus({ kind: 'success', text: 'Пристрій видалено.' });
    } catch (error) {
      setStatus({
        kind: 'error',
        text: `Помилка видалення пристрою: ${formatDeviceErrorMessage(error)}`,
      });
    } finally {
      setMutatingDeviceId(null);
    }
  }, [deleteDialogDevice, mutatingDeviceId, permissions.canEdit, refreshAfterLifecycleMutation]);

  const restoreRow = useCallback(
    async (deviceId: string) => {
      if (!permissions.canEdit || mutatingDeviceId !== null) return;

      setMutatingDeviceId(deviceId);
      setStatus(null);
      try {
        const device = await restoreDevice({ deviceId });
        await refreshAfterLifecycleMutation(deviceDetailsToListItem(device));
        setStatus({ kind: 'success', text: 'Пристрій відновлено.' });
      } catch (error) {
        setStatus({
          kind: 'error',
          text: `Помилка відновлення пристрою: ${formatDeviceErrorMessage(error)}`,
        });
      } finally {
        setMutatingDeviceId(null);
      }
    },
    [mutatingDeviceId, permissions.canEdit, refreshAfterLifecycleMutation],
  );

  const hasFilters = hasActiveDevicesFilters(tableStateContext.globalFilter, filters);
  const initialLoadFailed = !loading && rows.length === 0 && status?.kind === 'error';
  const busyDeviceId =
    mutatingDeviceId ?? editLoadingDeviceId ?? (editSubmitting ? (editDevice?.id ?? null) : null);

  return {
    permissions,
    loading,
    refreshing,
    loadingMore,
    rows,
    total,
    hasMore,
    noMoreToLoad: !hasMore,
    sidebarOpen,
    setSidebarOpen,
    filters,
    setFilters,
    status,
    statusCounts,
    bootstrapLoaded,
    creating,
    createDialogOpen: createForm !== null,
    createForm,
    createError,
    createServerFieldErrors,
    editDialogOpen: editForm !== null,
    editForm,
    editError,
    editServerFieldErrors,
    editSubmitting,
    editHasChanges,
    editLoadingDeviceId,
    deleteDialogDevice,
    mutatingDeviceId,
    busyDeviceId,
    aorOptions,
    unitOptions,
    unitStatsView,
    selectedSidebarUnitFilter,
    hasFilters,
    initialLoadFailed,
    tableStateContext,
    setDeletedFilter,
    onPickUnitFilter,
    onClearUnitFilter,
    clearFilters,
    reload,
    loadMore,
    openCreateDialog,
    closeCreateDialog,
    setCreateForm: changeCreateForm,
    submitCreateDialog,
    openEditRow,
    closeEditDialog,
    setEditForm: changeEditForm,
    submitEditDialog,
    deleteRow,
    closeDeleteDialog,
    confirmDeleteRow,
    restoreRow,
  };
}
