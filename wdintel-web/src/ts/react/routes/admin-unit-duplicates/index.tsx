import MergeIcon from '@mui/icons-material/Merge';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Box, IconButton, Link, Stack, Tooltip } from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Unit, UnitDuplicate } from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PowerAlert } from '../../components/PowerAlert';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import {
  mrtTextCell,
  type AppMrtColumnDef,
} from '../../components/mui-customized/table/get-default-table-options';
import { getUnitDuplicates, mergeDuplicateUnit } from '../../services/api/units';
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
  const [submitting, setSubmitting] = useState(false);
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

  async function confirmMerge(duplicate: Unit) {
    if (mergeTarget === null) return;
    setSubmitting(true);
    setMergeError(null);
    try {
      const original = mergeTarget;
      const merged = await mergeDuplicateUnit({
        originalId: original.id,
        cloneToDeleteId: duplicate.id,
      });
      setMergeTarget(null);
      setStatus(`Підрозділ «${duplicate.name}» об’єднано з «${merged.name}».`);
      await loadUnits();
    } catch (error) {
      setMergeError(formatUnitError(error));
    } finally {
      setSubmitting(false);
    }
  }

  const columns = useMemo<AppMrtColumnDef<UnitDuplicate>[]>(
    () => [
      {
        id: 'sigintUnitName',
        accessorFn: (row) => row.sigintUnit?.name ?? '',
        header: 'Назва SIGINT підрозділу',
        size: 280,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell<UnitDuplicate>({
          interactive: true,
          fullValue: ({ row }) => row.original.sigintUnit.name,
          displayValue: ({ row }) => {
            const href = `/rer-units/${row.original.sigintUnit.id}`;
            return (
              <Link href={href} onClick={(event) => handleNavigateWithinSpaClick(event, href)}>
                {row.original.sigintUnit.name}
              </Link>
            );
          },
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
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell<UnitDuplicate>({
          interactive: true,
          fullValue: ({ row }) => row.original.orbitUnitFullName.trim() || row.original.orbitUnitId,
          displayValue: ({ row }) => {
            const label = row.original.orbitUnitFullName.trim() || row.original.orbitUnitId;
            return (
              <Link
                href={`https://delta.mil.gov.ua/orbit/units/${row.original.orbitUnitId}/organizational-structure`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {label}
              </Link>
            );
          },
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
          title="Дублікати Підрозділів"
          withGlobalTextFilter
          trailingActionsAfterInternal={
            <Tooltip title="Оновити">
              <span>
                <IconButton size="small" disabled={loading} onClick={() => void loadUnits()}>
                  <RefreshIcon fontSize="small" />
                </IconButton>
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
          error={mergeError}
          onClose={() => {
            setMergeTarget(null);
            setMergeError(null);
          }}
          onConfirm={(duplicate) => void confirmMerge(duplicate)}
        />
      </Stack>
    </TableStateProvider>
  );
}
