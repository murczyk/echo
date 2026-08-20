import { useCallback, useEffect, useRef, useState } from 'react';

import type { DeviceFileTreeEntry, SyncSummary } from '../../../../Bindings';
import { syncDeviceFiles } from '../../services/api/devices';
import {
  applySyncDeviceFilesRsp,
  buildSyncDeviceFilesReq,
  createDeviceFileSyncRowFromEntry,
  createEmptyDeviceFileSyncRow,
  parseSyncRequestError,
  updateSyncRowField,
} from './helpers';
import type { DeviceFileSyncField, DeviceFileSyncRow, DeviceFileSyncSeed } from './types';

function validateSyncRows(rows: DeviceFileSyncRow[]): DeviceFileSyncRow[] {
  return rows.map((row) => {
    if (row.result?.kind === 'accepted') return row;
    const fieldErrors = { ...row.fieldErrors };
    if (row.absolutePath === '') fieldErrors.absolutePath = 'Вкажіть абсолютний шлях.';
    return { ...row, fieldErrors };
  });
}

function hasSyncRowErrors(rows: DeviceFileSyncRow[]): boolean {
  return rows.some(
    (row) => row.result?.kind !== 'accepted' && Object.values(row.fieldErrors).some(Boolean),
  );
}

export function useDeviceFilesSync({
  deviceId,
  canSync,
  onCommitted,
}: {
  deviceId: string;
  canSync: boolean;
  onCommitted: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<DeviceFileSyncRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [transportUncertain, setTransportUncertain] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const submittingRef = useRef(false);
  const canSyncRef = useRef(canSync);
  canSyncRef.current = canSync;

  const openSync = useCallback(
    (seed?: DeviceFileSyncSeed) => {
      if (!canSync || submittingRef.current) return;
      setRows([
        seed?.entry ? createDeviceFileSyncRowFromEntry(seed.entry) : createEmptyDeviceFileSyncRow(),
      ]);
      setBatchError(null);
      setTransportUncertain(false);
      setSyncSummary(null);
      setOpen(true);
    },
    [canSync],
  );

  const openSyncForEntry = useCallback(
    (entry: DeviceFileTreeEntry) => {
      if (entry.kind !== 'file') return;
      openSync({ entry });
    },
    [openSync],
  );

  const closeSync = useCallback(() => {
    if (submittingRef.current) return;
    setOpen(false);
  }, []);

  const addRow = useCallback(() => {
    if (!canSync || submittingRef.current) return;
    setRows((current) => [...current, createEmptyDeviceFileSyncRow()]);
    setBatchError(null);
  }, [canSync]);

  const removeRow = useCallback(
    (localId: string) => {
      if (!canSync || submittingRef.current) return;
      setRows((current) => current.filter((row) => row.localId !== localId));
      setBatchError(null);
    },
    [canSync],
  );

  const changeRowField = useCallback(
    (localId: string, field: DeviceFileSyncField, value: string | null) => {
      if (!canSync || submittingRef.current) return;
      setRows((current) =>
        current.map((row) =>
          row.localId === localId ? updateSyncRowField(row, field, value) : row,
        ),
      );
      setBatchError(null);
      setTransportUncertain(false);
    },
    [canSync],
  );

  const submit = useCallback(async () => {
    if (!canSync || submittingRef.current) return;
    const validatedRows = validateSyncRows(rows);
    setRows(validatedRows);
    if (hasSyncRowErrors(validatedRows)) {
      setBatchError('Виправте помилки в рядках батча.');
      return;
    }

    const { req, submittedRowIds } = buildSyncDeviceFilesReq({
      deviceId,
      rows: validatedRows,
    });
    if (req.files.length === 0) {
      setBatchError('Усі рядки вже успішно синхронізовано.');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setBatchError(null);
    setTransportUncertain(false);
    setSyncSummary(null);
    setRows((current) =>
      current.map((row) =>
        submittedRowIds.includes(row.localId) ? { ...row, fieldErrors: {}, result: null } : row,
      ),
    );

    try {
      const rsp = await syncDeviceFiles(req);
      setSyncSummary(rsp.sync);
      setRows((current) => applySyncDeviceFilesRsp(current, submittedRowIds, rsp));
      if (rsp.sync.counts.accepted > 0) await onCommitted();
    } catch (error) {
      const parsed = parseSyncRequestError(error, submittedRowIds);
      setBatchError(parsed.batchError);
      setTransportUncertain(parsed.transportUncertain);
      setRows((current) =>
        current.map((row) => ({
          ...row,
          fieldErrors: parsed.rowErrors.get(row.localId) ?? row.fieldErrors,
        })),
      );
      if (parsed.transportUncertain) await onCommitted();
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
      if (!canSyncRef.current) setOpen(false);
    }
  }, [canSync, deviceId, onCommitted, rows]);

  useEffect(() => {
    if (!canSync && !submittingRef.current) setOpen(false);
  }, [canSync]);

  return {
    open,
    rows,
    submitting,
    batchError,
    transportUncertain,
    syncSummary,
    canSubmit: rows.some((row) => row.result?.kind !== 'accepted'),
    openSync,
    openSyncForEntry,
    closeSync,
    addRow,
    removeRow,
    changeRowField,
    submit,
  };
}
