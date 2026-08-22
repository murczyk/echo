import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import {
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  AreaOfResponsibility,
  Organism,
  OrganismGroup,
  SignalGroupFull,
  UpdateOrganismReq,
} from '../../../../Bindings';
import {
  MrtRowActionButton,
  MrtRowActions,
  mrtRowActionsColumnSize,
} from '../../components/MrtRowActionButton';
import { EchoChip } from '../../components/EchoChip';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableContentState } from '../../components/TableContentState';
import { PowerButton } from '../../components/PowerButton';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  FULL_HEIGHT_LOADING_ROW_COUNT,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../components/mui-customized/table/custom-styles';
import {
  buildExplicitSingleSelectColumnFilter,
  type AppMrtColumnDef,
  getDefaultMRTOptions,
  mrtItemsCell,
  mrtTextCell,
  useAppMaterialReactTable,
  renderColumnActionsMenuItems,
  withExplicitSelectAllOption,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
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
import { PowerAlert } from '../../components/PowerAlert';
import { NO_DATA_LABEL } from '../../utils/misc';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';
type StatusMessage = { kind: 'error' | 'success'; message: string } | null;

type OrganismLookup = {
  parentById: Map<number, string>;
  aorById: Map<number, AreaOfResponsibility>;
  groupByKey: Map<string, SignalGroupFull>;
  organismGroupKeysById: Map<number, string[]>;
  computedGroupsById: Map<number, SignalGroupFull[]>;
};

const ROLE_OPTIONS = [
  'Admin',
  'ApiAgent',
  'Rer',
  'Bpla',
  'Full',
  'Basic',
  'UnitsEditor',
  'NetworkEditor',
  'CallsignsEditor',
  'AdvancedReports',
];
const ENABLED_FILTER_OPTIONS = withExplicitSelectAllOption([
  { text: 'так', value: 'так' },
  { text: 'ні', value: 'ні' },
]);

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
  'mrt-row-numbers',
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

function formatOrganismName(value: string | null | undefined): string {
  const name = value?.trim();
  return !name || name === '-' ? NO_DATA_LABEL : name;
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

function buildOrganismLoadingRows(): Organism[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    id: -index - 1,
    name: '',
    parentId: null,
    roles: [],
    enabled: false,
    aorIds: [],
    loginsCount: 0,
    createdAt: 0,
  }));
}

type GroupLabel = { key: string; label: string };

function buildGroupLabels(groupKeys: string[], lookup: OrganismLookup): GroupLabel[] {
  return groupKeys
    .map((key) => ({ key, label: formatGroupLabel(lookup.groupByKey.get(key), key) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'uk-UA'));
}

function buildGroupFilterOptions(
  groups: Iterable<SignalGroupFull>,
): { text: string; value: string }[] {
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
  return useMemo<AppMrtColumnDef<Organism>[]>(() => {
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
        id: 'name',
        accessorFn: (row) => formatOrganismName(row.name),
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatOrganismName(row.original.name),
          fullValue: ({ row }) => formatOrganismName(row.original.name),
        }),
        size: 240,
      },
      {
        header: 'Батьківський',
        id: 'parent',
        accessorFn: (row) =>
          formatOrganismName(row.parentId ? lookup.parentById.get(row.parentId) : null),
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) =>
            formatOrganismName(
              row.original.parentId ? lookup.parentById.get(row.original.parentId) : null,
            ),
          fullValue: ({ row }) =>
            formatOrganismName(
              row.original.parentId ? lookup.parentById.get(row.original.parentId) : null,
            ),
        }),
        size: 200,
      },
      {
        header: 'Смуги',
        id: 'aors',
        accessorFn: (row) =>
          (row.aorIds ?? []).map((id) => formatAorLabel(lookup.aorById.get(id), id)),
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<Organism, string>({
          items: ({ row }) =>
            row.original.aorIds.map((id) => formatAorLabel(lookup.aorById.get(id), id)),
          renderItem: (label) => <EchoChip label={label} tone="neutral" />,
          measurementScope: 'admin-organisms:aors',
          getItemText: (label) => label,
        }),
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
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<Organism, string>({
          items: ({ row }) => {
            const computedGroups = lookup.computedGroupsById.get(row.original.id) ?? [];
            return computedGroups.map((group) => formatGroupLabel(group, group.masterKey));
          },
          renderItem: (label) => <EchoChip label={label} tone="neutral" />,
          measurementScope: 'admin-organisms:groups',
          getItemText: (label) => label,
          emptyValue: computedGroupsStatus === 'loading' ? <CircularProgress size={16} /> : '—',
        }),
        filterVariant: 'multi-select',
        filterSelectOptions: computedGroupFilterOptions,
        filterFn: 'arrIncludesSome',
        enableSorting: false,
        size: 240,
      },
      {
        header: 'Ролі',
        id: 'roles',
        accessorFn: (row) => row.roles ?? [],
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<Organism, string>({
          items: ({ row }) => row.original.roles,
          renderItem: (role) => <EchoChip label={role} tone="neutral" />,
          measurementScope: 'admin-organisms:roles',
          getItemText: (role) => role,
        }),
        filterVariant: 'multi-select',
        filterSelectOptions: ROLE_OPTIONS,
        filterFn: 'arrIncludesSome',
        size: 220,
      },
      {
        header: 'Активна',
        id: 'enabled',
        accessorFn: (row) => (row.enabled ? 'так' : 'ні'),
        meta: { overflowMode: 'none' },
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
        Filter: buildExplicitSingleSelectColumnFilter<Organism>({
          options: ENABLED_FILTER_OPTIONS,
          fallbackValue: 'Усі',
          onChange: (column, nextValue) => {
            column.setFilterValue(nextValue === 'Усі' ? undefined : nextValue);
          },
        }),
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
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<Organism, string>({
          items: ({ row }) => {
            const groupKeys = lookup.organismGroupKeysById.get(row.original.id) ?? [];
            return groupKeys.length === 0
              ? ['без обмежень']
              : buildGroupLabels(groupKeys, lookup).map((item) => item.label);
          },
          renderItem: (label) => <EchoChip label={label} tone="neutral" />,
          measurementScope: 'admin-organisms:limit-groups',
          getItemText: (label) => label,
        }),
        filterVariant: 'multi-select',
        filterSelectOptions: [
          { text: 'без обмежень', value: 'без обмежень' },
          ...groupFilterOptions,
        ],
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
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatDate(row.original.createdAt),
          fullValue: ({ row }) => formatDate(row.original.createdAt),
        }),
        size: 140,
      },
    ];
  }, [lookup, computedGroupsStatus]);
}

function RowActions(props: {
  organism: Organism;
  onEdit: (organism: Organism) => void;
  onDelete: (organism: Organism) => void;
}) {
  return (
    <MrtRowActions>
      <MrtRowActionButton
        label="Редагувати"
        onClick={() => props.onEdit(props.organism)}
        icon={<EditIcon fontSize="small" />}
      />
      <MrtRowActionButton
        label="Видалити"
        onClick={() => props.onDelete(props.organism)}
        icon={<DeleteIcon fontSize="small" />}
        tone="danger"
        opensModal
      />
    </MrtRowActions>
  );
}

function OrganismsTable(props: {
  data: Organism[];
  loading: boolean;
  lookup: OrganismLookup;
  computedGroupsStatus: LoadingStatus;
  onEdit: (organism: Organism) => void;
  onDelete: (organism: Organism) => void;
}) {
  const columns = useOrganismColumns(props.lookup, props.computedGroupsStatus);
  const tableStateContext = useTableStateContext();

  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps =
    typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

  const state = {
    showAlertBanner: false,
    showLoadingOverlay: false,
    showSkeletons: props.loading,
    globalFilter: tableStateContext.globalFilter,
    columnVisibility: tableStateContext.columnVisibility,
    columnFilters: tableStateContext.columnFilters,
    density: tableStateContext.density,
    sorting: tableStateContext.sorting,
    columnOrder: tableStateContext.columnOrder,
    columnSizing: tableStateContext.columnSizing,
  };

  const table = useAppMaterialReactTable({
    columns,
    data: props.loading ? buildOrganismLoadingRows() : props.data,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
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
    enableRowActions: !props.loading,
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
        size: mrtRowActionsColumnSize(2),
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
        ...getPageScrollTableContainerSx({ loading: props.loading, idleOverflow: 'auto' }),
      },
    },
    state,
  });

  useEffect(() => {
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
  const [status, setStatus] = useState<StatusMessage>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeLogins, setActiveLogins] = useState<string[] | null>(null);
  const [isLoadingLogins, setIsLoadingLogins] = useState(false);

  const hasMultipleActiveUsers = Boolean(props.organism && props.organism.loginsCount > 1);

  useEffect(() => {
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
          setStatus({
            kind: 'error',
            message: `Не вдалося завантажити активних користувачів: ${formatErrorMessage(error)}`,
          });
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
      setStatus({
        kind: 'error',
        message: `Помилка видалення організму: ${formatErrorMessage(error)}`,
      });
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
      setStatus({
        kind: 'error',
        message: `Помилка остаточного видалення: ${formatErrorMessage(error)}`,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={props.open} onClose={props.onClose} maxWidth="sm" fullWidth disableRestoreFocus>
      <DialogTitle>Підтвердження видалення</DialogTitle>
      <DialogContent className="space-y-3">
        {status ? (
          <PowerAlert severity={status.kind} onClose={() => setStatus(null)}>
            {status.message}
          </PowerAlert>
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
          <PowerAlert severity="warning">
            Для цього організму більше одного активного користувача. Видалення недоступне.
            {activeLogins && activeLogins.length > 0
              ? ` Активні логіни: ${activeLogins.join(', ')}`
              : ''}
          </PowerAlert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <PowerButton onClick={props.onClose} disabled={isSubmitting}>
          Скасувати
        </PowerButton>
        <PowerButton
          variant="outlined"
          color="error"
          onClick={handleSoftDelete}
          disabled={isSubmitting || hasMultipleActiveUsers}
        >
          Видалити
        </PowerButton>
        <PowerButton
          variant="contained"
          color="error"
          onClick={handleHardDelete}
          disabled={isSubmitting || hasMultipleActiveUsers}
        >
          Видалити назавжди
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

function AdminOrganismsNeoPageBody() {
  const [organisms, setOrganisms] = useState<Organism[]>([]);
  const [organismsStatus, setOrganismsStatus] = useState<LoadingStatus>('idle');
  const [organismsError, setOrganismsError] = useState<string | null>(null);
  const [groups, setGroups] = useState<SignalGroupFull[]>([]);
  const [organismGroups, setOrganismGroups] = useState<OrganismGroup[]>([]);
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);
  const [referenceStatus, setReferenceStatus] = useState<LoadingStatus>('idle');
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [computedGroupsById, setComputedGroupsById] = useState<Map<number, SignalGroupFull[]>>(
    new Map(),
  );
  const [computedGroupsStatus, setComputedGroupsStatus] = useState<LoadingStatus>('idle');

  const [deleteTarget, setDeleteTarget] = useState<Organism | null>(null);

  const lookup = useMemo<OrganismLookup>(() => {
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

  const loadComputedGroups = useCallback(async (data: Organism[]) => {
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

  const loadOrganisms = useCallback(async () => {
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

  const loadReferenceData = useCallback(async () => {
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

  const reloadAll = useCallback(async () => {
    await Promise.all([loadOrganisms(), loadReferenceData()]);
  }, [loadOrganisms, loadReferenceData]);

  useEffect(() => {
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
    return (
      <TableContentState
        status={organismsStatus}
        errorMessage={organismsError || 'Помилка завантаження'}
        loadingContent={
          <div className="flex w-full min-w-0 flex-1 min-h-0">
            <OrganismsTable
              data={organisms}
              loading
              lookup={lookup}
              computedGroupsStatus={computedGroupsStatus}
              onEdit={openEdit}
              onDelete={openDelete}
            />
          </div>
        }
      >
        <div className="flex w-full min-w-0 flex-1 min-h-0">
          <OrganismsTable
            data={organisms}
            loading={false}
            lookup={lookup}
            computedGroupsStatus={computedGroupsStatus}
            onEdit={openEdit}
            onDelete={openDelete}
          />
        </div>
      </TableContentState>
    );
  };

  return (
    <Box
      className="w-full"
      sx={{
        height: { xs: 'auto', lg: '100%' },
        minHeight: 0,
        overflow: { xs: 'visible', lg: 'hidden' },
      }}
    >
      <Stack
        spacing={3}
        useFlexGap
        sx={{
          height: { xs: 'auto', lg: '100%' },
          minHeight: 0,
          overflow: { xs: 'visible', lg: 'hidden' },
        }}
      >
        {referenceStatus === 'error' ? (
          <PowerAlert severity="error" onClose={() => setReferenceError(null)}>
            {referenceError || 'Помилка завантаження довідників'}
          </PowerAlert>
        ) : null}

        <TablePageToolbar
          title="Організми"
          withGlobalTextFilter
          hideGlobalTextFilter={organismsStatus !== 'success'}
          internalActionsDisabled={organismsStatus !== 'success'}
          actions={
            <div className="flex gap-3">
              <PowerButton variant="contained" onClick={() => navigateWithinSpa(buildCreateHref())}>
                Створити організм
              </PowerButton>
            </div>
          }
        />

        <Box sx={{ flex: 1, minHeight: { xs: 'auto', lg: 0 }, minWidth: 0, display: 'flex' }}>
          {renderTable()}
        </Box>

        <DeleteOrganismDialog
          organism={deleteTarget}
          open={Boolean(deleteTarget)}
          onClose={() => setDeleteTarget(null)}
          onReload={reloadAll}
        />
      </Stack>
    </Box>
  );
}

export function AdminOrganismsNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-organisms-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <AdminOrganismsNeoPageBody />
    </TableStateProvider>
  );
}
