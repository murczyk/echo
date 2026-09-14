import MergeIcon from '@mui/icons-material/Merge';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Box, Link, Stack, Tooltip } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import type { Unit, UnitDuplicate } from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerIconButton } from '../../components/PowerIconButton';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import {
  mrtCustomCell,
  mrtTextCell,
  type AppMrtColumnDef,
} from '../../components/mui-customized/table/get-default-table-options';
import { MrtOverflowText } from '../../components/mui-customized/table/mrt-overflow';
import { getUnitDuplicates, mergeDuplicateUnit } from '../../services/api/units';
import {
  BgtaskFailedError,
  clearPendingUnitMerge,
  loadPendingUnitMerge,
  savePendingUnitMerge,
  waitForBgtaskCompletion,
} from '../../services/api/bgtask';
import type { PendingUnitMerge } from '../../services/api/bgtask';
import { handleNavigateWithinSpaClick } from '../../utils/browser';
import { hasRole } from '../../utils/roles';
import { SettingsNeoTable } from '../settings-neo/SettingsNeoTable';
import { MergeUnitDialog } from '../rer-units-neo/components/UnitActionDialogs';
import { formatUnitError } from '../rer-units-neo/helpers';

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'sigintUnitName',
  'sigintUnitSegments',
  'orbitUnitFullName',
];

const DEFAULT_COLUMN_VISIBILITY = {
  sigintUnitName: true,
  sigintUnitSegments: true,
  orbitUnitFullName: true,
};

function sigintUnitSegments(unit: Unit): string {
  return [
    unit.other,
    unit.teamOrCrew,
    unit.section,
    unit.squad,
    unit.platoon,
    unit.company,
    unit.battalion,
    unit.regiment,
    unit.brigade,
    unit.division,
    unit.corps,
    unit.army,
    unit.militaryDistrict,
    unit.armyRegion,
  ]
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(' ');
}

type AdminUnitDuplicatesPageProps = {
  authUserRoles: string[];
  embedded?: boolean;
};

export function AdminUnitDuplicatesPage({
  authUserRoles,
  embedded = false,
}: AdminUnitDuplicatesPageProps) {
  const [units, setUnits] = useState<UnitDuplicate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Unit | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeProgress, setMergeProgress] = useState<number | null>(null);
  const [mergeProgressLabel, setMergeProgressLabel] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const mergePollController = useRef<AbortController | null>(null);
  const canMerge = hasRole(authUserRoles, 'Rer') && hasRole(authUserRoles, 'UnitsEditor');

  const loadUnits = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      setUnits(await getUnitDuplicates(signal ? { signal } : undefined));
    } catch (error) {
      if (!signal?.aborted) setLoadError(formatUnitError(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadUnits(controller.signal);
    return () => controller.abort();
  }, [loadUnits]);

  async function trackMerge(pending: PendingUnitMerge) {
    const controller = new AbortController();
    mergePollController.current = controller;
    try {
      await waitForBgtaskCompletion(
        pending.taskId,
        (progress, logline) => {
          setMergeProgress((current) => Math.max(current ?? 0, progress));
          if (logline !== null) setMergeProgressLabel(logline);
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      clearPendingUnitMerge(pending.taskId);
      setMergeTarget(null);
      setMergeProgress(null);
      setMergeProgressLabel(null);
      setStatus(`Підрозділ «${pending.duplicate.name}» об’єднано.`);
      await loadUnits(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      setMergeError(formatUnitError(error));
      if (error instanceof BgtaskFailedError) {
        clearPendingUnitMerge(pending.taskId);
        await loadUnits(controller.signal);
      }
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
      if (mergePollController.current === controller) mergePollController.current = null;
    }
  }

  async function confirmMerge(duplicate: Unit) {
    if (mergeTarget === null) return;
    setSubmitting(true);
    setMergeError(null);
    setMergeProgress(0);
    setMergeProgressLabel(null);
    try {
      let pending = loadPendingUnitMerge();
      if (
        pending !== null &&
        (pending.original.id !== mergeTarget.id || pending.duplicate.id !== duplicate.id)
      ) {
        throw new Error('Інше об’єднання ще виконується. Завершіть його перед новим.');
      }
      if (pending === null) {
        const taskId = await mergeDuplicateUnit({
          originalId: mergeTarget.id,
          cloneToDeleteId: duplicate.id,
        });
        pending = { taskId, original: mergeTarget, duplicate };
        savePendingUnitMerge(pending);
      }
      await trackMerge(pending);
    } catch (error) {
      setMergeError(formatUnitError(error));
      setSubmitting(false);
    }
  }

  useEffect(() => {
    const pending = loadPendingUnitMerge();
    if (pending !== null) {
      setMergeTarget(pending.original);
      setSubmitting(true);
      setMergeProgress(0);
      setMergeProgressLabel(null);
      void trackMerge(pending);
    }
    return () => mergePollController.current?.abort();
  }, []);

  const columns = useMemo<AppMrtColumnDef<UnitDuplicate>[]>(
    () => [
      {
        id: 'sigintUnitName',
        accessorFn: (row) => row.sigintUnit?.name ?? '',
        header: 'Назва SIGINT підрозділу',
        size: 280,
        meta: { overflowMode: 'custom', overflowOwner: 'shared-text' },
        Cell: mrtCustomCell<UnitDuplicate>(({ row }) => {
          const href = `/rer-units/${row.original.sigintUnit.id}`;
          return (
            <MrtOverflowText
              displayValue={row.original.sigintUnit.name}
              fullValue={row.original.sigintUnit.name}
              interactive
              component="a"
              componentProps={{
                href,
                onClick: (event: ReactMouseEvent<HTMLElement>) =>
                  handleNavigateWithinSpaClick(event, href),
              }}
            />
          );
        }),
      },
      {
        id: 'sigintUnitSegments',
        accessorFn: (row) => (row.sigintUnit ? sigintUnitSegments(row.sigintUnit) : ''),
        header: 'Сегменти назви SIGINT',
        size: 360,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => String(cell.getValue() || '—'),
          fullValue: ({ cell }) => String(cell.getValue() || ''),
        }),
      },
      {
        id: 'orbitUnitFullName',
        accessorFn: (row) => row.orbitUnitFullName,
        header: 'Повна назва Orbit підрозділу',
        size: 360,
        meta: { overflowMode: 'custom', overflowOwner: 'shared-text' },
        Cell: mrtCustomCell<UnitDuplicate>(({ row }) => {
          const label = row.original.orbitUnitFullName.trim() || row.original.orbitUnitId;
          return (
            <MrtOverflowText
              displayValue={label}
              fullValue={label}
              interactive
              component="a"
              componentProps={{
                href: `https://delta.mil.gov.ua/orbit/units/${row.original.orbitUnitId}/organizational-structure`,
                target: '_blank',
                rel: 'noopener noreferrer',
              }}
            />
          );
        }),
      },
    ],
    [],
  );

  return (
    <TableStateProvider
      tableId="admin-unit-duplicates"
      defaultColumnOrder={
        canMerge ? [...DEFAULT_COLUMN_ORDER, 'mrt-row-actions'] : DEFAULT_COLUMN_ORDER
      }
      defaultColumnVisibility={
        canMerge
          ? { ...DEFAULT_COLUMN_VISIBILITY, 'mrt-row-actions': true }
          : DEFAULT_COLUMN_VISIBILITY
      }
      defaultEnableColumnOrdering={false}
    >
      <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0, p: embedded ? 0 : 2 }}>
        <TablePageToolbar
          title="Дублікати підрозділів"
          withGlobalTextFilter
          additionalInternalActions={
            <Tooltip title="Оновити">
              <span>
                <PowerIconButton
                  aria-label="Оновити"
                  size="small"
                  disabled={loading}
                  onClick={() => void loadUnits()}
                >
                  <RefreshIcon fontSize="small" />
                </PowerIconButton>
              </span>
            </Tooltip>
          }
        />
        {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
        {status ? (
          <PowerAlert severity="success" onClose={() => setStatus(null)}>
            {status}
          </PowerAlert>
        ) : null}
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <SettingsNeoTable
            columns={columns}
            data={units}
            loading={loading}
            layoutMode="grid"
            enableRowActions={canMerge}
            renderRowActions={({ row }) => (
              <MrtRowActions forceMenu>
                <MrtRowActionButton
                  label="Об’єднати дублікати"
                  icon={<MergeIcon fontSize="small" />}
                  tone="warning"
                  opensModal
                  disabled={submitting}
                  onClick={() => {
                    setMergeError(null);
                    setMergeProgress(null);
                    setMergeProgressLabel(null);
                    setMergeTarget(row.original.sigintUnit);
                  }}
                />
              </MrtRowActions>
            )}
            tablePaperSx={{ height: '100%', minHeight: 0 }}
            tableContainerSx={{ maxHeight: '100%' }}
          />
        </Box>
        <MergeUnitDialog
          original={mergeTarget}
          submitting={submitting}
          progress={mergeProgress}
          progressLabel={mergeProgressLabel}
          error={mergeError}
          onClose={() => {
            setMergeTarget(null);
            setMergeError(null);
            setMergeProgress(null);
            setMergeProgressLabel(null);
          }}
          onConfirm={(duplicate) => void confirmMerge(duplicate)}
        />
      </Stack>
    </TableStateProvider>
  );
}
