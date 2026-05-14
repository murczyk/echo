import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AreaOfResponsibility, UpdateAreaOfResponsibilityReportOrderReq } from '../../../../Bindings';
import { listAors, updateAorReportOrders } from '../../services/api/aor';

export type ReportsRow = {
  id: number;
  name: string;
  orderInput: string;
  initialOrder: number;
};

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

type Props = {
  active: boolean;
  userRoles: string[];
};

type Result = {
  canRead: boolean;
  canEdit: boolean;
  hasInvalidRows: boolean;
  isDirty: boolean;
  loadStatus: LoadStatus;
  loadError: string | null;
  saveError: string | null;
  saveSuccess: string | null;
  saveInProgress: boolean;
  rows: ReportsRow[];
  rowPairs: Array<[ReportsRow, ReportsRow | null]>;
  setRowOrderInput: (rowId: number, value: string) => void;
  save: () => Promise<void>;
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Невідома помилка. Спробуйте ще раз.';
}

function toRows(aors: AreaOfResponsibility[]): ReportsRow[] {
  return [...aors]
    .filter((aor) => aor.isTopLevel)
    .sort(
      (left, right) =>
        left.orderForReport - right.orderForReport
        || left.name.localeCompare(right.name, 'uk'),
    )
    .map((aor) => ({
      id: aor.id,
      name: aor.name,
      orderInput: String(aor.orderForReport),
      initialOrder: aor.orderForReport,
    }));
}

function parseOrderInput(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function useReportsSettings({ active, userRoles }: Props): Result {
  const [rows, setRows] = useState<ReportsRow[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = useState(false);

  const canRead = useMemo(
    () => userRoles.some((role) => ['Admin', 'Rer', 'UnitsEditor'].includes(role)),
    [userRoles],
  );
  const canEdit = useMemo(
    () => userRoles.some((role) => ['Admin', 'Rer'].includes(role)),
    [userRoles],
  );

  useEffect(() => {
    if (!active || !canRead) return;

    const abortController = new AbortController();

    async function load() {
      setLoadStatus('loading');
      setLoadError(null);

      try {
        const aors = await listAors(
          { sortBy: 'AreaOfResponsibilityNameAsc' },
          abortController.signal,
        );
        if (abortController.signal.aborted) return;
        setRows(toRows(aors));
        setLoadStatus('ready');
      } catch (error) {
        if (abortController.signal.aborted) return;
        setLoadError(`Помилка завантаження: ${formatErrorMessage(error)}`);
        setLoadStatus('error');
      }
    }

    load();

    return () => {
      abortController.abort();
    };
  }, [active, canRead]);

  const hasInvalidRows = rows.some((row) => parseOrderInput(row.orderInput) === null);
  const isDirty = rows.some((row) => parseOrderInput(row.orderInput) !== row.initialOrder);

  const rowPairs = useMemo(() => {
    const pairs: Array<[ReportsRow, ReportsRow | null]> = [];
    for (let index = 0; index < rows.length; index += 2) {
      pairs.push([rows[index]!, rows[index + 1] ?? null]);
    }
    return pairs;
  }, [rows]);

  const setRowOrderInput = useCallback((rowId: number, value: string) => {
    setSaveSuccess(null);
    setRows((currentRows) =>
      currentRows.map((currentRow) =>
        currentRow.id === rowId
          ? { ...currentRow, orderInput: value }
          : currentRow,
      ),
    );
  }, []);

  const save = useCallback(async () => {
    if (!canEdit || hasInvalidRows || !isDirty || saveInProgress) return;

    setSaveError(null);
    setSaveSuccess(null);
    setSaveInProgress(true);

    try {
      const req: UpdateAreaOfResponsibilityReportOrderReq = {
        items: rows.map((row) => ({
          id: row.id,
          orderForReport: parseOrderInput(row.orderInput) ?? row.initialOrder,
        })),
      };
      const updated = await updateAorReportOrders(req);
      setRows(toRows(updated));
      setSaveSuccess('Порядок звітів збережено');
    } catch (error) {
      setSaveError(`Помилка збереження: ${formatErrorMessage(error)}`);
    } finally {
      setSaveInProgress(false);
    }
  }, [canEdit, hasInvalidRows, isDirty, rows, saveInProgress]);

  return {
    canRead,
    canEdit,
    hasInvalidRows,
    isDirty,
    loadStatus,
    loadError,
    saveError,
    saveSuccess,
    saveInProgress,
    rows,
    rowPairs,
    setRowOrderInput,
    save,
  };
}
