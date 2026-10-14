import LinkIcon from '@mui/icons-material/Link';
import MergeIcon from '@mui/icons-material/Merge';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useEffect, useMemo, useState } from 'react';

import type { Unit } from '../../../../Bindings';
import { MrtRowActionButton } from '../../components/MrtRowActionButton';
import { PageErrorState } from '../../components/PageErrorState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerIconButton } from '../../components/PowerIconButton';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import type { AppMrtColumnDef } from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { OrbitUnitLinkDialog } from '../rer-unit-details/OrbitUnitLinkDialog';
import { MergeUnitDialog } from '../rer-units-neo/components/UnitActionDialogs';
import { UnitsPaginationControl } from '../rer-units-neo/components/UnitsPaginationControl';
import { buildUnitsListReq } from '../rer-units-neo/helpers';
import { useRerUnitsPage } from '../rer-units-neo/use-rer-units-page';
import { SettingsNeoTable } from '../settings-neo/SettingsNeoTable';

const UNLINKED_UNITS_PAGE_SIZE = 20;
const UNLINKED_UNITS_FILTER_DEBOUNCE_MS = 500;
const UNLINKED_UNITS_ROW_ACTIONS_COLUMN_SIZE = 76;

const COLUMNS: AppMrtColumnDef<Unit>[] = [
  {
    accessorKey: 'name',
    header: 'Підрозділ',
    size: 360,
  },
  {
    accessorKey: 'combatTypeName',
    header: 'Види та роди ЗС',
  },
  {
    id: 'active',
    accessorFn: (unit) => (unit.active ? 'Активний' : 'Неактивний'),
    header: 'Статус',
    enableColumnFilter: false,
    enableSorting: false,
  },
  {
    accessorKey: 'comment',
    header: 'Коментар',
    size: 300,
  },
];

function useUnlinkedUnitsRequest() {
  const tableState = useTableStateContext();
  const [filters, setFilters] = useState({
    globalFilter: tableState.globalFilter,
    columnFilters: tableState.columnFilters,
  });

  useEffect(() => {
    if (
      filters.globalFilter === tableState.globalFilter &&
      filters.columnFilters === tableState.columnFilters
    ) {
      return;
    }
    const timeoutId = window.setTimeout(
      () =>
        setFilters({
          globalFilter: tableState.globalFilter,
          columnFilters: tableState.columnFilters,
        }),
      UNLINKED_UNITS_FILTER_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [filters, tableState.globalFilter, tableState.columnFilters]);

  return useMemo(
    () => ({
      ...buildUnitsListReq({
        ...filters,
        statusFilter: 'all',
        sorting: tableState.sorting,
        searchMode: 'strict',
        pagination: { pageIndex: 0, pageSize: UNLINKED_UNITS_PAGE_SIZE },
      }),
      filterHasOrbit: false,
      offset: null,
    }),
    [filters, tableState.sorting],
  );
}

function UnlinkedUnitsTable({
  page,
  onLinkOrbit,
}: {
  page: ReturnType<typeof useRerUnitsPage>;
  onLinkOrbit: (unit: Unit) => void;
}) {
  const loading = page.loading || !page.settingsReady;
  return (
    <SettingsNeoTable
      columns={COLUMNS}
      data={loading ? [] : page.units}
      loading={loading}
      manualFiltering
      manualSorting
      layoutMode="grid"
      enableRowActions={page.canEdit}
      rowActionsColumnSize={UNLINKED_UNITS_ROW_ACTIONS_COLUMN_SIZE}
      renderRowActions={({ row }) => (
        <div className="flex justify-center gap-echo-xs">
          <MrtRowActionButton
            label="Прив’язати до Orbit"
            icon={<LinkIcon fontSize="small" />}
            opensModal
            disabled={page.submitting || !page.settingsReady || !page.canImportOrbit}
            onClick={() => onLinkOrbit(row.original)}
          />
          <MrtRowActionButton
            label="Об’єднати дублікати"
            icon={<MergeIcon fontSize="small" />}
            tone="warning"
            opensModal
            disabled={page.submitting}
            onClick={() => page.openMergeDialog(row.original)}
          />
        </div>
      )}
      tablePaperSx={{ height: '100%', minHeight: 0 }}
      tableContainerSx={{ maxHeight: '100%' }}
    />
  );
}

function UnlinkedUnitsTabBody({ authUserRoles }: { authUserRoles: string[] }) {
  const [orbitTarget, setOrbitTarget] = useState<Unit | null>(null);
  const request = useUnlinkedUnitsRequest();
  const [pagination, setPagination] = useState({
    request,
    cursors: [null] as (number | null)[],
  });
  if (pagination.request !== request) {
    setPagination({ request, cursors: [null] });
  }
  const pageIndex = pagination.cursors.length - 1;
  const cursor = pagination.cursors[pageIndex];
  const listReq = useMemo(
    () => ({
      ...request,
      afterUnitId: request.sortBy?.endsWith('Desc') ? null : cursor,
      beforeUnitId: request.sortBy?.endsWith('Desc') ? cursor : null,
    }),
    [request, cursor],
  );
  const page = useRerUnitsPage(authUserRoles, listReq);
  const loading = page.loading || !page.settingsReady;

  useEffect(() => {
    if (page.loading || page.loadError !== null || page.units.length > 0) return;
    setPagination((current) =>
      current.cursors.length === 1
        ? current
        : { ...current, cursors: current.cursors.slice(0, -1) },
    );
  }, [page.loading, page.loadError, page.units.length]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-echo-md">
      <TablePageToolbar
        title="Відсутні в Orbit"
        withGlobalTextFilter
        internalActionsDisabled={loading || page.loadError !== null || page.orbitDataHidden}
        leadingInternalActions={
          <UnitsPaginationControl
            pageIndex={pageIndex}
            pageSize={UNLINKED_UNITS_PAGE_SIZE}
            totalCount={page.totalCount}
            hasNextPage={page.showLoadMore}
            loading={loading || page.loadError !== null || page.orbitDataHidden}
            onPrevPage={() =>
              setPagination((current) => ({
                ...current,
                cursors: current.cursors.slice(0, Math.max(1, current.cursors.length - 1)),
              }))
            }
            onNextPage={() => {
              const lastUnit = page.units.at(-1);
              if (lastUnit) {
                setPagination((current) => ({
                  ...current,
                  cursors: [...current.cursors, lastUnit.id],
                }));
              }
            }}
          />
        }
        additionalInternalActions={
          <PowerIconButton
            aria-label="Оновити"
            size="small"
            disabled={loading}
            onClick={() => void page.loadUnits()}
          >
            <RefreshIcon fontSize="small" />
          </PowerIconButton>
        }
      />
      {page.status ? (
        <PowerAlert severity={page.status.severity}>{page.status.text}</PowerAlert>
      ) : null}
      <div className="min-h-0 flex-1">
        {page.settingsError !== null ? (
          <PageErrorState
            message={`Не вдалося завантажити налаштування: ${page.settingsError}`}
            actionLabel="Повторити"
            onAction={page.retrySettings}
            minHeight={0}
          />
        ) : page.orbitDataHidden ? (
          <PowerAlert severity="info">Дані Orbit приховано в налаштуваннях системи.</PowerAlert>
        ) : page.loadError !== null ? (
          <PageErrorState
            message={`Не вдалося завантажити підрозділи: ${page.loadError}`}
            actionLabel="Повторити"
            onAction={() => void page.loadUnits()}
            minHeight={0}
          />
        ) : (
          <UnlinkedUnitsTable page={page} onLinkOrbit={setOrbitTarget} />
        )}
      </div>
      {orbitTarget !== null ? (
        <OrbitUnitLinkDialog
          unitId={orbitTarget.id}
          unit={orbitTarget}
          onClose={() => setOrbitTarget(null)}
          onLinked={() => {
            setOrbitTarget(null);
            void page.refreshUnitsAfterMutation(
              `Підрозділ «${orbitTarget.name}» прив’язано до Orbit.`,
            );
          }}
        />
      ) : null}
      <MergeUnitDialog
        original={page.mergeTarget}
        submitting={page.submitting}
        progress={page.mergeProgress}
        progressLabel={page.mergeProgressLabel}
        error={page.dialogError}
        onClose={page.closeDialogs}
        onConfirm={(duplicate) => void page.confirmMerge(duplicate)}
      />
    </div>
  );
}

export function UnlinkedUnitsTab({ authUserRoles }: { authUserRoles: string[] }) {
  return (
    <TableStateProvider
      tableId="admin-units-unlinked"
      defaultColumnVisibility={{ name: true, combatTypeName: true, active: true, comment: true }}
      defaultColumnOrder={[
        'mrt-row-numbers',
        'mrt-row-actions',
        'name',
        'combatTypeName',
        'active',
        'comment',
      ]}
      defaultSorting={[{ id: 'name', desc: false }]}
      defaultEnableColumnOrdering={false}
    >
      <UnlinkedUnitsTabBody authUserRoles={authUserRoles} />
    </TableStateProvider>
  );
}
