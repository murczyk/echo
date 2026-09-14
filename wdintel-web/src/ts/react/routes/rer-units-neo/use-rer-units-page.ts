import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AlertColor } from '@mui/material';
import type {
  CreateUnitWithAutoNetworkRsp,
  ListUnitsReq,
  OrbitUnitDetails,
  Unit,
} from '../../../../Bindings';
import {
  createUnit,
  createUnitWithAutoNetwork,
  deleteUnit,
  getUnitsPage,
  getUnitDetails,
  getUnitIdsWithVisibleAttachments,
  mergeDuplicateUnit,
  updateUnit,
  unlinkOrbitUnit,
  uploadUnitsKmz,
} from '../../services/api/units';
import type { RequestOptions } from '../../services/api/client';
import {
  fetchBgtaskStatusAndLogs,
  getBgtaskProgressFromPercent,
  waitForBgtaskCompletion,
} from '../../services/api/bgtask';
import { currentSystemSettings } from '../../services/api/system-settings';
import { hasRole } from '../../utils/roles';
import type { UnitFormSubmit } from './components/UnitFormDrawer';
import { formatUnitError } from './helpers';

type Status = {
  severity: AlertColor;
  text: string;
} | null;

export type KmzTask = {
  id: number;
  fileName: string;
  running: boolean;
  progress: number;
  logs: string[];
  error: string | null;
};

function sortUnits(units: Unit[]): Unit[] {
  return [...units].sort((left, right) =>
    left.name.localeCompare(right.name, 'uk', { numeric: true, sensitivity: 'base' }),
  );
}

function replaceUnit(units: Unit[], updated: Unit): Unit[] {
  return sortUnits(units.map((unit) => (unit.id === updated.id ? updated : unit)));
}

export function useRerUnitsPage(authUserRoles: string[], listReq: ListUnitsReq) {
  const canEdit = useMemo(() => hasRole(authUserRoles, 'UnitsEditor'), [authUserRoles]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [statusCounts, setStatusCounts] = useState({ active: 0, inactive: 0 });
  const [attachmentUnitIds, setAttachmentUnitIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsReady, setSettingsReady] = useState(!canEdit);
  const [devicesSectionEnabled, setDevicesSectionEnabled] = useState(false);
  const [orbitDataHidden, setOrbitDataHidden] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editUnit, setEditUnit] = useState<Unit | null>(null);
  const [editOrbitUnits, setEditOrbitUnits] = useState<OrbitUnitDetails[]>([]);
  const [orbitLinksLoading, setOrbitLinksLoading] = useState(false);
  const [orbitLinksError, setOrbitLinksError] = useState<string | null>(null);
  const [canLinkEditOrbitUnit, setCanLinkEditOrbitUnit] = useState(false);
  const [unlinkingOrbitUnitId, setUnlinkingOrbitUnitId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Unit | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Unit | null>(null);
  const [mergeProgress, setMergeProgress] = useState<number | null>(null);
  const [mergeProgressLabel, setMergeProgressLabel] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [uploadingKmz, setUploadingKmz] = useState(false);
  const [kmzTask, setKmzTask] = useState<KmzTask | null>(null);
  const mutationRefreshController = useRef<AbortController | null>(null);

  const loadUnits = useCallback(
    async (options?: RequestOptions) => {
      setLoading(true);
      setLoadError(null);
      try {
        const response = await getUnitsPage(listReq, options);
        if (options?.signal?.aborted) return;
        setUnits(response.units);
        setTotalCount(response.totalCount);
        setStatusCounts(response.statusCounts);
        try {
          const unitIds = response.units.map((unit) => unit.id);
          const attachmentIds = await getUnitIdsWithVisibleAttachments(unitIds, options);
          if (!options?.signal?.aborted) setAttachmentUnitIds(new Set(attachmentIds));
        } catch (error) {
          if (options?.signal?.aborted) return;
          setAttachmentUnitIds(new Set());
          setStatus({
            severity: 'error',
            text: `Не вдалося завантажити ознаки наявності файлів: ${formatUnitError(error)}`,
          });
        }
      } catch (error) {
        if (options?.signal?.aborted) return;
        setLoadError(formatUnitError(error));
      } finally {
        if (!options?.signal?.aborted) setLoading(false);
      }
    },
    [listReq],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadUnits({ signal: controller.signal });
    return () => {
      controller.abort();
      mutationRefreshController.current?.abort();
    };
  }, [loadUnits]);

  useEffect(() => {
    if (editUnit === null) {
      setEditOrbitUnits([]);
      setOrbitLinksLoading(false);
      setOrbitLinksError(null);
      setCanLinkEditOrbitUnit(false);
      return;
    }

    let active = true;
    setEditOrbitUnits([]);
    setOrbitLinksLoading(true);
    setOrbitLinksError(null);
    setCanLinkEditOrbitUnit(false);
    void getUnitDetails(editUnit.id)
      .then((details) => {
        if (!active) return;
        setEditOrbitUnits(details.orbitUnits);
        setCanLinkEditOrbitUnit(details.canLinkOrbitUnit);
      })
      .catch((error) => {
        if (active) setOrbitLinksError(formatUnitError(error));
      })
      .finally(() => {
        if (active) setOrbitLinksLoading(false);
      });

    return () => {
      active = false;
    };
  }, [editUnit?.id]);

  useEffect(() => {
    if (!canEdit) {
      setSettingsReady(true);
      return;
    }

    let active = true;
    setSettingsReady(false);
    void currentSystemSettings()
      .then((settings) => {
        if (!active) return;
        setDevicesSectionEnabled(settings.devicesSectionEnabled);
        setOrbitDataHidden(settings.hideOrbitData);
        setSettingsReady(true);
      })
      .catch((error) => {
        if (!active) return;
        setStatus({
          severity: 'error',
          text: `Не вдалося завантажити налаштування створення підрозділу: ${formatUnitError(error)}`,
        });
      });

    return () => {
      active = false;
    };
  }, [canEdit]);

  useEffect(() => {
    if (kmzTask === null || !kmzTask.running) return;

    const taskId = kmzTask.id;
    const fileName = kmzTask.fileName;
    let logs = [...kmzTask.logs];
    let active = true;
    let timeoutId: number | undefined;

    async function poll(skip: number) {
      if (!active) return;
      try {
        const response = await fetchBgtaskStatusAndLogs(taskId, skip);
        if (!active) return;
        logs = [...logs, ...response.loglines];
        const progress = getBgtaskProgressFromPercent(logs, response.progress);
        setKmzTask((current) =>
          current === null
            ? null
            : {
                ...current,
                running: response.running,
                progress: Math.round((progress.curr / progress.overall) * 100),
                logs,
                error: response.finishedWithError,
              },
        );

        if (response.running) {
          timeoutId = window.setTimeout(() => void poll(skip + response.loglines.length), 1000);
        } else {
          setStatus({
            severity: response.finishedWithError === null ? 'success' : 'error',
            text:
              response.finishedWithError === null
                ? `KMZ-файл «${fileName}» оброблено.`
                : `Не вдалося обробити KMZ-файл: ${response.finishedWithError}`,
          });
        }
      } catch (error) {
        if (!active) return;
        const message = formatUnitError(error);
        setKmzTask((current) =>
          current === null ? null : { ...current, running: false, error: message },
        );
        setStatus({
          severity: 'error',
          text: `Не вдалося отримати стан обробки KMZ-файлу: ${message}`,
        });
      }
    }

    void poll(kmzTask.logs.length);
    return () => {
      active = false;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [kmzTask?.id]);

  function openCreateDialog() {
    setDialogError(null);
    setCreateOpen(true);
  }

  function openEditDialog(unit: Unit) {
    setDialogError(null);
    setEditUnit(unit);
  }

  function openDeleteDialog(unit: Unit) {
    setDialogError(null);
    setDeleteTarget(unit);
  }

  function openMergeDialog(unit: Unit) {
    setDialogError(null);
    setMergeProgress(null);
    setMergeProgressLabel(null);
    setMergeTarget(unit);
  }

  function closeDialogs() {
    if (submitting || unlinkingOrbitUnitId !== null) return;
    setCreateOpen(false);
    setEditUnit(null);
    setDeleteTarget(null);
    setMergeTarget(null);
    setMergeProgress(null);
    setMergeProgressLabel(null);
    setDialogError(null);
  }

  async function unlinkEditOrbitUnit(orbitUnit: OrbitUnitDetails) {
    if (editUnit === null || unlinkingOrbitUnitId !== null) return;
    const sigintUnit = editUnit;
    setUnlinkingOrbitUnitId(orbitUnit.unitId);
    setOrbitLinksError(null);
    try {
      await unlinkOrbitUnit({ sigintUnitId: sigintUnit.id, orbitUnitId: orbitUnit.unitId });
      const details = await getUnitDetails(sigintUnit.id);
      setEditUnit(details.unit);
      setEditOrbitUnits(details.orbitUnits);
      setCanLinkEditOrbitUnit(details.canLinkOrbitUnit);
      setUnits((current) => replaceUnit(current, details.unit));
      setStatus({
        severity: 'success',
        text: `Прив’язку підрозділу «${sigintUnit.name}» до Orbit видалено.`,
      });
    } catch (error) {
      setOrbitLinksError(formatUnitError(error));
    } finally {
      setUnlinkingOrbitUnitId(null);
    }
  }

  async function refreshLinkedEditOrbitUnit() {
    if (editUnit === null) return;
    const sigintUnit = editUnit;
    setOrbitLinksLoading(true);
    setOrbitLinksError(null);
    try {
      const details = await getUnitDetails(sigintUnit.id);
      setEditUnit(details.unit);
      setEditOrbitUnits(details.orbitUnits);
      setCanLinkEditOrbitUnit(details.canLinkOrbitUnit);
      setUnits((current) => replaceUnit(current, details.unit));
      setStatus({
        severity: 'success',
        text: `Підрозділ «${sigintUnit.name}» прив’язано до Orbit.`,
      });
    } catch (error) {
      setOrbitLinksError(formatUnitError(error));
    } finally {
      setOrbitLinksLoading(false);
    }
  }

  async function refreshUnitsAfterMutation(successText: string) {
    mutationRefreshController.current?.abort();
    const controller = new AbortController();
    mutationRefreshController.current = controller;
    const options = { signal: controller.signal };
    try {
      const response = await getUnitsPage(listReq, options);
      if (controller.signal.aborted) return;
      const attachmentIds = await getUnitIdsWithVisibleAttachments(
        response.units.map((unit) => unit.id),
        options,
      );
      if (controller.signal.aborted) return;
      setUnits(response.units);
      setTotalCount(response.totalCount);
      setStatusCounts(response.statusCounts);
      setAttachmentUnitIds(new Set(attachmentIds));
      setStatus({ severity: 'success', text: successText });
    } catch (error) {
      if (controller.signal.aborted) return;
      setStatus({
        severity: 'warning',
        text: `${successText} Не вдалося оновити список: ${formatUnitError(error)}`,
      });
    } finally {
      if (mutationRefreshController.current === controller) {
        mutationRefreshController.current = null;
      }
    }
  }

  async function submitUnit(value: UnitFormSubmit) {
    setSubmitting(true);
    setDialogError(null);
    try {
      let successText: string;
      if (editUnit !== null) {
        const updated = await updateUnit({
          ...editUnit,
          ...value.unit,
          name: value.unit.name ?? '',
        });
        setUnits((current) => replaceUnit(current, updated));
        successText = `Підрозділ «${updated.name}» оновлено.`;
      } else if (value.autoNetwork !== undefined) {
        const created = await createUnitWithAutoNetwork({
          unit: value.unit,
          ...value.autoNetwork,
        });
        setUnits((current) => sortUnits([...current, created.unit]));
        successText =
          created.networkId === null
            ? `Підрозділ «${created.unit.name}» створено без мережі.`
            : `Підрозділ «${created.unit.name}» і радіомережу створено.`;
      } else {
        const created = await createUnit(value.unit);
        setUnits((current) => sortUnits([...current, created]));
        successText = `Підрозділ «${created.name}» створено.`;
      }
      setCreateOpen(false);
      setEditUnit(null);
      void refreshUnitsAfterMutation(successText);
    } catch (error) {
      setDialogError(formatUnitError(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function addImportedOrbitUnit(response: CreateUnitWithAutoNetworkRsp) {
    setUnits((current) => sortUnits([...current, response.unit]));
    await refreshUnitsAfterMutation(
      response.networkId === null
        ? `Підрозділ «${response.unit.name}» імпортовано з Orbit.`
        : `Підрозділ «${response.unit.name}» імпортовано з Orbit і створено радіомережу.`,
    );
  }

  async function confirmDelete() {
    if (deleteTarget === null) return;
    setSubmitting(true);
    setDialogError(null);
    try {
      await deleteUnit(deleteTarget.id);
      setUnits((current) => current.filter((unit) => unit.id !== deleteTarget.id));
      setAttachmentUnitIds((current) => {
        const next = new Set(current);
        next.delete(deleteTarget.id);
        return next;
      });
      await refreshUnitsAfterMutation(`Підрозділ «${deleteTarget.name}» видалено.`);
      setDeleteTarget(null);
    } catch (error) {
      setDialogError(formatUnitError(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmMerge(duplicate: Unit) {
    if (mergeTarget === null) return;
    setSubmitting(true);
    setDialogError(null);
    setMergeProgress(0);
    setMergeProgressLabel(null);
    try {
      const taskId = await mergeDuplicateUnit({
        originalId: mergeTarget.id,
        cloneToDeleteId: duplicate.id,
      });
      await waitForBgtaskCompletion(taskId, (progress, logline) => {
        setMergeProgress((current) => Math.max(current ?? 0, progress));
        if (logline !== null) setMergeProgressLabel(logline);
      });
      await refreshUnitsAfterMutation(`Підрозділ «${duplicate.name}» об’єднано.`);
      setMergeTarget(null);
      setMergeProgress(null);
      setMergeProgressLabel(null);
    } catch (error) {
      setDialogError(formatUnitError(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadKmz(file: File) {
    setUploadingKmz(true);
    setStatus(null);
    try {
      const taskId = await uploadUnitsKmz(file);
      setKmzTask({
        id: taskId,
        fileName: file.name,
        running: true,
        progress: 0,
        logs: [],
        error: null,
      });
      setStatus({
        severity: 'info',
        text: `KMZ-файл прийнято в обробку. Фонова задача #${taskId}.`,
      });
    } catch (error) {
      setStatus({
        severity: 'error',
        text: `Не вдалося підвантажити KMZ-файл: ${formatUnitError(error)}`,
      });
    } finally {
      setUploadingKmz(false);
    }
  }

  return {
    units,
    totalCount,
    statusCounts,
    attachmentUnitIds,
    loading,
    loadError,
    loadUnits,
    canEdit,
    canImportOrbit: canEdit && !orbitDataHidden,
    orbitDataHidden,
    settingsReady,
    devicesSectionEnabled,
    status,
    createOpen,
    editUnit,
    editOrbitUnits,
    orbitLinksLoading,
    orbitLinksError,
    canLinkEditOrbitUnit,
    unlinkingOrbitUnitId,
    deleteTarget,
    mergeTarget,
    mergeProgress,
    mergeProgressLabel,
    submitting,
    dialogError,
    uploadingKmz,
    kmzTask,
    openCreateDialog,
    openEditDialog,
    openDeleteDialog,
    openMergeDialog,
    closeDialogs,
    unlinkEditOrbitUnit,
    refreshLinkedEditOrbitUnit,
    submitUnit,
    addImportedOrbitUnit,
    confirmDelete,
    confirmMerge,
    uploadKmz,
  };
}
