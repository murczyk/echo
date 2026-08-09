import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AreaOfResponsibility,
  DeviceDetails,
  DeviceListItem,
  DeviceStatusCounts,
  Unit,
} from '../../../../Bindings';
import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { redirectToLogin } from '../../auth-redirect';
import {
  isAbortError,
  isNetworkRequestError,
  isUnauthorizedError,
} from '../../services/api/client';
import {
  createDevice,
  getDeviceDetail,
  listDeviceAors,
  listDeviceUnits,
  updateDevice,
} from '../../services/api/devices';
import { navigateWithinSpa } from '../../utils/browser';
import { resolveDevicesCapabilities } from '../../utils/roles';
import {
  buildDeviceRowView,
  buildDevicesColumnFilters,
  resolveDevicesColumnFilters,
  deviceDetailsToListItem,
  formatDeviceErrorMessage,
  hasActiveDevicesFilters,
  isSameDeviceSidebarUnitFilter,
  mergeCurrentDeviceUnitOption,
  mergeDeviceUnitStatsWithUnits,
  resolveAorOptions,
  resolveDeviceSidebarUnitIds,
  resolveUnitOptions,
  type DeviceArchivedFilterValue,
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
import { useDevicesSidebarResource } from './use-devices-sidebar-resource';
import type { SelectedSidebarUnitFilter } from '../rer-callsigns-neo/types';

export function useDevicesPage({ authUserRoles = [] }: { authUserRoles?: string[] } = {}) {
  const tableStateContext = useTableStateContext();
  const capabilities = useMemo(() => resolveDevicesCapabilities(authUserRoles), [authUserRoles]);
  const permissions = useMemo(
    () => ({
      canRead: capabilities.canRead,
      canCreate: capabilities.canCreate,
      canEdit: capabilities.canWriteSourceData || capabilities.canWriteAnalyticalData,
      canSyncFiles: capabilities.canWriteSourceData,
      fieldPermissions: {
        sourceData: capabilities.canWriteSourceData,
        analyticalData: capabilities.canWriteAnalyticalData,
      },
    }),
    [capabilities],
  );
  const sidebarResource = useDevicesSidebarResource(
    permissions.canRead,
    permissions.fieldPermissions.analyticalData,
  );

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [devices, setDevices] = useState<DeviceListItem[]>([]);
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);
  const [lookupUnits, setLookupUnits] = useState<Unit[]>([]);
  const [lookupsLoading, setLookupsLoading] = useState(false);
  const [lookupsLoaded, setLookupsLoaded] = useState(false);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [statusCounts, setStatusCounts] = useState<DeviceStatusCounts | null>(null);
  const [status, setStatus] = useState<DevicesUiMessage>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  const persistedFilters = useMemo(
    () => resolveDevicesColumnFilters(tableStateContext.columnFilters),
    [tableStateContext.columnFilters],
  );
  const selectedSidebarUnitFilter = persistedFilters.selectedSidebarUnitFilter;
  const filters = useMemo<DevicesFilterState>(
    () => ({
      archivedFilter: persistedFilters.archivedFilter,
      unitIds: resolveDeviceSidebarUnitIds(selectedSidebarUnitFilter, sidebarResource.units),
    }),
    [persistedFilters.archivedFilter, selectedSidebarUnitFilter, sidebarResource.units],
  );
  const persistFilters = useCallback(
    (
      archivedFilter: DeviceArchivedFilterValue,
      selectedUnitFilter: SelectedSidebarUnitFilter | null,
    ) => {
      tableStateContext.onColumnFiltersChange(
        buildDevicesColumnFilters({
          archivedFilter,
          selectedSidebarUnitFilter: selectedUnitFilter,
        }),
      );
    },
    [tableStateContext],
  );
  const setFilters = useCallback(
    (updater: DevicesFilterState | ((current: DevicesFilterState) => DevicesFilterState)) => {
      const nextFilters = typeof updater === 'function' ? updater(filters) : updater;
      persistFilters(nextFilters.archivedFilter, selectedSidebarUnitFilter);
    },
    [filters, persistFilters, selectedSidebarUnitFilter],
  );

  const requestSeqRef = useRef(0);
  const mainAbortRef = useRef<AbortController | null>(null);
  const lookupsAbortRef = useRef<AbortController | null>(null);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const devicesLengthRef = useRef(0);
  const latestQuerySnapshotRef = useRef<DevicesQuerySnapshot | null>(null);
  const lastExecutedFullQueryKeyRef = useRef<string | null>(null);

  useEffect(() => {
    devicesLengthRef.current = devices.length;
  }, [devices.length]);

  const rows = useMemo(() => devices.map(buildDeviceRowView), [devices]);
  const unitsById = useMemo(
    () => new Map(sidebarResource.units.map((unit) => [unit.id, unit])),
    [sidebarResource.units],
  );
  const aorOptions = useMemo<DeviceLookupOption[]>(() => resolveAorOptions(aors), [aors]);
  const unitOptions = useMemo<DeviceLookupOption[]>(() => {
    const options = resolveUnitOptions(lookupsLoaded ? lookupUnits : sidebarResource.units);
    return mergeCurrentDeviceUnitOption(options, editDevice?.unit ?? null);
  }, [editDevice?.unit, lookupUnits, lookupsLoaded, sidebarResource.units]);
  const unitStatsView = useMemo(
    () => mergeDeviceUnitStatsWithUnits(sidebarResource.unitStats, unitsById),
    [sidebarResource.unitStats, unitsById],
  );
  const editHasChanges = useMemo(() => {
    if (editDevice === null || editForm === null) return false;
    return hasDeviceUpdatePatchChanges(
      buildUpdateDevicePatch(editDevice, editForm, permissions.fieldPermissions),
    );
  }, [editDevice, editForm, permissions.fieldPermissions]);

  const normalizedGlobalFilter = tableStateContext.globalFilter.trim();
  const querySnapshot = useMemo<DevicesQuerySnapshot>(
    () => ({
      globalFilter: normalizedGlobalFilter,
      filters,
      sorting: tableStateContext.sorting,
      fullQueryKey: JSON.stringify({
        globalFilter: normalizedGlobalFilter,
        filters,
        sorting: tableStateContext.sorting,
      }),
    }),
    [filters, normalizedGlobalFilter, tableStateContext.sorting],
  );

  useEffect(() => {
    latestQuerySnapshotRef.current = querySnapshot;
  }, [querySnapshot]);

  const loadActions = useMemo(
    () =>
      createDevicesLoadActions({
        latestQuerySnapshotRef,
        requestSeqRef,
        mainAbortRef,
        loadMoreAbortRef,
        devicesLengthRef,
        lastExecutedFullQueryKeyRef,
        setLoading,
        setRefreshing,
        setLoadingMore,
        setDevices,
        setTotal,
        setHasMore,
        setStatusCounts,
        setStatus,
      }),
    [],
  );

  useEffect(() => {
    if (!permissions.canRead) {
      setLoading(false);
      setStatus({ kind: 'error', text: 'Немає доступу до пристроїв.' });
      return;
    }

    if (lastExecutedFullQueryKeyRef.current === null) {
      void loadActions.loadDevices(querySnapshot);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void loadActions.loadDevices(querySnapshot);
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [loadActions, permissions.canRead, querySnapshot]);

  useEffect(
    () => () => {
      loadActions.dispose();
      lookupsAbortRef.current?.abort();
    },
    [loadActions],
  );

  const setArchivedFilter = useCallback(
    (archivedFilter: DeviceArchivedFilterValue) => {
      persistFilters(archivedFilter, selectedSidebarUnitFilter);
    },
    [persistFilters, selectedSidebarUnitFilter],
  );

  const onPickUnitFilter = useCallback(
    (filter: SelectedSidebarUnitFilter) => {
      persistFilters(
        filters.archivedFilter,
        isSameDeviceSidebarUnitFilter(selectedSidebarUnitFilter, filter) ? null : filter,
      );
    },
    [filters.archivedFilter, persistFilters, selectedSidebarUnitFilter],
  );

  const onClearUnitFilter = useCallback(() => {
    persistFilters(filters.archivedFilter, null);
  }, [filters.archivedFilter, persistFilters]);

  const clearFilters = useCallback(() => {
    tableStateContext.onChangeGlobalFilter('');
    persistFilters('active', null);
  }, [persistFilters, tableStateContext]);

  const reload = useCallback(async () => {
    await Promise.all([loadActions.reloadDevices(), sidebarResource.reload()]);
  }, [loadActions, sidebarResource]);
  const loadMore = useCallback(() => loadActions.loadMoreDevices(), [loadActions]);

  const openCreateDialog = useCallback(() => {
    if (!permissions.canCreate) return;
    setCreateForm(createDefaultDeviceUpsertForm());
    setCreateError(null);
    setCreateServerFieldErrors({});
  }, [permissions.canCreate]);

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
      if (!permissions.canCreate || creating) return;
      if (validateDeviceUpsertForm(form, permissions.fieldPermissions) !== null) {
        setCreateError('Перевірте поля форми.');
        return;
      }

      setCreating(true);
      setCreateError(null);
      setCreateServerFieldErrors({});
      setStatus(null);
      try {
        const device = await createDevice(buildCreateDeviceReq(form, permissions.fieldPermissions));
        await loadActions.reloadDevices();
        navigateWithinSpa(`/devices/${device.id}`);
      } catch (error) {
        const fieldErrors = parseDeviceServerFieldErrors(error);
        const resultUncertain = isNetworkRequestError(error);
        setCreateServerFieldErrors(fieldErrors);
        setCreateError(
          Object.keys(fieldErrors).length > 0
            ? null
            : resultUncertain
              ? `Результат створення пристрою невідомий. Перевірте список перед повторною спробою. ${formatDeviceErrorMessage(error)}`
              : `Помилка створення пристрою: ${formatDeviceErrorMessage(error)}`,
        );
        if (resultUncertain) await loadActions.reloadDevices();
      } finally {
        setCreating(false);
      }
    },
    [creating, loadActions, permissions.canCreate, permissions.fieldPermissions],
  );

  const loadAnalyticalLookups = useCallback(async (): Promise<string | null> => {
    if (!permissions.fieldPermissions.analyticalData || lookupsLoaded) return null;

    lookupsAbortRef.current?.abort();
    const controller = new AbortController();
    lookupsAbortRef.current = controller;
    setLookupsLoading(true);

    try {
      const [nextAors, nextUnits] = await Promise.all([
        listDeviceAors({ signal: controller.signal }),
        listDeviceUnits({ signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return null;

      setAors(nextAors);
      setLookupUnits(nextUnits);
      setLookupsLoaded(true);
      return null;
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return null;
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return null;
      }
      return `Помилка завантаження довідників пристрою: ${formatDeviceErrorMessage(error)}`;
    } finally {
      if (lookupsAbortRef.current === controller) lookupsAbortRef.current = null;
      if (!controller.signal.aborted) setLookupsLoading(false);
    }
  }, [lookupsLoaded, permissions.fieldPermissions.analyticalData]);

  const openEditRow = useCallback(
    async (deviceId: string) => {
      if (!permissions.canEdit || editLoadingDeviceId !== null || editSubmitting) {
        return;
      }

      setEditLoadingDeviceId(deviceId);
      setStatus(null);
      setEditError(null);
      setEditServerFieldErrors({});
      try {
        const [device, lookupError] = await Promise.all([
          getDeviceDetail({ deviceId, includeArchived: true }),
          loadAnalyticalLookups(),
        ]);
        if (device.archived) {
          setStatus({ kind: 'error', text: 'Архівований пристрій потрібно спочатку відновити.' });
          return;
        }
        setEditDevice(device);
        setEditForm(deviceDetailsToUpsertForm(device));
        setEditError(lookupError);
      } catch (error) {
        setStatus({
          kind: 'error',
          text: `Помилка завантаження пристрою для редагування: ${formatDeviceErrorMessage(error)}`,
        });
      } finally {
        setEditLoadingDeviceId(null);
      }
    },
    [editLoadingDeviceId, editSubmitting, loadAnalyticalLookups, permissions.canEdit],
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
      if (!permissions.canEdit || editDevice === null || editDevice.archived || editSubmitting) {
        return;
      }
      if (validateDeviceUpsertForm(form, permissions.fieldPermissions) !== null) {
        setEditError('Перевірте поля форми.');
        return;
      }

      const patch = buildUpdateDevicePatch(editDevice, form, permissions.fieldPermissions);
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
        await Promise.all([loadActions.reloadDevices(), sidebarResource.reload()]);
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
        if (resultUncertain) {
          await Promise.all([loadActions.reloadDevices(), sidebarResource.reload()]);
        }
      } finally {
        setEditSubmitting(false);
      }
    },
    [editDevice, editSubmitting, loadActions, permissions, sidebarResource],
  );

  const hasFilters = hasActiveDevicesFilters(tableStateContext.globalFilter, filters);
  const initialLoadFailed = !loading && rows.length === 0 && status?.kind === 'error';
  const busyDeviceId = editLoadingDeviceId ?? (editSubmitting ? (editDevice?.id ?? null) : null);

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
    bootstrapLoaded: sidebarResource.loaded,
    sidebarLoading: sidebarResource.loading,
    sidebarError: sidebarResource.error,
    reloadSidebar: sidebarResource.reload,
    lookupsLoading,
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
    busyDeviceId,
    aorOptions,
    unitOptions,
    unitStatsView,
    selectedSidebarUnitFilter,
    hasFilters,
    initialLoadFailed,
    tableStateContext,
    setArchivedFilter,
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
  };
}
