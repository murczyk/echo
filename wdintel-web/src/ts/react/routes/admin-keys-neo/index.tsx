import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
  Alert,
  Autocomplete,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import React from 'react';

import { ListOrganismsReq, Organism } from '../../../../Bindings';
import { Button } from '../../components/mui-customized/button';
import { IconButton } from '../../components/mui-customized/icon-button';
import { CUSTOM_STYLES } from '../../components/mui-customized/table/custom-styles';
import { TableTopToolbar } from '../../components/mui-customized/table/components/table-top-toolbar';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import { TableStateProvider, useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { listOrganisms } from '../../services/api/organisms';
import {
  createKeySharePolicy,
  deleteKeySharePolicy,
  listKeySharePolicies,
  SigintKeySharePolicy,
} from '../../services/api/keys';


type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

type CreateFieldErrors = {
  grantFrom?: string;
  grantTo?: string;
};

type DeleteState = {
  policy: SigintKeySharePolicy;
  isDeleting: boolean;
  error: string | null;
} | null;

const DEFAULT_COLUMNS_VISIBILITY = {
  grantFrom: true,
  grantTo: true,
  author: true,
  createdAt: true,
};

const DEFAULT_COLUMN_ORDER = ['mrt-row-actions', 'grantFrom', 'grantTo', 'author', 'createdAt'];

const defaultMRTOptions = getDefaultMRTOptions<SigintKeySharePolicy>();

const ORGANISMS_REQ: ListOrganismsReq = { sortBy: 'OrganismNameAsc' };

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function formatDate(value: number | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('uk-UA');
}

function getOrganismLabel(organismId: number, organismNames: Map<number, string>) {
  return organismNames.get(organismId) || `#${organismId}`;
}

function usePolicyColumns(organismNames: Map<number, string>): MRT_ColumnDef<SigintKeySharePolicy>[] {
  return React.useMemo(
    () => [
      {
        header: 'Власник ключів шифрування',
        id: 'grantFrom',
        accessorFn: (row) => getOrganismLabel(row.grantFrom, organismNames),
        Cell: ({ row }) => {
          const label = getOrganismLabel(row.original.grantFrom, organismNames);
          return (
            <Tooltip title={label}>
              <span>{label}</span>
            </Tooltip>
          );
        },
        size: 240,
      },
      {
        header: 'Отримувач прав на перегляд ключів шифрування',
        id: 'grantTo',
        accessorFn: (row) => getOrganismLabel(row.grantTo, organismNames),
        Cell: ({ row }) => {
          const label = getOrganismLabel(row.original.grantTo, organismNames);
          return (
            <Tooltip title={label}>
              <span>{label}</span>
            </Tooltip>
          );
        },
        size: 260,
      },
      {
        header: 'Автор',
        accessorKey: 'author',
        size: 180,
      },
      {
        header: 'Створено',
        id: 'createdAt',
        accessorFn: (row) => row.createdAt,
        Cell: ({ row }) => <span>{formatDate(row.original.createdAt)}</span>,
        size: 140,
      },
    ],
    [organismNames],
  );
}

function KeyPoliciesTable(props: {
  data: SigintKeySharePolicy[];
  organismNames: Map<number, string>;
  onDelete: (policy: SigintKeySharePolicy) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = usePolicyColumns(props.organismNames);

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
    enableRowNumbers: false,
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
      <Tooltip title="Видалити">
        <IconButton size="small" onClick={() => props.onDelete(row.original)}>
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    ),
    defaultColumn: {
      size: 200,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
    },
    muiTablePaperProps: ({ table }) => {
      const baseProps = resolvedPaperProps({ table });
      return {
        ...baseProps,
        sx: {
          ...(baseProps as any)?.sx,
          minWidth: 0,
          maxWidth: '100%',
          width: '100%',
        },
      };
    },
    muiTableContainerProps: {
      sx: {
        ...(CUSTOM_STYLES.muiTableContainerProps as any)?.sx,
        minWidth: 0,
        maxWidth: '100%',
        width: '100%',
        maxHeight: 'none',
        overflowX: 'auto',
        overflowY: 'visible',
      },
    },
    state,
  });

  React.useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function AdminKeysNeoPageBody() {
  const [status, setStatus] = React.useState<LoadingStatus>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [policies, setPolicies] = React.useState<SigintKeySharePolicy[]>([]);

  const [organisms, setOrganisms] = React.useState<Organism[]>([]);
  const [organismsStatus, setOrganismsStatus] = React.useState<LoadingStatus>('idle');
  const [organismsError, setOrganismsError] = React.useState<string | null>(null);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [createFrom, setCreateFrom] = React.useState<Organism | null>(null);
  const [createTo, setCreateTo] = React.useState<Organism | null>(null);
  const [createErrors, setCreateErrors] = React.useState<CreateFieldErrors>({});
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [createSaving, setCreateSaving] = React.useState(false);

  const [deleteState, setDeleteState] = React.useState<DeleteState>(null);

  const organismNames = React.useMemo(() => new Map(organisms.map((organism) => [organism.id, organism.name])), [organisms]);

  const organismOptions = React.useMemo(() => organisms, [organisms]);

  React.useEffect(() => {
    void loadPolicies();
    void loadOrganisms();
  }, []);

  async function loadPolicies() {
    setStatus('loading');
    setError(null);
    try {
      const data = await listKeySharePolicies();
      setPolicies(data);
      setStatus('success');
    } catch (err) {
      setStatus('error');
      setError(formatErrorMessage(err));
    }
  }

  async function loadOrganisms() {
    setOrganismsStatus('loading');
    setOrganismsError(null);
    try {
      const data = await listOrganisms(ORGANISMS_REQ);
      setOrganisms(data);
      setOrganismsStatus('success');
    } catch (err) {
      setOrganismsStatus('error');
      setOrganismsError(formatErrorMessage(err));
    }
  }

  function openCreateDialog() {
    setCreateFrom(null);
    setCreateTo(null);
    setCreateErrors({});
    setCreateError(null);
    setCreateOpen(true);
  }

  function closeCreateDialog() {
    if (createSaving) return;
    setCreateOpen(false);
  }

  function validateCreate(): CreateFieldErrors {
    const errors: CreateFieldErrors = {};
    if (!createFrom) errors.grantFrom = 'Оберіть організм для надання';
    if (!createTo) errors.grantTo = 'Оберіть організм для отримання';
    if (createFrom && createTo && createFrom.id === createTo.id) {
      errors.grantTo = 'Організації мають відрізнятися';
    }
    return errors;
  }

  async function handleCreate() {
    const errors = validateCreate();
    if (Object.keys(errors).length > 0) {
      setCreateErrors(errors);
      return;
    }
    if (!createFrom || !createTo) return;

    setCreateSaving(true);
    setCreateError(null);

    try {
      const created = await createKeySharePolicy({ grantFrom: createFrom.id, grantTo: createTo.id });
      setPolicies((prev) => [created, ...prev]);
      setCreateOpen(false);
    } catch (err) {
      setCreateError(formatErrorMessage(err));
    } finally {
      setCreateSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteState) return;
    setDeleteState({ ...deleteState, isDeleting: true, error: null });
    try {
      await deleteKeySharePolicy({ id: deleteState.policy.id });
      setPolicies((prev) => prev.filter((item) => item.id !== deleteState.policy.id));
      setDeleteState(null);
    } catch (err) {
      setDeleteState({ ...deleteState, isDeleting: false, error: formatErrorMessage(err) });
    }
  }

  const renderTable = () => {
    if (status === 'loading') {
      return (
        <div className="flex h-full items-center justify-center">
          <CircularProgress size={28} />
        </div>
      );
    }
    if (status === 'error') {
      return <div className="text-center py-8 text-red-600">{error || 'Помилка завантаження'}</div>;
    }
    return (
      <div className="table-responsive-modern w-full min-w-0">
        <KeyPoliciesTable
          data={policies}
          organismNames={organismNames}
          onDelete={(policy) => setDeleteState({ policy, isDeleting: false, error: null })}
        />
      </div>
    );
  };

  return (
    <div className="mt-2 w-full space-y-4 min-w-0">
      {organismsStatus === 'error' ? (
        <Alert severity="error" onClose={() => setOrganismsError(null)}>
          {organismsError || 'Помилка завантаження організацій'}
        </Alert>
      ) : null}

      <TableTopToolbar
        header={
          <Typography variant="h5" className="!font-semibold">
            Політики доступу до ключів
          </Typography>
        }
        withDatePicker={false}
        withGlobalTextFilter={false}
        additionalActions={
          <div className="flex gap-2">
            <Button variant="outlined" onClick={loadPolicies}>
              Оновити
            </Button>
            <Button variant="contained" onClick={openCreateDialog}>
              Додати
            </Button>
          </div>
        }
      />

      <div className="rounded-lg border bg-[var(--bs-tertiary-bg)] p-4 text-sm text-muted-foreground space-y-2">
        <p>
          Додайте нову політику щоби користувачі з організму що є отримувачем прав на перегляд мали можливість бачити
          усі ключі шифрування які створили користувачі з організму - Власника ключів.
        </p>
        <p>
          Ця політика надає доступ до ключів в односторонньому порядку, і лише до тих ключів якими володіє організм;
          для надання прав до ключів якимим поділилися із Власником інші організми створіть окремі політики.
        </p>
      </div>

      {renderTable()}

      <Dialog open={createOpen} onClose={closeCreateDialog} maxWidth="sm" fullWidth>
        <DialogTitle>Додати політику доступу</DialogTitle>
        <DialogContent className="space-y-4">
          {createError ? <Alert severity="error">{createError}</Alert> : null}
          <Autocomplete
            options={organismOptions}
            getOptionLabel={(option) => option.name}
            value={createFrom}
            onChange={(_, value) => {
              setCreateFrom(value);
              setCreateErrors((prev) => ({ ...prev, grantFrom: undefined }));
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Власник ключів шифрування"
                error={Boolean(createErrors.grantFrom)}
                helperText={createErrors.grantFrom}
              />
            )}
            isOptionEqualToValue={(option, value) => option.id === value.id}
          />
          <Autocomplete
            options={organismOptions}
            getOptionLabel={(option) => option.name}
            value={createTo}
            onChange={(_, value) => {
              setCreateTo(value);
              setCreateErrors((prev) => ({ ...prev, grantTo: undefined }));
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Отримувач прав на перегляд ключів"
                error={Boolean(createErrors.grantTo)}
                helperText={createErrors.grantTo}
              />
            )}
            isOptionEqualToValue={(option, value) => option.id === value.id}
          />
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" onClick={closeCreateDialog} disabled={createSaving}>
            Скасувати
          </Button>
          <Button variant="contained" onClick={handleCreate} disabled={createSaving}>
            Зберегти
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(deleteState)} onClose={() => setDeleteState(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Підтвердження видалення</DialogTitle>
        <DialogContent className="space-y-3">
          {deleteState?.error ? <Alert severity="error">{deleteState.error}</Alert> : null}
          <Typography variant="body2" className="text-muted-foreground">
            {deleteState
              ? `Видалити політику для ${getOrganismLabel(deleteState.policy.grantFrom, organismNames)} → ${getOrganismLabel(deleteState.policy.grantTo, organismNames)}?`
              : ''}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" onClick={() => setDeleteState(null)} disabled={deleteState?.isDeleting}>
            Скасувати
          </Button>
          <Button variant="contained" onClick={handleDelete} disabled={deleteState?.isDeleting}>
            Видалити
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}

export function AdminKeysNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-keys-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
    >
      <AdminKeysNeoPageBody />
    </TableStateProvider>
  );
}
