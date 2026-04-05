import DeleteIcon from '@mui/icons-material/Delete';
import {
  Alert,
  Autocomplete,
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';

import { ListOrganismsReq, Organism } from '../../../../Bindings';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../components/dialogStyles';
import { MrtRowActionButton, mrtRowActionsColumnSize } from '../../components/MrtRowActionButton';
import { PageErrorState } from '../../components/PageErrorState';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableContentState } from '../../components/TableContentState';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { Button } from '../../components/mui-customized/button';
import {
  CUSTOM_STYLES,
  FULL_HEIGHT_LOADING_ROW_COUNT,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../components/mui-customized/table/custom-styles';
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

const DEFAULT_COLUMN_ORDER = ['mrt-row-numbers', 'mrt-row-actions', 'grantFrom', 'grantTo', 'author', 'createdAt'];

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

function buildKeyPolicyLoadingRows(): SigintKeySharePolicy[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    id: -index - 1,
    grantFrom: 0,
    grantTo: 0,
    author: '',
    createdAt: 0,
  }));
}

function usePolicyColumns(organismNames: Map<number, string>): MRT_ColumnDef<SigintKeySharePolicy>[] {
  return useMemo(
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
  loading: boolean;
  organismNames: Map<number, string>;
  onDelete: (policy: SigintKeySharePolicy) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = usePolicyColumns(props.organismNames);

  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

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

  const table = useMaterialReactTable({
    columns,
    data: props.loading ? buildKeyPolicyLoadingRows() : props.data,
    ...defaultMRTOptions,
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
      <MrtRowActionButton
        label="Видалити"
        onClick={() => props.onDelete(row.original)}
        icon={<DeleteIcon fontSize="small" />}
        tone="danger"
      />
    ),
    defaultColumn: {
      size: 200,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: mrtRowActionsColumnSize(1),
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

function AdminKeysNeoPageBody() {
  const [status, setStatus] = useState<LoadingStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [policies, setPolicies] = useState<SigintKeySharePolicy[]>([]);

  const [organisms, setOrganisms] = useState<Organism[]>([]);
  const [organismsStatus, setOrganismsStatus] = useState<LoadingStatus>('idle');
  const [organismsError, setOrganismsError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createFrom, setCreateFrom] = useState<Organism | null>(null);
  const [createTo, setCreateTo] = useState<Organism | null>(null);
  const [createErrors, setCreateErrors] = useState<CreateFieldErrors>({});
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSaving, setCreateSaving] = useState(false);

  const [deleteState, setDeleteState] = useState<DeleteState>(null);

  const organismNames = useMemo(() => new Map(organisms.map((organism) => [organism.id, organism.name])), [organisms]);

  const organismOptions = useMemo(() => organisms, [organisms]);

  useEffect(() => {
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
    return (
      <TableContentState
        status={status}
        errorMessage={error || 'Помилка завантаження'}
        fillAvailableHeight={status !== 'success'}
        loadingContent={
          <div className="flex w-full min-w-0 flex-1 min-h-0">
            <KeyPoliciesTable
              data={policies}
              loading
              organismNames={organismNames}
              onDelete={(policy) => setDeleteState({ policy, isDeleting: false, error: null })}
            />
          </div>
        }
      >
        <div className="flex w-full min-w-0 flex-1 min-h-0">
          <KeyPoliciesTable
            data={policies}
            loading={false}
            organismNames={organismNames}
            onDelete={(policy) => setDeleteState({ policy, isDeleting: false, error: null })}
          />
        </div>
      </TableContentState>
    );
  };

  return (
    <Box className="w-full" sx={{ height: { xs: 'auto', lg: '100%' }, minHeight: 0, overflow: { xs: 'visible', lg: 'hidden' } }}>
      <Stack spacing={3} useFlexGap sx={{ height: { xs: 'auto', lg: '100%' }, minHeight: 0, overflow: { xs: 'visible', lg: 'hidden' } }}>
      {organismsStatus === 'error' ? (
        <Alert severity="error" onClose={() => setOrganismsError(null)}>
          {organismsError || 'Помилка завантаження організацій'}
        </Alert>
      ) : null}

      <TablePageToolbar
        title="Політики доступу до ключів"
        titleInfo={
          <Box sx={{ maxWidth: 360 }}>
            Додайте нову політику, щоби користувачі організму-отримувача бачили всі ключі шифрування, створені
            користувачами організму-власника.
            <br />
            <br />
            Політика надає односторонній доступ лише до ключів, якими володіє організм. Для доступу до ключів,
            переданих власнику іншими організмами, створіть окремі політики.
          </Box>
        }
        withGlobalTextFilter
        hideGlobalTextFilter={status !== 'success'}
        internalActionsDisabled={status !== 'success'}
        actions={
          <div className="flex gap-3">
            <Button variant="contained" onClick={openCreateDialog}>
              Додати політику
            </Button>
          </div>
        }
      />

      <Box sx={{ flex: 1, minHeight: { xs: 'auto', lg: 0 }, minWidth: 0, display: 'flex' }}>{renderTable()}</Box>

      <Dialog open={createOpen} onClose={closeCreateDialog} maxWidth="sm" fullWidth>
        <DialogTitle>Додати політику доступу</DialogTitle>
        <DialogContent className="space-y-3">
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
        <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
          <Button onClick={closeCreateDialog} disabled={createSaving}>
            Скасувати
          </Button>
          <Button variant="contained" onClick={handleCreate} disabled={createSaving}>
            Зберегти
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDangerDialog
        open={Boolean(deleteState)}
        onClose={() => setDeleteState(null)}
        onConfirm={handleDelete}
        submitting={Boolean(deleteState?.isDeleting)}
        disabled={!deleteState}
      >
          {deleteState?.error ? <Alert severity="error">{deleteState.error}</Alert> : null}
          <Typography variant="body2" className="text-muted-foreground">
            {deleteState
              ? `Видалити політику для ${getOrganismLabel(deleteState.policy.grantFrom, organismNames)} → ${getOrganismLabel(deleteState.policy.grantTo, organismNames)}?`
              : ''}
          </Typography>
      </ConfirmDangerDialog>
      </Stack>
    </Box>
  );
}

export function AdminKeysNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-keys-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <AdminKeysNeoPageBody />
    </TableStateProvider>
  );
}
