import EditIcon from '@mui/icons-material/Edit';
import {
  Alert,
  Autocomplete,
  Box,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
} from '@mui/material';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';

import { CreateLoginReq, DeactivationReasonType, Login, Organism, SigintZone, UpdateLoginReq } from '../../../../Bindings';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../components/dialogStyles';
import { MrtRowActionButton, mrtRowActionsColumnSize } from '../../components/MrtRowActionButton';
import { PageErrorState } from '../../components/PageErrorState';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableContentState } from '../../components/TableContentState';
import { Button } from '../../components/mui-customized/button';
import { PowerChip } from '../../components/PowerChip';
import {
  CUSTOM_CELL_STYLES,
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
import { createLogin, createLoginDelta, listLogins, updateLogin } from '../../services/api/logins';
import { listOrganisms } from '../../services/api/organisms';
import { listSigintZones } from '../../services/api/zones';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

const ROLE_OPTIONS = [
  'Admin',
  'Api',
  'ApiAgent',
  'Rer',
  'Bpla',
  'Full',
  'Basic',
  'UnitsEditor',
  'CallsignsEditor',
  'AdvancedReports',
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
type LookupAutocompleteOption = {
  id: number;
  label: string;
};

type UserLookups = {
  zones: ZoneEntry[];
  zonesStatus: LoadingStatus;
  zonesError: string | null;
  organisms: Organism[];
  organismsStatus: LoadingStatus;
  organismsError: string | null;
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
  roles: ['Rer'],
  sigintZoneId: null,
  organismId: null,
  useDelta: true,
};

function renderLookupAutocompleteOption(
  props: React.HTMLAttributes<HTMLLIElement> & { key: React.Key },
  option: LookupAutocompleteOption,
  prefix: string,
) {
  const { key: _unusedKey, ...optionProps } = props;
  return (
    <Box component="li" {...optionProps} key={`${prefix}-${option.id}`}>
      {option.label}
    </Box>
  );
}

function buildUserLoadingRows(): Login[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    login: `loading-${index}`,
    roles: [],
    deleted: false,
    deactivationReason: null,
    organismEnabled: true,
    sigintZoneId: null,
    organismName: null,
    organismId: null,
    sigintZoneName: null,
    deltaLogin: null,
    createdAt: 0,
    lastActiveAt: null,
  }));
}

const DEBUG_USERS_NEO =
  typeof window !== 'undefined' && window.localStorage.getItem('debugUsersNeo') === '1';

function debugLog(message: string, details?: unknown) {
  if (!DEBUG_USERS_NEO) return;
  if (details === undefined) {
    console.info('[users-neo]', message);
    return;
  }
  console.info('[users-neo]', message, details);
}

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
  return useMemo(
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
                <PowerChip
                  key={role}
                  size="small"
                  label={role}
                  title={role}
                  interactive={false}
                  unselectedOpacity={1}
                  fontSize="0.75rem"
                  fontWeight={500}
                  labelPaddingX={0.5}
                  labelPaddingY={0.25}
                  unselectedBackgroundColor="#f1f5f9"
                  unselectedTextColor="#475569"
                  unselectedBorderColor="#cbd5e1"
                  sx={{ lineHeight: 1 }}
                />
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
  const [form, setForm] = useState<AddUserForm>(EMPTY_ADD_FORM);
  const [errors, setErrors] = useState<AddUserErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const zonesReady = lookups.zonesStatus === 'success';
  const zonesLoading = lookups.zonesStatus === 'loading';
  const organismsReady = lookups.organismsStatus === 'success';
  const organismsLoading = lookups.organismsStatus === 'loading';
  const canSubmit = zonesReady && !isSubmitting;

  const zoneAutocompleteOptions: LookupAutocompleteOption[] = lookups.zones.map(([zoneId, zone]) => ({
    id: zoneId,
    label: zone.name || `ID ${zoneId}`,
  }));

  const organismAutocompleteOptions: LookupAutocompleteOption[] = lookups.organisms.map((organism) => ({
    id: organism.id,
    label: organism.name || `ID ${organism.id}`,
  }));

  useEffect(() => {
    if (lookups.zones.length === 0) return;
    const [zoneId] = lookups.zones[0];
    setForm((prev) => (prev.sigintZoneId === null ? { ...prev, sigintZoneId: zoneId } : prev));
  }, [lookups.zones]);

  useEffect(() => {
    if (!open || !DEBUG_USERS_NEO) return;
    debugLog('add:options', {
      zonesStatus: lookups.zonesStatus,
      zonesCount: lookups.zones.length,
      zoneIds: lookups.zones.slice(0, 5).map(([zoneId]) => zoneId),
      sigintZoneId: form.sigintZoneId,
      organismsStatus: lookups.organismsStatus,
      organismsCount: lookups.organisms.length,
      organismIds: lookups.organisms.slice(0, 5).map((organism) => organism.id),
      organismId: form.organismId,
    });
  }, [
    open,
    form.sigintZoneId,
    form.organismId,
    lookups.zonesStatus,
    lookups.zones,
    lookups.organismsStatus,
    lookups.organisms,
  ]);

  useEffect(() => {
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
      <DialogContent className="space-y-5">
        <FormControlLabel
          control={
            <Checkbox
              checked={form.useDelta}
              onChange={(event) => {
                debugLog('add:delta toggle', event.target.checked);
                setForm((prev) => ({ ...prev, useDelta: event.target.checked, password: '' }));
                setErrors((prev) => ({ ...prev, password: undefined }));
              }}
            />
          }
          label="Delta логін"
        />

        {lookups.zonesError ? (
          <Alert severity="error">{`Не вдалося завантажити зони: ${lookups.zonesError}`}</Alert>
        ) : null}
        {lookups.organismsError ? (
          <Alert severity="error">{`Не вдалося завантажити організми: ${lookups.organismsError}`}</Alert>
        ) : null}
        {submitError ? <Alert severity="error">{submitError}</Alert> : null}

        <div className="grid gap-4 md:grid-cols-2">
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
          >
            {ROLE_OPTIONS.map((role) => (
              <MenuItem key={role} value={role}>
                {role}
              </MenuItem>
            ))}
          </TextField>

          <Autocomplete
            options={zoneAutocompleteOptions}
            value={zoneAutocompleteOptions.find((opt) => opt.id === form.sigintZoneId) || null}
            onChange={(_, newValue) => {
              const value = newValue?.id ?? null;
              debugLog('add:zone change', { newValue, parsed: value });
              setForm((prev) => ({ ...prev, sigintZoneId: value }));
              setErrors((prev) => ({ ...prev, zone: undefined }));
            }}
            loading={zonesLoading}
            disabled={isSubmitting}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            getOptionLabel={(option) => option.label}
            renderOption={(props, option) => renderLookupAutocompleteOption(props, option, 'add-zone')}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Зона"
                error={Boolean(errors.zone)}
                helperText={errors.zone || ' '}
              />
            )}
          />

          <Autocomplete
            options={organismAutocompleteOptions}
            value={organismAutocompleteOptions.find((opt) => opt.id === form.organismId) || null}
            onChange={(_, newValue) => {
              const value = newValue?.id ?? null;
              debugLog('add:organism change', { newValue, parsed: value });
              setForm((prev) => ({ ...prev, organismId: value }));
            }}
            loading={organismsLoading}
            disabled={isSubmitting}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            getOptionLabel={(option) => option.label}
            className="md:col-span-2"
            renderOption={(props, option) => renderLookupAutocompleteOption(props, option, 'add-organism')}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Організм"
              />
            )}
          />
        </div>
      </DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        <Button onClick={handleClose} disabled={isSubmitting}>
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
  const [form, setForm] = useState<EditUserForm | null>(null);
  const [errors, setErrors] = useState<EditUserErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const zonesReady = lookups.zonesStatus === 'success';
  const zonesLoading = lookups.zonesStatus === 'loading';
  const organismsReady = lookups.organismsStatus === 'success';
  const organismsLoading = lookups.organismsStatus === 'loading';

  const zoneAutocompleteOptions: LookupAutocompleteOption[] = lookups.zones.map(([zoneId, zone]) => ({
    id: zoneId,
    label: zone.name || `ID ${zoneId}`,
  }));

  const organismAutocompleteOptions: LookupAutocompleteOption[] = lookups.organisms.map((organism) => ({
    id: organism.id,
    label: organism.name || `ID ${organism.id}`,
  }));

  useEffect(() => {
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

  useEffect(() => {
    if (!open || !DEBUG_USERS_NEO || !form) return;
    debugLog('edit:options', {
      zonesStatus: lookups.zonesStatus,
      zonesCount: lookups.zones.length,
      zoneIds: lookups.zones.slice(0, 5).map(([zoneId]) => zoneId),
      sigintZoneId: form.sigintZoneId,
      organismsStatus: lookups.organismsStatus,
      organismsCount: lookups.organisms.length,
      organismIds: lookups.organisms.slice(0, 5).map((organism) => organism.id),
      organismId: form.organismId,
    });
  }, [
    open,
    form,
    form?.sigintZoneId,
    form?.organismId,
    lookups.zonesStatus,
    lookups.zones,
    lookups.organismsStatus,
    lookups.organisms,
  ]);

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

            <Autocomplete
              options={zoneAutocompleteOptions}
              value={zoneAutocompleteOptions.find((opt) => opt.id === form.sigintZoneId) || null}
              onChange={(_, newValue) => {
                const value = newValue?.id ?? null;
                debugLog('edit:zone change', { newValue, parsed: value });
                setForm((prev) => (prev ? { ...prev, sigintZoneId: value } : prev));
                setErrors((prev) => ({ ...prev, zone: undefined }));
              }}
              loading={zonesLoading}
              disabled={isSubmitting}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              getOptionLabel={(option) => option.label}
              className="xl:col-span-2"
              renderOption={(props, option) => renderLookupAutocompleteOption(props, option, 'edit-zone')}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Зона"
                  error={Boolean(errors.zone)}
                  helperText={errors.zone || ' '}
                />
              )}
            />

            <Autocomplete
              options={organismAutocompleteOptions}
              value={organismAutocompleteOptions.find((opt) => opt.id === form.organismId) || null}
              onChange={(_, newValue) => {
                const value = newValue?.id ?? null;
                debugLog('edit:organism change', { newValue, parsed: value });
                setForm((prev) => (prev ? { ...prev, organismId: value } : prev));
              }}
              loading={organismsLoading}
              disabled={isSubmitting}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              getOptionLabel={(option) => option.label}
              className="xl:col-span-2"
              renderOption={(props, option) => renderLookupAutocompleteOption(props, option, 'edit-organism')}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Організм"
                />
              )}
            />

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
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
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
    <MrtRowActionButton
      label="Редагувати"
      onClick={() => props.onEdit(props.login)}
      icon={<EditIcon fontSize="small" />}
    />
  );
}

function UsersTable(props: { data: Login[]; loading: boolean; onEdit: (login: Login) => void }) {
  const tableStateContext = useTableStateContext();
  const columns = useUsersColumns();
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
    data: props.loading ? buildUserLoadingRows() : props.data,
    ...defaultMRTOptions,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowVirtualization: false,
    enableRowActions: !props.loading,
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
        size: mrtRowActionsColumnSize(1),
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

function AdminUsersNeoPageBody() {
  const [logins, setLogins] = useState<Login[]>([]);
  const [status, setStatus] = useState<LoadingStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingLogin, setEditingLogin] = useState<Login | null>(null);
  const [zones, setZones] = useState<ZoneEntry[]>([]);
  const [organisms, setOrganisms] = useState<Organism[]>([]);
  const [zonesStatus, setZonesStatus] = useState<LoadingStatus>('idle');
  const [zonesError, setZonesError] = useState<string | null>(null);
  const [organismsStatus, setOrganismsStatus] = useState<LoadingStatus>('idle');
  const [organismsError, setOrganismsError] = useState<string | null>(null);

  async function loadLogins() {
    debugLog('loadLogins:start');
    setStatus('loading');
    setError(null);
    try {
      const rsp = await listLogins({ sortBy: 'LoginCreatedAtDesc', filterByRoles: null });
      debugLog('loadLogins:success', { count: rsp.users?.length ?? 0 });
      setLogins(rsp.users ?? []);
      setStatus('success');
    } catch (err) {
      debugLog('loadLogins:error', err);
      setStatus('error');
      setError(formatErrorMessage(err));
    }
  }

  async function loadZones() {
    debugLog('loadZones:start');
    setZonesStatus('loading');
    setZonesError(null);
    try {
      const zoneList = await listSigintZones();
      debugLog('loadZones:success', { count: zoneList.length, sample: zoneList.slice(0, 3) });
      setZones(zoneList);
      setZonesStatus('success');
    } catch (err) {
      debugLog('loadZones:error', err);
      setZonesStatus('error');
      setZonesError(formatErrorMessage(err));
    }
  }

  async function loadOrganisms() {
    debugLog('loadOrganisms:start');
    setOrganismsStatus('loading');
    setOrganismsError(null);
    try {
      const organismList = await listOrganisms({ sortBy: null });
      debugLog('loadOrganisms:success', { count: organismList.length, sample: organismList.slice(0, 3) });
      setOrganisms(organismList);
      setOrganismsStatus('success');
    } catch (err) {
      debugLog('loadOrganisms:error', err);
      setOrganismsStatus('error');
      setOrganismsError(formatErrorMessage(err));
    }
  }

  useEffect(() => {
    loadLogins();
    void loadZones();
    void loadOrganisms();
  }, []);

  const lookups: UserLookups = {
    zones,
    zonesStatus,
    zonesError,
    organisms,
    organismsStatus,
    organismsError,
  };

  const renderTable = () => {
    return (
      <TableContentState
        status={status}
        errorMessage={error || 'Помилка завантаження'}
        loadingContent={
          <div className="flex w-full min-w-0 flex-1 min-h-0">
            <UsersTable
              data={logins}
              loading
              onEdit={(login) => setEditingLogin(login)}
            />
          </div>
        }
      >
        <div className="flex w-full min-w-0 flex-1 min-h-0">
          <UsersTable
            data={logins}
            loading={false}
            onEdit={(login) => setEditingLogin(login)}
          />
        </div>
      </TableContentState>
    );
  };

  return (
    <Box className="w-full" sx={{ height: { xs: 'auto', lg: '100%' }, minHeight: 0, overflow: { xs: 'visible', lg: 'hidden' } }}>
      <Stack spacing={3} useFlexGap sx={{ height: { xs: 'auto', lg: '100%' }, minHeight: 0, overflow: { xs: 'visible', lg: 'hidden' } }}>
      <TablePageToolbar
        title="Користувачі"
        withGlobalTextFilter
        hideGlobalTextFilter={status !== 'success'}
        internalActionsDisabled={status !== 'success'}
        actions={
          <div className="flex gap-3">
            <Button variant="contained" onClick={() => setCreateOpen(true)}>
              Додати користувача
            </Button>
          </div>
        }
      />

      <Box sx={{ flex: 1, minHeight: { xs: 'auto', lg: 0 }, minWidth: 0, display: 'flex' }}>{renderTable()}</Box>

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
      </Stack>
    </Box>
  );
}

export function AdminUsersNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-users-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <AdminUsersNeoPageBody />
    </TableStateProvider>
  );
}
