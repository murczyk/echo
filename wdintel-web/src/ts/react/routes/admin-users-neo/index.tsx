import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EditIcon from '@mui/icons-material/Edit';
import {
  Autocomplete,
  Box,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Button,
  Typography,
} from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';

import {
  CreateLoginReq,
  DeactivationReasonType,
  Login,
  Organism,
  SigintZone,
  UpdateLoginReq,
} from '../../../../Bindings';
import { MrtRowActionButton, mrtRowActionsColumnSize } from '../../components/MrtRowActionButton';
import { PageErrorState } from '../../components/PageErrorState';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableContentState } from '../../components/TableContentState';
import { PowerButton } from '../../components/PowerButton';
import { EchoChip } from '../../components/EchoChip';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  FULL_HEIGHT_LOADING_ROW_COUNT,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  getDefaultMRTOptions,
  mrtItemsCell,
  mrtCustomCell,
  mrtTextCell,
  useAppMaterialReactTable,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import { MrtOverflowText } from '../../components/mui-customized/table/mrt-overflow';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { createLogin, createLoginDelta, listLogins, updateLogin } from '../../services/api/logins';
import { listOrganisms } from '../../services/api/organisms';
import { listSigintZones } from '../../services/api/zones';
import { PowerAlert } from '../../components/PowerAlert';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import { UserUuidValue } from './UserUuidValue';

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
  'NetworkEditor',
  'CallsignsEditor',
  'Cyber',
  'DeviceSource',
  'AdvancedReports',
  'DeleteMsg',
  'NoAutoLogout',
  'No2FA',
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
  id: true,
  roles: true,
  organism: true,
  zone: true,
  deltaLogin: true,
  createdAt: true,
  status: true,
  description: true,
};

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'login',
  'id',
  'roles',
  'organism',
  'zone',
  'deltaLogin',
  'createdAt',
  'status',
  'description',
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
  description: string;
};

type AddUserErrors = {
  login?: string;
  password?: string;
  roles?: string;
  zone?: string;
  organism?: string;
};

type EditUserForm = {
  id: string;
  login: string;
  password: string;
  roles: string[];
  sigintZoneId: number | null;
  organismId: number | null;
  deltaLogin: string;
  deleted: boolean;
  description: string;
  passwordAuthEnabled: boolean;
};

type EditUserErrors = {
  login?: string;
  roles?: string;
  zone?: string;
  organism?: string;
};

const EMPTY_ADD_FORM: AddUserForm = {
  login: '',
  password: '',
  roles: ['Rer'],
  sigintZoneId: null,
  organismId: null,
  useDelta: true,
  description: '',
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
    id: `loading-${index}`,
    login: `loading-${index}`,
    roles: [],
    deleted: false,
    deactivationReason: null,
    description: null,
    passwordAuthEnabled: true,
    totpEnabled: false,
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

function formatUuidShort(uuid: string): string {
  if (uuid.length <= 13) return uuid;
  return `${uuid.slice(0, 5)}...${uuid.slice(-5)}`;
}

function CopyUuidButton({ uuid, className }: { uuid: string; className?: string }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const copyLabel =
    copyStatus === 'copied'
      ? 'UUID скопійовано'
      : copyStatus === 'error'
        ? 'Не вдалося скопіювати UUID'
        : 'Копіювати UUID';

  return (
    <Tooltip title={copyLabel}>
      <IconButton
        className={className}
        size="small"
        aria-label={copyLabel}
        onClick={(event) => {
          event.stopPropagation();
          event.currentTarget.blur();
          void copyTextToClipboard(uuid)
            .then(() => setCopyStatus('copied'))
            .catch(() => setCopyStatus('error'));
        }}
        onBlur={() => setCopyStatus('idle')}
        onMouseLeave={() => setCopyStatus('idle')}
      >
        <ContentCopyIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
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

  if (!form.organismId) {
    errors.organism = 'Виберіть організм';
  }

  return errors;
}

function hasFormErrors(errors: AddUserErrors): boolean {
  return Object.values(errors).some(Boolean);
}

function toCreateLoginReq(form: AddUserForm): CreateLoginReq {
  if (!form.organismId) throw new Error('Виберіть організм');

  return {
    login: form.login.trim(),
    password: form.useDelta ? '' : form.password.trim(),
    roles: form.roles,
    sigintZoneId: form.sigintZoneId,
    organismId: form.organismId,
    description: form.description.trim() || null,
  };
}

function buildEditUserErrors(form: EditUserForm): EditUserErrors {
  const errors: EditUserErrors = {};

  if (!form.login.trim()) {
    errors.login = 'Логін не може бути пустим';
  }

  if (form.roles.length === 0) {
    errors.roles = 'Виберіть хочаб 1 роль';
  }

  if (!form.sigintZoneId) {
    errors.zone = 'Виберіть зону';
  }

  if (!form.organismId) {
    errors.organism = 'Виберіть організм';
  }

  return errors;
}

function toClearTotpReq(login: Login): UpdateLoginReq {
  if (!login.organismId) throw new Error('Виберіть організм');

  return {
    id: login.id,
    login: login.login,
    roles: login.roles,
    sigintZoneId: login.sigintZoneId,
    organismId: login.organismId,
    deleted: login.deleted,
    password: null,
    deltaLogin: login.deltaLogin,
    deactivationReason: login.deactivationReason,
    description: login.description,
    passwordAuthEnabled: login.passwordAuthEnabled,
    clearTotp: true,
  };
}

function toUpdateLoginReq(form: EditUserForm): UpdateLoginReq {
  if (!form.organismId) throw new Error('Виберіть організм');

  const trimmedPassword = form.password.trim();
  const trimmedDelta = form.deltaLogin.trim();
  const deactivationReason: DeactivationReasonType | null = form.deleted ? 'Admin' : null;

  return {
    id: form.id,
    login: form.login.trim(),
    roles: form.roles,
    sigintZoneId: form.sigintZoneId,
    organismId: form.organismId,
    deleted: form.deleted,
    password: trimmedPassword ? trimmedPassword : null,
    deltaLogin: trimmedDelta ? trimmedDelta : null,
    deactivationReason,
    description: form.description.trim() || null,
    passwordAuthEnabled: form.passwordAuthEnabled,
    clearTotp: null,
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

function useUsersColumns(): AppMrtColumnDef<Login>[] {
  return useMemo(
    () => [
      {
        header: 'Логін',
        accessorKey: 'login',
        meta: { overflowMode: 'custom', overflowOwner: 'shared-text', interactive: true },
        Cell: mrtCustomCell(({ row }) => (
          <MrtOverflowText
            displayValue={row.original.login}
            fullValue={row.original.login}
            interactive
            component="a"
            componentProps={{
              href: `/admin/users-neo/${encodeURIComponent(row.original.id)}`,
              onClick: (event: MouseEvent) => {
                if (
                  event.button === 0 &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.shiftKey &&
                  !event.altKey
                ) {
                  event.preventDefault();
                  window.history.pushState(
                    {},
                    '',
                    `/admin/users-neo/${encodeURIComponent(row.original.id)}`,
                  );
                  window.dispatchEvent(new PopStateEvent('popstate'));
                }
              },
            }}
          />
        )),
        size: 200,
      },
      {
        header: 'UUID',
        accessorKey: 'id',
        meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
        Cell: mrtCustomCell<Login>(({ row }) => (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              width: '100%',
              '& .uuid-copy-button': {
                opacity: 0,
                pointerEvents: 'none',
                transition: 'opacity 120ms ease',
              },
              '&:hover .uuid-copy-button, &:focus-within .uuid-copy-button': {
                opacity: 1,
                pointerEvents: 'auto',
              },
            }}
          >
            <UserUuidValue uuid={row.original.id} shortValue={formatUuidShort(row.original.id)} />
            <CopyUuidButton uuid={row.original.id} className="uuid-copy-button" />
          </Box>
        )),
        size: 190,
      },
      {
        header: 'Ролі',
        id: 'roles',
        accessorFn: (row) => row.roles,
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<Login, string>({
          items: ({ row }) => row.original.roles,
          renderItem: (role) => <EchoChip label={role} tone="neutral" />,
          measurementScope: 'admin-users:roles',
          getItemText: (role) => role,
        }),
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
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatOptionalLabel(row.original.organismName),
          fullValue: ({ row }) => formatOptionalLabel(row.original.organismName),
        }),
        size: 220,
      },
      {
        header: 'Напрямок',
        id: 'zone',
        accessorFn: (row) => formatOptionalLabel(row.sigintZoneName),
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatOptionalLabel(row.original.sigintZoneName),
          fullValue: ({ row }) => formatOptionalLabel(row.original.sigintZoneName),
        }),
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
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatDate(row.original.createdAt),
          fullValue: ({ row }) => formatDate(row.original.createdAt),
        }),
        size: 150,
      },
      {
        header: 'Статус',
        id: 'status',
        accessorFn: (row) => [getStatusInfo(row).label],
        meta: { overflowMode: 'wrap' },
        Cell: ({ row }) => {
          const status = getStatusInfo(row.original);
          return (
            <div className="flex flex-col items-center text-center leading-tight">
              <span className={status.colorClass}>{status.label}</span>
              {status.detail ? (
                <span className="text-xs text-muted-foreground">{status.detail}</span>
              ) : null}
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
      {
        header: 'Нотатка',
        id: 'description',
        accessorFn: (row) => formatOptionalLabel(row.description),
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatOptionalLabel(row.original.description),
          fullValue: ({ row }) => formatOptionalLabel(row.original.description),
        }),
        size: 260,
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
  const canSubmit = zonesReady && organismsReady && !isSubmitting;

  const zoneAutocompleteOptions: LookupAutocompleteOption[] = lookups.zones.map(
    ([zoneId, zone]) => ({
      id: zoneId,
      label: zone.name || `ID ${zoneId}`,
    }),
  );

  const organismAutocompleteOptions: LookupAutocompleteOption[] = lookups.organisms.map(
    (organism) => ({
      id: organism.id,
      label: organism.name || `ID ${organism.id}`,
    }),
  );

  useEffect(() => {
    if (!open || lookups.zones.length !== 1) return;
    const [zoneId] = lookups.zones[0];
    setForm((prev) => (prev.sigintZoneId === null ? { ...prev, sigintZoneId: zoneId } : prev));
  }, [open, lookups.zones]);

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
          <PowerAlert severity="error">{`Не вдалося завантажити зони: ${lookups.zonesError}`}</PowerAlert>
        ) : null}
        {lookups.organismsError ? (
          <PowerAlert severity="error">{`Не вдалося завантажити організми: ${lookups.organismsError}`}</PowerAlert>
        ) : null}
        {submitError ? <PowerAlert severity="error">{submitError}</PowerAlert> : null}

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
            renderOption={(props, option) =>
              renderLookupAutocompleteOption(props, option, 'add-zone')
            }
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
              setErrors((prev) => ({ ...prev, organism: undefined }));
            }}
            loading={organismsLoading}
            disabled={isSubmitting}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            getOptionLabel={(option) => option.label}
            className="md:col-span-2"
            renderOption={(props, option) =>
              renderLookupAutocompleteOption(props, option, 'add-organism')
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Організм"
                required
                error={Boolean(errors.organism)}
                helperText={errors.organism || ' '}
              />
            )}
          />

          <TextField
            label="Нотатка"
            value={form.description}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, description: event.target.value }));
            }}
            fullWidth
            multiline
            minRows={3}
            disabled={isSubmitting}
            className="md:col-span-2"
          />
        </div>
      </DialogContent>
      <DialogActions>
        <PowerButton onClick={handleClose} disabled={isSubmitting}>
          Скасувати
        </PowerButton>
        <PowerButton variant="contained" onClick={handleCreateUser} disabled={!canSubmit}>
          Додати
        </PowerButton>
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
  disableRestoreFocus?: boolean;
}) {
  const { open, login, onClose, onUserUpdated, lookups, disableRestoreFocus = false } = props;
  const [form, setForm] = useState<EditUserForm | null>(null);
  const [errors, setErrors] = useState<EditUserErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const zonesReady = lookups.zonesStatus === 'success';
  const zonesLoading = lookups.zonesStatus === 'loading';
  const organismsReady = lookups.organismsStatus === 'success';
  const organismsLoading = lookups.organismsStatus === 'loading';
  const canSubmit =
    (zonesReady || Boolean(form?.sigintZoneId)) &&
    (organismsReady || Boolean(form?.organismId)) &&
    !isSubmitting &&
    Boolean(form);

  const zoneAutocompleteOptions: LookupAutocompleteOption[] = lookups.zones.map(
    ([zoneId, zone]) => ({
      id: zoneId,
      label: zone.name || `ID ${zoneId}`,
    }),
  );

  const organismAutocompleteOptions: LookupAutocompleteOption[] = lookups.organisms.map(
    (organism) => ({
      id: organism.id,
      label: organism.name || `ID ${organism.id}`,
    }),
  );

  useEffect(() => {
    if (!open || !login) {
      setForm(null);
      setErrors({});
      setSubmitError(null);
      setIsSubmitting(false);
      return;
    }

    setForm({
      id: login.id,
      login: login.login,
      password: '',
      roles: login.roles ?? [],
      sigintZoneId: login.sigintZoneId ?? null,
      organismId: login.organismId ?? null,
      deltaLogin: login.deltaLogin ?? '',
      deleted: login.deleted,
      description: login.description ?? '',
      passwordAuthEnabled: login.passwordAuthEnabled,
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
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="lg"
      fullWidth
      disableRestoreFocus={disableRestoreFocus}
    >
      <DialogTitle>Редагувати користувача</DialogTitle>
      <DialogContent className="space-y-4">
        {lookups.zonesError ? (
          <PowerAlert severity="error">{`Не вдалося завантажити зони: ${lookups.zonesError}`}</PowerAlert>
        ) : null}
        {lookups.organismsError ? (
          <PowerAlert severity="error">{`Не вдалося завантажити організми: ${lookups.organismsError}`}</PowerAlert>
        ) : null}
        {submitError ? <PowerAlert severity="error">{submitError}</PowerAlert> : null}

        {form ? (
          <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-6">
            <TextField
              label="UUID"
              value={form.id}
              helperText="Ідентифікатор користувача"
              fullWidth
              className="xl:col-span-3"
              InputProps={{
                readOnly: true,
                endAdornment: (
                  <InputAdornment position="end">
                    <CopyUuidButton uuid={form.id} />
                  </InputAdornment>
                ),
              }}
            />
            <div aria-hidden className="hidden md:block xl:col-span-3" />

            <TextField
              label="Логін"
              value={form.login}
              onChange={(event) => {
                setForm((prev) => (prev ? { ...prev, login: event.target.value } : prev));
                setErrors((prev) => ({ ...prev, login: undefined }));
              }}
              fullWidth
              error={Boolean(errors.login)}
              helperText={errors.login || ' '}
              disabled={isSubmitting}
              className="xl:col-span-3"
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
              className="xl:col-span-3"
            />

            <TextField
              select
              label="Ролі"
              value={form.roles}
              onChange={(event) => {
                setForm((prev) =>
                  prev ? { ...prev, roles: asStringArray(event.target.value) } : prev,
                );
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
              className="xl:col-span-3"
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
              className="xl:col-span-3"
              renderOption={(props, option) =>
                renderLookupAutocompleteOption(props, option, 'edit-zone')
              }
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
                setErrors((prev) => ({ ...prev, organism: undefined }));
              }}
              loading={organismsLoading}
              disabled={isSubmitting}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              getOptionLabel={(option) => option.label}
              className="xl:col-span-2"
              renderOption={(props, option) =>
                renderLookupAutocompleteOption(props, option, 'edit-organism')
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Організм"
                  required
                  error={Boolean(errors.organism)}
                  helperText={errors.organism || ' '}
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
                    checked={form.passwordAuthEnabled}
                    onChange={(event) => {
                      setForm((prev) =>
                        prev ? { ...prev, passwordAuthEnabled: event.target.checked } : prev,
                      );
                    }}
                  />
                }
                label="Вхід по паролю"
              />
            </div>

            <div className="flex flex-wrap items-center gap-3 xl:col-span-2">
              <Typography variant="body2">
                2FA: {login?.totpEnabled ? 'увімкнено' : 'вимкнено'}
              </Typography>
              {login?.totpEnabled ? (
                <Button
                  variant="outlined"
                  color="warning"
                  disabled={isSubmitting}
                  onClick={() => {
                    void (async () => {
                      if (!login) return;
                      setIsSubmitting(true);
                      setSubmitError(null);
                      try {
                        const updated = await updateLogin(toClearTotpReq(login));
                        onUserUpdated(updated);
                        onClose();
                      } catch (error) {
                        setSubmitError(
                          error instanceof Error && error.message
                            ? error.message
                            : 'Не вдалося скинути 2FA',
                        );
                      } finally {
                        setIsSubmitting(false);
                      }
                    })();
                  }}
                >
                  Скинути 2FA
                </Button>
              ) : null}
            </div>

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

            <TextField
              label="Нотатка"
              value={form.description}
              onChange={(event) => {
                setForm((prev) => (prev ? { ...prev, description: event.target.value } : prev));
              }}
              fullWidth
              multiline
              minRows={3}
              disabled={isSubmitting}
              className="xl:col-span-6"
            />
          </div>
        ) : null}
      </DialogContent>
      <DialogActions>
        <PowerButton onClick={handleClose} disabled={isSubmitting}>
          Скасувати
        </PowerButton>
        <PowerButton variant="contained" onClick={handleSave} disabled={!canSubmit}>
          Зберегти
        </PowerButton>
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
      opensModal
    />
  );
}

function UsersTable(props: { data: Login[]; loading: boolean; onEdit: (login: Login) => void }) {
  const tableStateContext = useTableStateContext();
  const columns = useUsersColumns();
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
    data: props.loading ? buildUserLoadingRows() : props.data,
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
      debugLog('loadOrganisms:success', {
        count: organismList.length,
        sample: organismList.slice(0, 3),
      });
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
            <UsersTable data={logins} loading onEdit={(login) => setEditingLogin(login)} />
          </div>
        }
      >
        <div className="flex w-full min-w-0 flex-1 min-h-0">
          <UsersTable data={logins} loading={false} onEdit={(login) => setEditingLogin(login)} />
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
        <TablePageToolbar
          title="Користувачі"
          withGlobalTextFilter
          hideGlobalTextFilter={status !== 'success'}
          internalActionsDisabled={status !== 'success'}
          actions={
            <div className="flex gap-3">
              <PowerButton variant="contained" onClick={() => setCreateOpen(true)}>
                Додати користувача
              </PowerButton>
            </div>
          }
        />

        <Box sx={{ flex: 1, minHeight: { xs: 'auto', lg: 0 }, minWidth: 0, display: 'flex' }}>
          {renderTable()}
        </Box>

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
            setLogins((prev) => prev.map((item) => (item.id === login.id ? login : item)))
          }
          lookups={lookups}
          disableRestoreFocus
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
