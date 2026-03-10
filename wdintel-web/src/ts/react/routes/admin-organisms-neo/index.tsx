import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import { Alert, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Tooltip, Typography } from '@mui/material';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import React from 'react';

import { AreaOfResponsibility, Organism, OrganismGroup, SignalGroupFull, UpdateOrganismReq } from '../../../../Bindings';
import { PageErrorState } from '../../components/PageErrorState';
import { PageLoadingState } from '../../components/PageLoadingState';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { Button } from '../../components/mui-customized/button';
import { IconButton } from '../../components/mui-customized/icon-button';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  PAGE_SCROLL_TABLE_CONTAINER_SX,
} from '../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import { TableStateProvider, useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { listAors } from '../../services/api/aor';
import {
  deleteOrganism,
  listActiveLogins,
  listAvailableGroupsBatch,
  listOrganismGroups,
  listOrganisms,
  listSignalGroups,
  updateOrganism,
} from '../../services/api/organisms';
import { navigateWithinSpa, withBackTo } from '../../utils/browser';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';
type StatusMessage = { kind: 'error' | 'success'; message: string } | null;

type OrganismLookup = {
  parentById: Map<number, string>;
  aorById: Map<number, AreaOfResponsibility>;
  groupByKey: Map<string, SignalGroupFull>;
  organismGroupKeysById: Map<number, string[]>;
  computedGroupsById: Map<number, SignalGroupFull[]>;
};

const ROLE_OPTIONS = ['Admin', 'Rer', 'Bpla', 'Full', 'Basic', 'UnitsEditor', 'CallsignsEditor'];
const ENABLED_FILTER_OPTIONS = [
  { text: 'так', value: 'так' },
  { text: 'ні', value: 'ні' },
];

const DEFAULT_COLUMNS_VISIBILITY = {
  id: true,
  name: true,
  parent: true,
  roles: true,
  aors: true,
  groups: true,
  limitGroups: true,
  enabled: true,
  loginsCount: true,
  createdAt: true,
};

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-actions',
  'id',
  'name',
  'parent',
  'aors',
  'groups',
  'roles',
  'enabled',
  'limitGroups',
  'createdAt',
  'loginsCount',
];

const defaultMRTOptions = getDefaultMRTOptions<Organism>();

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function formatDate(value: number): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('uk-UA');
}

function buildEditHref(organismId: number): string {
  return withBackTo(`/admin/organisms-neo/edit?id=${organismId}`);
}

function buildCreateHref(): string {
  return withBackTo('/admin/organisms-neo/edit');
}

function formatGroupLabel(group: SignalGroupFull | undefined, fallbackKey: string): string {
  if (!group) return fallbackKey;
  if (group.name && group.name.trim()) return group.name;
  return `Без назви (id=${group.masterKey.slice(0, 6)}...)`;
}

function formatAorLabel(aor: AreaOfResponsibility | undefined, fallbackId: number): string {
  if (!aor) return String(fallbackId);
  return aor.name || String(fallbackId);
}

type GroupLabel = { key: string; label: string };

function buildGroupLabels(groupKeys: string[], lookup: OrganismLookup): GroupLabel[] {
  return groupKeys
    .map((key) => ({ key, label: formatGroupLabel(lookup.groupByKey.get(key), key) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'uk-UA'));
}

function buildGroupFilterOptions(groups: Iterable<SignalGroupFull>): { text: string; value: string }[] {
  const labels = new Map<string, string>();
  Array.from(groups).forEach((group) => {
    const label = formatGroupLabel(group, group.masterKey);
    labels.set(label, label);
  });
  return Array.from(labels.values()).map((label) => ({ text: label, value: label }));
}

function buildComputedGroupFilterOptions(
  computedGroupsById: Map<number, SignalGroupFull[]>,
): { text: string; value: string }[] {
  const labels = new Map<string, string>();
  computedGroupsById.forEach((groups) => {
    groups.forEach((group) => {
      const label = formatGroupLabel(group, group.masterKey);
      labels.set(label, label);
    });
  });
  return Array.from(labels.values()).map((label) => ({ text: label, value: label }));
}

function useOrganismColumns(lookup: OrganismLookup, computedGroupsStatus: LoadingStatus) {
  return React.useMemo<MRT_ColumnDef<Organism>[]>(
    () => {
      const groupFilterOptions = buildGroupFilterOptions(lookup.groupByKey.values());
      const computedGroupFilterOptions = buildComputedGroupFilterOptions(lookup.computedGroupsById);

      return [
        {
          header: 'ID',
          accessorKey: 'id',
          size: 90,
          enableColumnOrdering: false,
        },
        {
          header: 'Назва',
          accessorKey: 'name',
          size: 240,
        },
        {
          header: 'Батьківський',
          id: 'parent',
          accessorFn: (row) => (row.parentId ? lookup.parentById.get(row.parentId) ?? '—' : '—'),
          Cell: ({ row }) => {
            const parentName = row.original.parentId ? lookup.parentById.get(row.original.parentId) : null;
            return <span>{parentName || '—'}</span>;
          },
          size: 200,
        },
        {
          header: 'Смуги',
          id: 'aors',
          accessorFn: (row) => row.aorIds.map((id) => formatAorLabel(lookup.aorById.get(id), id)),
          Cell: ({ row }) => {
            if (row.original.aorIds.length === 0) return <span>—</span>;
            const labels = row.original.aorIds
              .map((id) => formatAorLabel(lookup.aorById.get(id), id))
              .join(', ');
            return (
              <Tooltip title={labels}>
                <span>{labels}</span>
              </Tooltip>
            );
          },
          filterVariant: 'multi-select',
          filterSelectOptions: Array.from(lookup.aorById.values()).map((aor) => ({
            text: aor.name,
            value: aor.name,
          })),
          filterFn: 'arrIncludesSome',
          enableSorting: false,
          size: 240,
        },
        {
          header: 'Групи',
          id: 'groups',
          accessorFn: (row) => {
            const computedGroups = lookup.computedGroupsById.get(row.id) ?? [];
            return computedGroups.map((group) => formatGroupLabel(group, group.masterKey));
          },
          Cell: ({ row }) => {
            const computedGroups = lookup.computedGroupsById.get(row.original.id) ?? [];
            if (computedGroupsStatus === 'loading' && computedGroups.length === 0) {
              return <CircularProgress size={16} />;
            }
            if (computedGroupsStatus === 'error') return <span>—</span>;
            if (computedGroups.length === 0) return <span>—</span>;
            const labels = computedGroups.map((group) => formatGroupLabel(group, group.masterKey)).join(', ');
            return (
              <Tooltip title={labels}>
                <span>{labels}</span>
              </Tooltip>
            );
          },
          filterVariant: 'multi-select',
          filterSelectOptions: computedGroupFilterOptions,
          filterFn: 'arrIncludesSome',
          enableSorting: false,
          size: 240,
        },
        {
          header: 'Ролі',
          id: 'roles',
          accessorFn: (row) => row.roles,
          Cell: ({ row }) => <span>{row.original.roles.length > 0 ? row.original.roles.join(', ') : '—'}</span>,
          filterVariant: 'multi-select',
          filterSelectOptions: ROLE_OPTIONS,
          filterFn: 'arrIncludesSome',
          size: 220,
        },
        {
          header: 'Активна',
          id: 'enabled',
          accessorFn: (row) => (row.enabled ? 'так' : 'ні'),
          Cell: ({ row }) => (
            <div className="flex justify-center">
              {row.original.enabled ? (
                <CheckCircleIcon className="text-green-600" fontSize="small" />
              ) : (
                <CancelIcon className="text-red-600" fontSize="small" />
              )}
            </div>
          ),
          filterVariant: 'select',
          filterSelectOptions: ENABLED_FILTER_OPTIONS,
          size: 110,
          muiTableBodyCellProps: () => ({
            sx: {
              justifyContent: 'center',
              ...CUSTOM_CELL_STYLES,
            },
          }),
        },
        {
          header: 'Обмежити групами',
          id: 'limitGroups',
          accessorFn: (row) => {
            const groupKeys = lookup.organismGroupKeysById.get(row.id) ?? [];
            if (groupKeys.length === 0) return ['без обмежень'];
            return buildGroupLabels(groupKeys, lookup).map((item) => item.label);
          },
          Cell: ({ row }) => {
            const groupKeys = lookup.organismGroupKeysById.get(row.original.id) ?? [];
            if (groupKeys.length === 0) return <span>без обмежень</span>;
            const labels = buildGroupLabels(groupKeys, lookup).map((item) => item.label);
            const labelText = labels.join(', ');
            return (
              <Tooltip title={labelText}>
                <span>{labelText}</span>
              </Tooltip>
            );
          },
          filterVariant: 'multi-select',
          filterSelectOptions: [{ text: 'без обмежень', value: 'без обмежень' }, ...groupFilterOptions],
          filterFn: 'arrIncludesSome',
          enableSorting: false,
          size: 240,
        },
        {
          header: 'Користувачі',
          accessorKey: 'loginsCount',
          size: 110,
        },
        {
          header: 'Створено',
          id: 'createdAt',
          accessorFn: (row) => row.createdAt,
          Cell: ({ row }) => <span>{formatDate(row.original.createdAt)}</span>,
          size: 140,
        },
      ];
    },
    [lookup, computedGroupsStatus],
  );
}

function RowActions(props: { organism: Organism; onEdit: (organism: Organism) => void; onDelete: (organism: Organism) => void }) {
  return (
    <div className="flex items-center gap-1">
      <Tooltip title="Редагувати">
        <IconButton size="small" onClick={() => props.onEdit(props.organism)}>
          <EditIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="Видалити">
        <IconButton size="small" onClick={() => props.onDelete(props.organism)}>
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </div>
  );
}

function OrganismsTable(props: {
  data: Organism[];
  lookup: OrganismLookup;
  computedGroupsStatus: LoadingStatus;
  onEdit: (organism: Organism) => void;
  onDelete: (organism: Organism) => void;
}) {
  const columns = useOrganismColumns(props.lookup, props.computedGroupsStatus);
  const tableStateContext = useTableStateContext();

  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

  const state = {
    showAlertBanner: false,
    globalFilter: tableStateContext.globalFilter,
    columnVisibility: tableStateContext.columnVisibility,
    columnFilters: tableStateContext.columnFilters,
    density: tableStateContext.density,
    sorting: tableStateContext.sorting,
    columnOrder: tableStateContext.columnOrder,
    columnSizing: tableStateContext.columnSizing,
  };

  const table = useMaterialReactTable({
    columns,
    data: props.data,
    ...defaultMRTOptions,
    enableSorting: true,
    enableColumnActions: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowVirtualization: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    columnFilterDisplayMode: 'popover',
    globalFilterFn: 'contains',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onSortingChange: tableStateContext.onSortingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    getColumnCanGlobalFilter: (column) => column.getIsVisible(),
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => (
      <RowActions organism={row.original} onEdit={props.onEdit} onDelete={props.onDelete} />
    ),
    defaultColumn: {
      size: 200,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: 90,
      },
      'mrt-row-numbers': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        muiTableBodyCellProps: () => ({
          sx: {
            justifyContent: 'center',
            ...CUSTOM_CELL_STYLES,
          },
        }),
      },
    },
    muiTablePaperProps: ({ table }) => {
      const baseProps = resolvedPaperProps({ table });
      return {
        ...baseProps,
        sx: {
          ...(baseProps as any)?.sx,
          ...FULL_WIDTH_TABLE_PAPER_SX,
        },
      };
    },
    muiTableContainerProps: {
      sx: {
        ...(CUSTOM_STYLES.muiTableContainerProps as any)?.sx,
        ...PAGE_SCROLL_TABLE_CONTAINER_SX,
      },
    },
    state,
  });

  React.useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function DeleteOrganismDialog(props: {
  organism: Organism | null;
  open: boolean;
  onClose: () => void;
  onReload: () => Promise<void>;
}) {
  const [status, setStatus] = React.useState<StatusMessage>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [activeLogins, setActiveLogins] = React.useState<string[] | null>(null);
  const [isLoadingLogins, setIsLoadingLogins] = React.useState(false);

  const hasMultipleActiveUsers = Boolean(props.organism && props.organism.loginsCount > 1);

  React.useEffect(() => {
    if (!props.open || !props.organism) return;
    setStatus(null);
    setActiveLogins(null);
    if (!hasMultipleActiveUsers) return;

    let isCancelled = false;

    async function loadLogins() {
      setIsLoadingLogins(true);
      try {
        const logins = await listActiveLogins(props.organism!.id);
        if (!isCancelled) setActiveLogins(logins);
      } catch (error) {
        if (!isCancelled) {
          setStatus({ kind: 'error', message: `Не вдалося завантажити активних користувачів: ${formatErrorMessage(error)}` });
        }
      } finally {
        if (!isCancelled) setIsLoadingLogins(false);
      }
    }

    loadLogins();

    return () => {
      isCancelled = true;
    };
  }, [props.open, props.organism, hasMultipleActiveUsers]);

  async function handleSoftDelete() {
    if (!props.organism) return;
    if (hasMultipleActiveUsers) return;
    setIsSubmitting(true);
    setStatus(null);
    try {
      const req: UpdateOrganismReq = {
        id: props.organism.id,
        parentId: props.organism.parentId,
        name: props.organism.name,
        roles: props.organism.roles,
        enabled: false,
        aorIds: props.organism.aorIds,
      };
      await updateOrganism(req);
      await props.onReload();
      props.onClose();
    } catch (error) {
      setStatus({ kind: 'error', message: `Помилка видалення організму: ${formatErrorMessage(error)}` });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleHardDelete() {
    if (!props.organism) return;
    if (hasMultipleActiveUsers) return;
    setIsSubmitting(true);
    setStatus(null);
    try {
      await deleteOrganism(props.organism.id);
      await props.onReload();
      props.onClose();
    } catch (error) {
      setStatus({ kind: 'error', message: `Помилка остаточного видалення: ${formatErrorMessage(error)}` });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={props.open} onClose={props.onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Підтвердження видалення</DialogTitle>
      <DialogContent className="space-y-3">
        {status ? (
          <Alert severity={status.kind} onClose={() => setStatus(null)}>
            {status.message}
          </Alert>
        ) : null}

        <Typography variant="body2" className="text-muted-foreground">
          Ви впевнені, що хочете видалити організм {props.organism?.name || ''}?
        </Typography>

        {isLoadingLogins ? (
          <div className="flex items-center gap-2">
            <CircularProgress size={18} />
            <Typography variant="body2" className="text-muted-foreground">
              Завантаження активних користувачів...
            </Typography>
          </div>
        ) : null}

        {hasMultipleActiveUsers ? (
          <Alert severity="warning">
            Для цього організму більше одного активного користувача. Видалення недоступне.
            {activeLogins && activeLogins.length > 0 ? ` Активні логіни: ${activeLogins.join(', ')}` : ''}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" onClick={props.onClose} disabled={isSubmitting}>
          Скасувати
        </Button>
        <Button variant="outlined" color="error" onClick={handleSoftDelete} disabled={isSubmitting || hasMultipleActiveUsers}>
          Видалити
        </Button>
        <Button variant="contained" color="error" onClick={handleHardDelete} disabled={isSubmitting || hasMultipleActiveUsers}>
          Видалити назавжди
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AdminOrganismsNeoPageBody() {
  const [organisms, setOrganisms] = React.useState<Organism[]>([]);
  const [organismsStatus, setOrganismsStatus] = React.useState<LoadingStatus>('idle');
  const [organismsError, setOrganismsError] = React.useState<string | null>(null);
  const [groups, setGroups] = React.useState<SignalGroupFull[]>([]);
  const [organismGroups, setOrganismGroups] = React.useState<OrganismGroup[]>([]);
  const [aors, setAors] = React.useState<AreaOfResponsibility[]>([]);
  const [referenceStatus, setReferenceStatus] = React.useState<LoadingStatus>('idle');
  const [referenceError, setReferenceError] = React.useState<string | null>(null);
  const [computedGroupsById, setComputedGroupsById] = React.useState<Map<number, SignalGroupFull[]>>(new Map());
  const [computedGroupsStatus, setComputedGroupsStatus] = React.useState<LoadingStatus>('idle');

  const [deleteTarget, setDeleteTarget] = React.useState<Organism | null>(null);

  const lookup = React.useMemo<OrganismLookup>(() => {
    const parentById = new Map<number, string>();
    organisms.forEach((org) => parentById.set(org.id, org.name));

    const aorById = new Map<number, AreaOfResponsibility>();
    aors.forEach((aor) => aorById.set(aor.id, aor));

    const groupByKey = new Map<string, SignalGroupFull>();
    groups.forEach((group) => groupByKey.set(group.masterKey, group));

    const organismGroupKeysById = new Map<number, string[]>();
    organismGroups.forEach((item) => {
      const existing = organismGroupKeysById.get(item.organismId) ?? [];
      organismGroupKeysById.set(item.organismId, [...existing, item.masterKey]);
    });

    return { parentById, aorById, groupByKey, organismGroupKeysById, computedGroupsById };
  }, [organisms, aors, groups, organismGroups, computedGroupsById]);

  const loadComputedGroups = React.useCallback(async (data: Organism[]) => {
    if (data.length === 0) {
      setComputedGroupsById(new Map());
      setComputedGroupsStatus('success');
      return;
    }
    setComputedGroupsById(new Map());
    setComputedGroupsStatus('loading');
    try {
      const computedGroups = await listAvailableGroupsBatch(data.map((organism) => organism.id));
      setComputedGroupsById(computedGroups);
      setComputedGroupsStatus('success');
    } catch (error) {
      setComputedGroupsById(new Map());
      setComputedGroupsStatus('error');
    }
  }, []);

  const loadOrganisms = React.useCallback(async () => {
    setOrganismsStatus('loading');
    setOrganismsError(null);
    try {
      const data = await listOrganisms({ sortBy: null });
      setOrganisms(data);
      setOrganismsStatus('success');
      void loadComputedGroups(data);
    } catch (error) {
      setOrganismsStatus('error');
      setOrganismsError(formatErrorMessage(error));
      setComputedGroupsById(new Map());
      setComputedGroupsStatus('error');
    }
  }, [loadComputedGroups]);

  const loadReferenceData = React.useCallback(async () => {
    setReferenceStatus('loading');
    setReferenceError(null);
    try {
      const [groupsData, organismGroupsData, aorData] = await Promise.all([
        listSignalGroups(),
        listOrganismGroups(),
        listAors({ sortBy: null }),
      ]);
      setGroups(groupsData);
      setOrganismGroups(organismGroupsData);
      setAors(aorData);
      setReferenceStatus('success');
    } catch (error) {
      setReferenceStatus('error');
      setReferenceError(formatErrorMessage(error));
    }
  }, []);

  const reloadAll = React.useCallback(async () => {
    await Promise.all([loadOrganisms(), loadReferenceData()]);
  }, [loadOrganisms, loadReferenceData]);

  React.useEffect(() => {
    loadOrganisms();
    loadReferenceData();
  }, [loadOrganisms, loadReferenceData]);

  function openEdit(organism: Organism) {
    navigateWithinSpa(buildEditHref(organism.id));
  }

  function openDelete(organism: Organism) {
    setDeleteTarget(organism);
  }

  const renderTable = () => {
    if (organismsStatus === 'loading') {
      return <PageLoadingState />;
    }
    if (organismsStatus === 'error') {
      return <PageErrorState message={organismsError || 'Помилка завантаження'} />;
    }
    if (organismsStatus === 'success') {
      return (
        <div className="w-full min-w-0">
          <OrganismsTable
            data={organisms}
            lookup={lookup}
            computedGroupsStatus={computedGroupsStatus}
            onEdit={openEdit}
            onDelete={openDelete}
          />
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      {referenceStatus === 'error' ? (
        <Alert severity="error" onClose={() => setReferenceError(null)}>
          {referenceError || 'Помилка завантаження довідників'}
        </Alert>
      ) : null}

      <TablePageToolbar
        title="Організми"
        withGlobalTextFilter
        actions={
          <div className="flex gap-2">
            <Button variant="outlined" onClick={reloadAll}>
              Оновити
            </Button>
            <Button variant="contained" onClick={() => navigateWithinSpa(buildCreateHref())}>
              Створити
            </Button>
          </div>
        }
      />

      <div className="w-full min-w-0">{renderTable()}</div>

      <DeleteOrganismDialog
        organism={deleteTarget}
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onReload={reloadAll}
      />
    </div>
  );
}

export function AdminOrganismsNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-organisms-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
    >
      <AdminOrganismsNeoPageBody />
    </TableStateProvider>
  );
}
