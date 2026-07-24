import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AlertColor } from '@mui/material';
import type { Unit } from '../../../../Bindings';
import {
  createUnit,
  createUnitWithAutoNetwork,
  deleteUnit,
  getUnitsList,
  getUnitIdsWithVisibleAttachments,
  mergeDuplicateUnit,
  updateUnit,
  uploadUnitsKmz,
} from '../../services/api/units';
import { fetchBgtaskStatusAndLogs, getBgtaskProgressFromPercent } from '../../services/api/bgtask';
import { currentSystemSettings } from '../../services/api/system-settings';
import { hasRole } from '../../utils/roles';
import type { UnitFormSubmit } from './components/UnitFormDialog';
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

export function useRerUnitsPage(authUserRoles: string[]) {
  const canEdit = useMemo(() => hasRole(authUserRoles, 'UnitsEditor'), [authUserRoles]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [attachmentUnitIds, setAttachmentUnitIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsReady, setSettingsReady] = useState(!canEdit);
  const [devicesSectionEnabled, setDevicesSectionEnabled] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editUnit, setEditUnit] = useState<Unit | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Unit | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Unit | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [uploadingKmz, setUploadingKmz] = useState(false);
  const [kmzTask, setKmzTask] = useState<KmzTask | null>(null);

  const loadUnits = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [unitsResult, attachmentIdsResult] = await Promise.allSettled([
      getUnitsList(),
      getUnitIdsWithVisibleAttachments(),
    ]);
    if (unitsResult.status === 'fulfilled') {
      setUnits(sortUnits(unitsResult.value));
    } else {
      setLoadError(formatUnitError(unitsResult.reason));
    }
    if (attachmentIdsResult.status === 'fulfilled') {
      setAttachmentUnitIds(new Set(attachmentIdsResult.value));
    } else {
      setAttachmentUnitIds(new Set());
      setStatus({
        severity: 'error',
        text: `Не вдалося завантажити ознаки наявності файлів: ${formatUnitError(
          attachmentIdsResult.reason,
        )}`,
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadUnits();
  }, [loadUnits]);

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
    setMergeTarget(unit);
  }

  function closeDialogs() {
    if (submitting) return;
    setCreateOpen(false);
    setEditUnit(null);
    setDeleteTarget(null);
    setMergeTarget(null);
    setDialogError(null);
  }

  async function submitUnit(value: UnitFormSubmit) {
    setSubmitting(true);
    setDialogError(null);
    try {
      if (editUnit !== null) {
        const updated = await updateUnit({ ...editUnit, ...value.unit });
        setUnits((current) => replaceUnit(current, updated));
        setStatus({ severity: 'success', text: `Підрозділ «${updated.name}» оновлено.` });
      } else if (value.autoNetwork !== undefined) {
        const created = await createUnitWithAutoNetwork({
          unit: value.unit,
          ...value.autoNetwork,
        });
        setUnits((current) => sortUnits([...current, created.unit]));
        setStatus({
          severity: 'success',
          text:
            created.networkId === null
              ? `Підрозділ «${created.unit.name}» створено без мережі.`
              : `Підрозділ «${created.unit.name}» і радіомережу створено.`,
        });
      } else {
        const created = await createUnit(value.unit);
        setUnits((current) => sortUnits([...current, created]));
        setStatus({ severity: 'success', text: `Підрозділ «${created.name}» створено.` });
      }
      setCreateOpen(false);
      setEditUnit(null);
    } catch (error) {
      setDialogError(formatUnitError(error));
    } finally {
      setSubmitting(false);
    }
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
      setStatus({ severity: 'success', text: `Підрозділ «${deleteTarget.name}» видалено.` });
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
    try {
      const merged = await mergeDuplicateUnit({
        originalId: mergeTarget.id,
        cloneToDeleteId: duplicate.id,
      });
      setUnits((current) =>
        replaceUnit(
          current.filter((unit) => unit.id !== duplicate.id),
          merged,
        ),
      );
      setAttachmentUnitIds((current) => {
        const next = new Set(current);
        if (next.delete(duplicate.id)) next.add(merged.id);
        return next;
      });
      setStatus({
        severity: 'success',
        text: `Підрозділ «${duplicate.name}» об’єднано з «${merged.name}».`,
      });
      setMergeTarget(null);
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
    attachmentUnitIds,
    loading,
    loadError,
    loadUnits,
    canEdit,
    settingsReady,
    devicesSectionEnabled,
    status,
    createOpen,
    editUnit,
    deleteTarget,
    mergeTarget,
    submitting,
    dialogError,
    uploadingKmz,
    kmzTask,
    openCreateDialog,
    openEditDialog,
    openDeleteDialog,
    openMergeDialog,
    closeDialogs,
    submitUnit,
    confirmDelete,
    confirmMerge,
    uploadKmz,
  };
}
