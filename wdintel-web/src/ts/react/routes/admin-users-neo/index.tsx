import EditIcon from '@mui/icons-material/Edit';
import {
  Alert,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import React from 'react';

import { CreateLoginReq, DeactivationReasonType, Login, Organism, SigintZone, UpdateLoginReq } from '../../../../Bindings';
import { Button } from '../../components/mui-customized/button';
import { IconButton } from '../../components/mui-customized/icon-button';
import { CUSTOM_CELL_STYLES, CUSTOM_STYLES } from '../../components/mui-customized/table/custom-styles';
import { TableTopToolbar } from '../../components/mui-customized/table/components/table-top-toolbar';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import { TableStateProvider, useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { createLogin, createLoginDelta, listLogins, updateLogin } from '../../services/api/logins';
import { listOrganisms } from '../../services/api/organisms';
import { fetchServerInfo } from '../../services/api/server-info';
import { listSigintZones } from '../../services/api/zones';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

const ROLE_OPTIONS = [
  'Admin',
  'Api',
  'Rer',
  'Bpla',
  'Full',
  'Basic',
  'UnitsEditor',
  'CallsignsEditor',
  'DeleteMsg',
  'NoAutoLogout',
];

const STATUS_FILTER_OPTIONS = [
  { text: 'Активний', value: 'Активний' },
  { text: 'Видалено адміном', value: 'Видалено адміном' },
  { text: 'Неактивний', value: 'Неактивний' },
  { text: 'Організм деактивовано', value: 'Організм деактивовано' },
  { text: 'Невідомо', value: 'Невідомо' },
];

const DEFAULT_COLUMNS_VISIBILITY = {
  login: true,
  roles: true,
  organism: true,
  zone: true,
  deltaLogin: true,
  createdAt: true,
  status: true,
};

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'login',
  'roles',
  'organism',
  'zone',
  'deltaLogin',
  'createdAt',
  'status',
];

const defaultMRTOptions = getDefaultMRTOptions<Login>();

type StatusInfo = {
  label: string;
  colorClass: string;
  detail?: string;
};

type ZoneEntry = [number, SigintZone];

type UserLookups = {
  zones: ZoneEntry[];
  zonesStatus: LoadingStatus;
  zonesError: string | null;
  organisms: Organism[];
  organismsStatus: LoadingStatus;
  organismsError: string | null;
  featureDelta: boolean;
};

type AddUserForm = {
  login: string;
  password: string;
  roles: string[];
  sigintZoneId: number | null;
  organismId: number | null;
  useDelta: boolean;
};

type AddUserErrors = {
  login?: string;
  password?: string;
  roles?: string;
  zone?: string;
};

type EditUserForm = {
  login: string;
  password: string;
  roles: string[];
  sigintZoneId: number | null;
  organismId: number | null;
  deltaLogin: string;
  deleted: boolean;
};

type EditUserErrors = {
  roles?: string;
  zone?: string;
};

const EMPTY_ADD_FORM: AddUserForm = {
  login: '',
  password: '',
  roles: [],
  sigintZoneId: null,
  organismId: null,
  useDelta: false,
};

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

function formatDateTime(value: number | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('uk-UA');
}

function formatOptionalLabel(value: string | null | undefined): string {
  if (!value || !value.trim()) return '—';
  return value;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function buildAddUserErrors(form: AddUserForm): AddUserErrors {
  const errors: AddUserErrors = {};

  if (!form.login.trim()) {
    errors.login = 'Логін не може бути пустим';
  }

  if (!form.useDelta && !form.password.trim()) {
    errors.password = 'Пароль не може бути пустим';
  }

  if (form.roles.length === 0) {
    errors.roles = 'Виберіть хочаб 1 роль';
  }

  if (!form.sigintZoneId) {
    errors.zone = 'Виберіть зону';
  }

  return errors;
}

function hasFormErrors(errors: AddUserErrors): boolean {
  return Object.values(errors).some(Boolean);
}

function toCreateLoginReq(form: AddUserForm): CreateLoginReq {
  return {
    login: form.login.trim(),
    password: form.useDelta ? '' : form.password.trim(),
    roles: form.roles,
    sigintZoneId: form.sigintZoneId,
    organismId: form.organismId,
  };
}

function buildEditUserErrors(form: EditUserForm): EditUserErrors {
  const errors: EditUserErrors = {};

  if (form.roles.length === 0) {
    errors.roles = 'Виберіть хочаб 1 роль';
  }

  if (!form.sigintZoneId) {
    errors.zone = 'Виберіть зону';
  }

  return errors;
}

function toUpdateLoginReq(form: EditUserForm): UpdateLoginReq {
  const trimmedPassword = form.password.trim();
  const trimmedDelta = form.deltaLogin.trim();
  const deactivationReason: DeactivationReasonType | null = form.deleted ? 'Admin' : null;

  return {
    login: form.login,
    roles: form.roles,
    sigintZoneId: form.sigintZoneId,
    organismId: form.organismId,
    deleted: form.deleted,
    password: trimmedPassword ? trimmedPassword : null,
    deltaLogin: trimmedDelta ? trimmedDelta : null,
    deactivationReason,
  };
}

function getStatusInfo(login: Login): StatusInfo {
  if (login.deleted) {
    if (login.deactivationReason === 'Admin') {
      return { label: 'Видалено адміном', colorClass: 'text-red-600' };
    }
    if (login.deactivationReason === 'Inactive') {
      return {
        label: 'Неактивний',
        colorClass: 'text-yellow-600',
        detail: login.lastActiveAt ? `Останній: ${formatDateTime(login.lastActiveAt)}` : undefined,
      };
    }
    if (login.organismEnabled === false) {
      return { label: 'Організм деактивовано', colorClass: 'text-red-600' };
    }
    return { label: 'Невідомо', colorClass: 'text-gray-600' };
  }

  if (login.organismEnabled === false) {
    return { label: 'Організм деактивовано', colorClass: 'text-red-600' };
  }

  return { label: 'Активний', colorClass: 'text-green-600' };
}

function useUsersColumns(): MRT_ColumnDef<Login>[] {
  return React.useMemo(
    () => [
      {
        header: 'Логін',
        accessorKey: 'login',
        size: 200,
      },
      {
        header: 'Ролі',
        id: 'roles',
        accessorFn: (row) => row.roles,
        Cell: ({ row }) => {
          if (row.original.roles.length === 0) return <span>—</span>;
          return (
            <div className="flex flex-wrap gap-1">
              {row.original.roles.map((role) => (
                <span key={role} className="badge badge--neutral" title={role}>
                  {role}
                </span>
              ))}
            </div>
          );
        },
        filterVariant: 'multi-select',
        filterSelectOptions: ROLE_OPTIONS,
        filterFn: 'arrIncludesSome',
        enableSorting: false,
        size: 260,
      },
      {
        header: 'Організм',
        id: 'organism',
        accessorFn: (row) => formatOptionalLabel(row.organismName),
        Cell: ({ row }) => {
          const label = formatOptionalLabel(row.original.organismName);
          return (
            <Tooltip title={label}>
              <span>{label}</span>
            </Tooltip>
          );
        },
        size: 220,
      },
      {
        header: 'Напрямок',
        id: 'zone',
        accessorFn: (row) => formatOptionalLabel(row.sigintZoneName),
        Cell: ({ row }) => {
          const label = formatOptionalLabel(row.original.sigintZoneName);
          return (
            <Tooltip title={label}>
              <span>{label}</span>
            </Tooltip>
          );
        },
        size: 200,
      },
      {
        header: 'Дельта логін',
        id: 'deltaLogin',
        accessorFn: (row) => formatOptionalLabel(row.deltaLogin),
        size: 180,
      },
      {
        header: 'Створено',
        id: 'createdAt',
        accessorFn: (row) => row.createdAt,
        Cell: ({ row }) => <span>{formatDate(row.original.createdAt)}</span>,
        size: 150,
      },
      {
        header: 'Статус',
        id: 'status',
        accessorFn: (row) => [getStatusInfo(row).label],
        Cell: ({ row }) => {
          const status = getStatusInfo(row.original);
          return (
            <div className="flex flex-col items-center text-center leading-tight">
              <span className={status.colorClass}>{status.label}</span>
              {status.detail ? <span className="text-xs text-muted-foreground">{status.detail}</span> : null}
            </div>
          );
        },
        filterVariant: 'multi-select',
        filterSelectOptions: STATUS_FILTER_OPTIONS,
        filterFn: 'arrIncludesSome',
        enableSorting: false,
        size: 200,
        muiTableBodyCellProps: () => ({
          sx: {
            justifyContent: 'center',
            ...CUSTOM_CELL_STYLES,
          },
        }),
      },
    ],
    [],
  );
}

function AddUserDialog(props: {
  open: boolean;
  onClose: () => void;
  onUserCreated: (login: Login) => void;
  lookups: UserLookups;
}) {
  const { open, onClose, onUserCreated, lookups } = props;
  const [form, setForm] = React.useState<AddUserForm>(EMPTY_ADD_FORM);
  const [errors, setErrors] = React.useState<AddUserErrors>({});
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const zonesReady = lookups.zonesStatus === 'success';
  const zonesLoading = lookups.zonesStatus === 'loading';
  const organismsReady = lookups.organismsStatus === 'success';
  const organismsLoading = lookups.organismsStatus === 'loading';
  const canSubmit = zonesReady && !isSubmitting;

  const zoneOptions = lookups.zones.map(([zoneId, zone]) => (
    <MenuItem key={zoneId} value={zoneId}>
      {zone.name || `ID ${zoneId}`}
    </MenuItem>
  ));

  const organismOptions = lookups.organisms.map((organism) => (
    <MenuItem key={organism.id} value={organism.id}>
      {organism.name || `ID ${organism.id}`}
    </MenuItem>
  ));

  React.useEffect(() => {
    if (lookups.zones.length === 0) return;
    const [zoneId] = lookups.zones[0];
    setForm((prev) => (prev.sigintZoneId === null ? { ...prev, sigintZoneId: zoneId } : prev));
  }, [lookups.zones]);

  React.useEffect(() => {
    if (open) return;
    setForm(EMPTY_ADD_FORM);
    setErrors({});
    setSubmitError(null);
    setIsSubmitting(false);
  }, [open]);

  function handleClose() {
    if (isSubmitting) return;
    onClose();
  }

  async function handleCreateUser() {
    const nextErrors = buildAddUserErrors(form);
    setErrors(nextErrors);
    if (hasFormErrors(nextErrors)) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const payload = toCreateLoginReq(form);
      const created = form.useDelta ? await createLoginDelta(payload) : await createLogin(payload);
      onUserCreated(created);
      setForm(EMPTY_ADD_FORM);
      setErrors({});
      onClose();
    } catch (err) {
      setSubmitError(formatErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="lg" fullWidth>
      <DialogTitle>Додати користувача</DialogTitle>
      <DialogContent className="space-y-4">
        {lookups.featureDelta ? (
          <FormControlLabel
            control={
              <Checkbox
                checked={form.useDelta}
                onChange={(event) => {
                  setForm((prev) => ({ ...prev, useDelta: event.target.checked }));
                  setErrors((prev) => ({ ...prev, password: undefined }));
                }}
              />
            }
            label="Delta логін"
          />
        ) : null}

        {lookups.zonesError ? (
          <Alert severity="error">{`Не вдалося завантажити зони: ${lookups.zonesError}`}</Alert>
        ) : null}
        {lookups.organismsError ? (
          <Alert severity="error">{`Не вдалося завантажити організми: ${lookups.organismsError}`}</Alert>
        ) : null}
        {submitError ? <Alert severity="error">{submitError}</Alert> : null}

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <TextField
            label="Логін"
            value={form.login}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, login: event.target.value }));
              setErrors((prev) => ({ ...prev, login: undefined }));
            }}
            error={Boolean(errors.login)}
            helperText={errors.login || ' '}
            fullWidth
            disabled={isSubmitting}
            className="xl:col-span-2"
          />

          <TextField
            label="Пароль"
            value={form.password}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, password: event.target.value }));
              setErrors((prev) => ({ ...prev, password: undefined }));
            }}
            error={Boolean(errors.password)}
            helperText={errors.password || ' '}
            fullWidth
            disabled={isSubmitting || form.useDelta}
            className="xl:col-span-2"
          />

          <TextField
            select
            label="Ролі"
            value={form.roles}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, roles: asStringArray(event.target.value) }));
              setErrors((prev) => ({ ...prev, roles: undefined }));
            }}
            fullWidth
            SelectProps={{
              multiple: true,
              renderValue: (selected) => (selected as string[]).join(', ') || '—',
            }}
            error={Boolean(errors.roles)}
            helperText={errors.roles || ' '}
            disabled={isSubmitting}
            className="xl:col-span-2"
          >
            {ROLE_OPTIONS.map((role) => (
              <MenuItem key={role} value={role}>
                {role}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            label="Зона"
            value={form.sigintZoneId ?? ''}
            onChange={(event) => {
              const value = event.target.value ? Number(event.target.value) : null;
              setForm((prev) => ({ ...prev, sigintZoneId: value }));
              setErrors((prev) => ({ ...prev, zone: undefined }));
            }}
            fullWidth
            error={Boolean(errors.zone)}
            helperText={errors.zone || ' '}
            disabled={isSubmitting || !zonesReady}
            className="xl:col-span-2"
          >
            {zonesLoading ? (
              <MenuItem value="">Завантаження...</MenuItem>
            ) : (
              <>
                <MenuItem value="">—</MenuItem>
                {zoneOptions}
              </>
            )}
          </TextField>

          <TextField
            select
            label="Організм"
            value={form.organismId ?? ''}
            onChange={(event) => {
              const value = event.target.value ? Number(event.target.value) : null;
              setForm((prev) => ({ ...prev, organismId: value }));
            }}
            fullWidth
            disabled={isSubmitting || !organismsReady}
            className="xl:col-span-2"
          >
            {organismsLoading ? (
              <MenuItem value="">Завантаження...</MenuItem>
            ) : (
              <>
                <MenuItem value="">—</MenuItem>
                {organismOptions}
              </>
            )}
          </TextField>
        </div>
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" onClick={handleClose} disabled={isSubmitting}>
          Скасувати
        </Button>
        <Button variant="contained" onClick={handleCreateUser} disabled={!canSubmit}>
          Додати
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function EditUserDialog(props: {
  open: boolean;
  login: Login | null;
  onClose: () => void;
  onUserUpdated: (login: Login) => void;
  lookups: UserLookups;
}) {
  const { open, login, onClose, onUserUpdated, lookups } = props;
  const [form, setForm] = React.useState<EditUserForm | null>(null);
  const [errors, setErrors] = React.useState<EditUserErrors>({});
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const zonesReady = lookups.zonesStatus === 'success';
  const zonesLoading = lookups.zonesStatus === 'loading';
  const organismsReady = lookups.organismsStatus === 'success';
  const organismsLoading = lookups.organismsStatus === 'loading';

  const zoneOptions = lookups.zones.map(([zoneId, zone]) => (
    <MenuItem key={zoneId} value={zoneId}>
      {zone.name || `ID ${zoneId}`}
    </MenuItem>
  ));

  const organismOptions = lookups.organisms.map((organism) => (
    <MenuItem key={organism.id} value={organism.id}>
      {organism.name || `ID ${organism.id}`}
    </MenuItem>
  ));

  React.useEffect(() => {
    if (!open || !login) {
      setForm(null);
      setErrors({});
      setSubmitError(null);
      setIsSubmitting(false);
      return;
    }

    setForm({
      login: login.login,
      password: '',
      roles: login.roles ?? [],
      sigintZoneId: login.sigintZoneId ?? null,
      organismId: login.organismId ?? null,
      deltaLogin: login.deltaLogin ?? '',
      deleted: login.deleted,
    });
    setErrors({});
    setSubmitError(null);
    setIsSubmitting(false);
  }, [open, login]);

  function handleClose() {
    if (isSubmitting) return;
    onClose();
  }

  async function handleSave() {
    if (!form) return;
    const nextErrors = buildEditUserErrors(form);
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const updated = await updateLogin(toUpdateLoginReq(form));
      onUserUpdated(updated);
      onClose();
    } catch (err) {
      setSubmitError(formatErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="lg" fullWidth>
      <DialogTitle>Редагувати користувача</DialogTitle>
      <DialogContent className="space-y-4">
        {lookups.zonesError ? (
          <Alert severity="error">{`Не вдалося завантажити зони: ${lookups.zonesError}`}</Alert>
        ) : null}
        {lookups.organismsError ? (
          <Alert severity="error">{`Не вдалося завантажити організми: ${lookups.organismsError}`}</Alert>
        ) : null}
        {submitError ? <Alert severity="error">{submitError}</Alert> : null}

        {form ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
            <TextField
              label="Логін"
              value={form.login}
              fullWidth
              disabled
              className="xl:col-span-2"
            />

            <TextField
              label="Пароль"
              type="password"
              value={form.password}
              onChange={(event) => {
                setForm((prev) => (prev ? { ...prev, password: event.target.value } : prev));
              }}
              helperText="Залиште пустим, щоб не змінювати"
              fullWidth
              disabled={isSubmitting}
              className="xl:col-span-2"
            />

            <TextField
              select
              label="Ролі"
              value={form.roles}
              onChange={(event) => {
                setForm((prev) => (prev ? { ...prev, roles: asStringArray(event.target.value) } : prev));
                setErrors((prev) => ({ ...prev, roles: undefined }));
              }}
              fullWidth
              SelectProps={{
                multiple: true,
                renderValue: (selected) => (selected as string[]).join(', ') || '—',
              }}
              error={Boolean(errors.roles)}
              helperText={errors.roles || ' '}
              disabled={isSubmitting}
              className="xl:col-span-2"
            >
              {ROLE_OPTIONS.map((role) => (
                <MenuItem key={role} value={role}>
                  {role}
                </MenuItem>
              ))}
            </TextField>

            <TextField
              select
              label="Зона"
              value={form.sigintZoneId ?? ''}
              onChange={(event) => {
                const value = event.target.value ? Number(event.target.value) : null;
                setForm((prev) => (prev ? { ...prev, sigintZoneId: value } : prev));
                setErrors((prev) => ({ ...prev, zone: undefined }));
              }}
              fullWidth
              error={Boolean(errors.zone)}
              helperText={errors.zone || ' '}
              disabled={isSubmitting || !zonesReady}
              className="xl:col-span-2"
            >
              {zonesLoading ? (
                <MenuItem value="">Завантаження...</MenuItem>
              ) : (
                <>
                  <MenuItem value="">—</MenuItem>
                  {zoneOptions}
                </>
              )}
            </TextField>

            <TextField
              select
              label="Організм"
              value={form.organismId ?? ''}
              onChange={(event) => {
                const value = event.target.value ? Number(event.target.value) : null;
                setForm((prev) => (prev ? { ...prev, organismId: value } : prev));
              }}
              fullWidth
              disabled={isSubmitting || !organismsReady}
              className="xl:col-span-2"
            >
              {organismsLoading ? (
                <MenuItem value="">Завантаження...</MenuItem>
              ) : (
                <>
                  <MenuItem value="">—</MenuItem>
                  {organismOptions}
                </>
              )}
            </TextField>

            {lookups.featureDelta ? (
              <TextField
                label="Delta логін"
                value={form.deltaLogin}
                onChange={(event) => {
                  setForm((prev) => (prev ? { ...prev, deltaLogin: event.target.value } : prev));
                }}
                fullWidth
                disabled={isSubmitting}
                className="xl:col-span-2"
              />
            ) : null}

            <div className="flex items-center xl:col-span-2">
              <FormControlLabel
                control={
                  <Checkbox
                    checked={form.deleted}
                    onChange={(event) => {
                      setForm((prev) => (prev ? { ...prev, deleted: event.target.checked } : prev));
                    }}
                  />
                }
                label="Видалити користувача"
              />
            </div>
          </div>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" onClick={handleClose} disabled={isSubmitting}>
          Скасувати
        </Button>
        <Button variant="contained" onClick={handleSave} disabled={isSubmitting || !form}>
          Зберегти
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function RowActions(props: { login: Login; onEdit: (login: Login) => void }) {
  return (
    <Tooltip title="Редагувати">
      <IconButton size="small" onClick={() => props.onEdit(props.login)}>
        <EditIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

function UsersTable(props: { data: Login[]; onEdit: (login: Login) => void }) {
  const tableStateContext = useTableStateContext();
  const columns = useUsersColumns();
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
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowVirtualization: false,
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => <RowActions login={row.original} onEdit={props.onEdit} />,
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
    defaultColumn: {
      size: 200,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: 60,
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

function AdminUsersNeoPageBody() {
  const [logins, setLogins] = React.useState<Login[]>([]);
  const [status, setStatus] = React.useState<LoadingStatus>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingLogin, setEditingLogin] = React.useState<Login | null>(null);
  const [zones, setZones] = React.useState<ZoneEntry[]>([]);
  const [organisms, setOrganisms] = React.useState<Organism[]>([]);
  const [zonesStatus, setZonesStatus] = React.useState<LoadingStatus>('idle');
  const [zonesError, setZonesError] = React.useState<string | null>(null);
  const [organismsStatus, setOrganismsStatus] = React.useState<LoadingStatus>('idle');
  const [organismsError, setOrganismsError] = React.useState<string | null>(null);
  const [featureDelta, setFeatureDelta] = React.useState(false);

  async function loadLogins() {
    setStatus('loading');
    setError(null);
    try {
      const rsp = await listLogins({ sortBy: 'LoginCreatedAtDesc', filterByRoles: null });
      setLogins(rsp.users ?? []);
      setStatus('success');
    } catch (err) {
      setStatus('error');
      setError(formatErrorMessage(err));
    }
  }

  async function loadZones() {
    setZonesStatus('loading');
    setZonesError(null);
    try {
      const zoneList = await listSigintZones();
      setZones(zoneList);
      setZonesStatus('success');
    } catch (err) {
      setZonesStatus('error');
      setZonesError(formatErrorMessage(err));
    }
  }

  async function loadOrganisms() {
    setOrganismsStatus('loading');
    setOrganismsError(null);
    try {
      const organismList = await listOrganisms({ sortBy: null });
      setOrganisms(organismList);
      setOrganismsStatus('success');
    } catch (err) {
      setOrganismsStatus('error');
      setOrganismsError(formatErrorMessage(err));
    }
  }

  async function loadServerInfo() {
    try {
      const info = await fetchServerInfo();
      setFeatureDelta(Boolean(info.featureDelta));
    } catch (_) {
      setFeatureDelta(false);
    }
  }

  React.useEffect(() => {
    loadLogins();
    void loadZones();
    void loadOrganisms();
    void loadServerInfo();
  }, []);

  const lookups: UserLookups = {
    zones,
    zonesStatus,
    zonesError,
    organisms,
    organismsStatus,
    organismsError,
    featureDelta,
  };

  const renderTable = () => {
    if (status === 'loading') {
      return (
        <div className="flex items-center justify-center py-12">
          <CircularProgress size={28} />
        </div>
      );
    }
    if (status === 'error') {
      return <div className="text-center py-8 text-red-600">{error || 'Помилка завантаження'}</div>;
    }
    if (status === 'success') {
      return (
        <div className="table-responsive-modern w-full min-w-0">
          <UsersTable data={logins} onEdit={(login) => setEditingLogin(login)} />
        </div>
      );
    }
    return null;
  };

  return (
    <div className="mt-2 w-full space-y-4">
      <TableTopToolbar
        header={
          <Typography variant="h5" className="!font-semibold">
            Користувачі
          </Typography>
        }
        withDatePicker={false}
        withGlobalTextFilter
        additionalActions={
          <div className="flex gap-2">
            <Button variant="outlined" onClick={loadLogins}>
              Оновити
            </Button>
            <Button variant="contained" onClick={() => setCreateOpen(true)}>
              Додати
            </Button>
          </div>
        }
      />

      {renderTable()}

      <AddUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onUserCreated={(login) => setLogins((prev) => [login, ...prev])}
        lookups={lookups}
      />
      <EditUserDialog
        open={Boolean(editingLogin)}
        login={editingLogin}
        onClose={() => setEditingLogin(null)}
        onUserUpdated={(login) =>
          setLogins((prev) => prev.map((item) => (item.login === login.login ? login : item)))
        }
        lookups={lookups}
      />
    </div>
  );
}

export function AdminUsersNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-users-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
    >
      <AdminUsersNeoPageBody />
    </TableStateProvider>
  );
}
