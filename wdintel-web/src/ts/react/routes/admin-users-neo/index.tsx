import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EditIcon from '@mui/icons-material/Edit';
import LockResetIcon from '@mui/icons-material/LockReset';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import {
  Autocomplete,
  Box,
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
  Switch,
  TextField,
  Tooltip,
} from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  CreateLoginReq,
  DeactivationReasonType,
  Login,
  Organism,
  SigintZone,
} from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
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
import {
  createLogin,
  listLogins,
  type UpdateLoginPatch,
  updateLogin,
} from '../../services/api/logins';
import { listOrganisms } from '../../services/api/organisms';
import { listSigintZones } from '../../services/api/zones';
import { PowerAlert } from '../../components/PowerAlert';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import { MessengerProfileSelect } from './MessengerProfileSelect';
import { UserUuidValue } from './UserUuidValue';
import { ApiSenders } from './ApiSenders';

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
  'CyberViewer',
  'CyberViewerRestricted',
  'AdvancedReports',
  'DeleteMsg',
  'NoAutoLogout',
  'No2FA',
  'MessengerIngest',
  'CyberMessengers',
];

const STATUS_FILTER_OPTIONS = [
  { text: 'Активний', value: 'Активний' },
  { text: 'Деактивовано адміністратором', value: 'Деактивовано адміністратором' },
  { text: 'Деактивовано через неактивність', value: 'Деактивовано через неактивність' },
  { text: 'Організм деактивовано', value: 'Організм деактивовано' },
  { text: 'Деактивовано', value: 'Деактивовано' },
];

const LEGACY_STATUS_FILTER_VALUES: Record<string, string> = {
  'Видалено адміном': 'Деактивовано адміністратором',
  Неактивний: 'Деактивовано через неактивність',
  Невідомо: 'Деактивовано',
};

const DEFAULT_COLUMNS_VISIBILITY = {
  login: true,
  id: false,
  roles: true,
  organism: true,
  zone: false,
  deltaLogin: false,
  createdAt: true,
  status: true,
  description: false,
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
  details?: string[];
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
  deltaLogin: string;
  password: string;
  passwordAuthEnabled: boolean;
  roles: string[];
  sigintZoneId: number | null;
  organismId: number | null;
  signalProfileId: string | null;
  description: string;
};

type AddUserErrors = {
  login?: string;
  deltaLogin?: string;
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
  signalProfileId: string | null;
  description: string;
  passwordAuthEnabled: boolean;
  hasPassword: boolean;
};

type EditUserErrors = {
  login?: string;
  password?: string;
  deltaLogin?: string;
  roles?: string;
  zone?: string;
  organism?: string;
};

type UserField = keyof AddUserErrors;
type UserFieldState = Partial<Record<UserField, true>>;
type UserServerErrors = AddUserErrors & { passwordAuthEnabled?: string };
type ParsedServerFieldErrors = {
  fields: UserServerErrors;
  fallbackMessages: string[];
  hasDiscardedEntries: boolean;
  isJson: boolean;
};

const EMPTY_ADD_FORM: AddUserForm = {
  login: '',
  deltaLogin: '',
  password: '',
  passwordAuthEnabled: false,
  roles: ['Rer'],
  sigintZoneId: null,
  organismId: null,
  description: '',
  signalProfileId: null,
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
    signalProfileId: null,
    description: null,
    passwordAuthEnabled: true,
    hasPassword: false,
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

  if (form.passwordAuthEnabled && !form.password.trim()) {
    errors.password = 'Пароль не може бути пустим або складатися лише з пробілів';
  }

  if (!form.passwordAuthEnabled && !form.deltaLogin.trim()) {
    errors.deltaLogin = 'Вкажіть Delta логін або увімкніть вхід за паролем';
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

function hasFormErrors(errors: AddUserErrors | EditUserErrors): boolean {
  return Object.values(errors).some(Boolean);
}

function visibleFieldError(
  field: UserField,
  validationErrors: AddUserErrors | EditUserErrors,
  serverErrors: AddUserErrors | EditUserErrors,
  touched: UserFieldState,
  submitAttempted: boolean,
): string | undefined {
  if (serverErrors[field]) return serverErrors[field];
  return submitAttempted || touched[field] ? validationErrors[field] : undefined;
}

function parseServerFieldErrors(error: unknown): ParsedServerFieldErrors {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  if (!message)
    return { fields: {}, fallbackMessages: [], hasDiscardedEntries: true, isJson: false };

  try {
    const value = JSON.parse(message) as Record<string, unknown>;
    const wrappedFields =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value.fields ?? value.fieldErrors ?? value.field_errors ?? value.errors)
        : undefined;
    const entries: unknown[] = Array.isArray(value)
      ? value
      : wrappedFields && typeof wrappedFields === 'object' && !Array.isArray(wrappedFields)
        ? Object.entries(wrappedFields)
        : [];
    if (entries.length === 0) {
      return { fields: {}, fallbackMessages: [], hasDiscardedEntries: true, isJson: true };
    }

    const fields: UserServerErrors = {};
    const fallbackMessages: string[] = [];
    let hasDiscardedEntries = false;
    const fieldByBackendKey: Record<string, keyof UserServerErrors> = {
      login: 'login',
      deltaLogin: 'deltaLogin',
      delta_login: 'deltaLogin',
      password: 'password',
      roles: 'roles',
      zone: 'zone',
      sigintZoneId: 'zone',
      sigint_zone_id: 'zone',
      organism: 'organism',
      organismId: 'organism',
      organism_id: 'organism',
      passwordAuthEnabled: 'passwordAuthEnabled',
      password_auth_enabled: 'passwordAuthEnabled',
    };
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        hasDiscardedEntries = true;
        continue;
      }
      const [key, value] = entry;
      if (typeof key !== 'string' || !key.trim() || typeof value !== 'string' || !value.trim()) {
        hasDiscardedEntries = true;
        continue;
      }
      const field = fieldByBackendKey[key];
      if (field) {
        fields[field] ??= value;
      } else {
        fallbackMessages.push(`${key}: ${value}`);
      }
    }
    return { fields, fallbackMessages, hasDiscardedEntries, isJson: true };
  } catch (_) {
    return { fields: {}, fallbackMessages: [], hasDiscardedEntries: true, isJson: false };
  }
}

function formatServerValidationFallback(
  error: unknown,
  parsedErrors: ParsedServerFieldErrors,
): string {
  if (!parsedErrors.isJson) {
    const message = formatErrorMessage(error);
    return /^[\[{]/.test(message.trim()) ? 'Не вдалося зберегти користувача' : message;
  }
  const messages = [...parsedErrors.fallbackMessages];
  if (
    parsedErrors.hasDiscardedEntries ||
    (messages.length === 0 && Object.keys(parsedErrors.fields).length === 0)
  ) {
    messages.push('Не вдалося зберегти користувача');
  }
  return messages.join('\n');
}

function clearAuthenticationGroupServerError(
  current: UserServerErrors,
  field: 'deltaLogin' | 'password',
): UserServerErrors {
  if (!current[field] && !current.passwordAuthEnabled) return current;
  return { ...current, [field]: undefined, passwordAuthEnabled: undefined };
}

function clearAuthenticationServerErrors(current: UserServerErrors): UserServerErrors {
  if (!current.password && !current.deltaLogin && !current.passwordAuthEnabled) return current;
  return {
    ...current,
    password: undefined,
    deltaLogin: undefined,
    passwordAuthEnabled: undefined,
  };
}

function toCreateLoginReq(form: AddUserForm): CreateLoginReq {
  if (!form.organismId) throw new Error('Виберіть організм');

  return {
    login: form.login.trim(),
    password: form.passwordAuthEnabled ? form.password : null,
    roles: form.roles,
    sigintZoneId: form.sigintZoneId,
    organismId: form.organismId,
    signalProfileId: form.signalProfileId,
    description: form.description.trim() || null,
    deltaLogin: form.deltaLogin.trim() || null,
    passwordAuthEnabled: form.passwordAuthEnabled,
  };
}

function buildEditUserErrors(form: EditUserForm, original: Login): EditUserErrors {
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

  const passwordWasSupplied = form.password.length > 0;
  const hasValidReplacementPassword = passwordWasSupplied && Boolean(form.password.trim());
  if (passwordWasSupplied && !hasValidReplacementPassword) {
    errors.password = 'Пароль не може бути пустим або складатися лише з пробілів';
  }

  if (
    !original.passwordAuthEnabled &&
    form.passwordAuthEnabled &&
    !form.hasPassword &&
    !passwordWasSupplied &&
    !hasValidReplacementPassword
  ) {
    errors.password = 'Для входу за паролем вкажіть пароль';
  }

  const deltaChanged = form.deltaLogin.trim() !== (original.deltaLogin ?? '').trim();
  const authenticationChanged =
    deltaChanged ||
    form.passwordAuthEnabled !== original.passwordAuthEnabled ||
    passwordWasSupplied;
  const reactivating = original.deleted && !form.deleted;
  if (
    (authenticationChanged || reactivating) &&
    !form.deleted &&
    !(
      form.deltaLogin.trim() ||
      (form.passwordAuthEnabled && (form.hasPassword || hasValidReplacementPassword))
    )
  ) {
    errors.deltaLogin = 'Для активного користувача налаштуйте вхід за паролем або Delta';
  }

  return errors;
}

function toClearTotpReq(login: Login): UpdateLoginPatch {
  if (!login.organismId) throw new Error('Виберіть організм');

  return {
    id: login.id,
    login: login.login,
    organismId: login.organismId,
    clearTotp: true,
  };
}

function toUpdateLoginReq(form: EditUserForm, original: Login): UpdateLoginPatch {
  if (!form.organismId) throw new Error('Виберіть організм');

  const trimmedDelta = form.deltaLogin.trim();

  return {
    id: form.id,
    login: form.login.trim(),
    roles: form.roles,
    sigintZoneId: form.sigintZoneId,
    organismId: form.organismId,
    ...(form.deleted === original.deleted ? {} : { deleted: form.deleted }),
    password: form.password || null,
    ...(trimmedDelta === (original.deltaLogin ?? '').trim()
      ? {}
      : { deltaLogin: trimmedDelta || null }),
    ...(form.signalProfileId === original.signalProfileId
      ? {}
      : { signalProfileId: form.signalProfileId }),
    description: form.description.trim() || null,
    ...(form.passwordAuthEnabled === original.passwordAuthEnabled
      ? {}
      : { passwordAuthEnabled: form.passwordAuthEnabled }),
  };
}

function getStatusInfo(login: Login): StatusInfo {
  if (login.deleted) {
    if (login.deactivationReason === 'Admin') {
      return {
        label: 'Деактивовано адміністратором',
        colorClass: 'text-red-600',
        details: login.organismEnabled === false ? ['Організм деактивовано'] : undefined,
      };
    }
    if (login.deactivationReason === 'Inactive') {
      return {
        label: 'Деактивовано через неактивність',
        colorClass: 'text-yellow-600',
        details: [
          ...(login.lastActiveAt ? [`Останній: ${formatDateTime(login.lastActiveAt)}`] : []),
          ...(login.organismEnabled === false ? ['Організм деактивовано'] : []),
        ],
      };
    }
    return {
      label: 'Деактивовано',
      colorClass: 'text-gray-600',
      details: login.organismEnabled === false ? ['Організм деактивовано'] : undefined,
    };
  }

  if (login.organismEnabled === false) {
    return { label: 'Організм деактивовано', colorClass: 'text-red-600' };
  }

  return { label: 'Активний', colorClass: 'text-green-600' };
}

function matchesStatusFilter(login: Login, filterValue: unknown): boolean {
  const selected = asStringArray(filterValue).map(
    (value) => LEGACY_STATUS_FILTER_VALUES[value] ?? value,
  );
  return selected.length === 0 || selected.includes(getStatusInfo(login).label);
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
            <div className="admin-user-status flex min-w-0 max-w-full flex-col items-center text-center leading-tight">
              <span className={`${status.colorClass} max-w-full whitespace-normal break-words`}>
                {status.label}
              </span>
              {status.details?.map((detail) => (
                <span
                  key={detail}
                  className="max-w-full whitespace-normal break-words text-xs text-muted-foreground"
                >
                  {detail}
                </span>
              ))}
            </div>
          );
        },
        filterVariant: 'multi-select',
        filterSelectOptions: STATUS_FILTER_OPTIONS,
        filterFn: (row, _columnId, filterValue) => matchesStatusFilter(row.original, filterValue),
        enableSorting: false,
        size: 200,
        muiTableBodyCellProps: () => ({
          sx: {
            ...CUSTOM_CELL_STYLES,
            justifyContent: 'center',
            minWidth: 0,
            whiteSpace: 'normal',
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

export function AddUserDialog(props: {
  open: boolean;
  onClose: () => void;
  onUserCreated: (login: Login) => void;
  lookups: UserLookups;
}) {
  const { open, onClose, onUserCreated, lookups } = props;
  const [form, setForm] = useState<AddUserForm>(EMPTY_ADD_FORM);
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState<UserFieldState>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<UserServerErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const focusInvalidField = useRef(false);

  const zonesReady = lookups.zonesStatus === 'success';
  const zonesLoading = lookups.zonesStatus === 'loading';
  const organismsReady = lookups.organismsStatus === 'success';
  const organismsLoading = lookups.organismsStatus === 'loading';
  const validationErrors = buildAddUserErrors(form);
  const canSubmit =
    zonesReady && organismsReady && !isSubmitting && !hasFormErrors(validationErrors);

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
    if (!open || lookups.organisms.length !== 1) return;
    const [organism] = lookups.organisms;
    setForm((prev) => (prev.organismId === null ? { ...prev, organismId: organism.id } : prev));
  }, [open, lookups.organisms]);

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
    setShowPassword(false);
    setTouched({});
    setSubmitAttempted(false);
    setServerErrors({});
    setSubmitError(null);
    setIsSubmitting(false);
  }, [open]);

  useEffect(() => {
    if (!focusInvalidField.current) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    focusInvalidField.current = false;
  }, [submitAttempted, validationErrors]);

  function touch(field: UserField) {
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));
  }

  function changeServerField(field: UserField) {
    setServerErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  }

  function fieldError(field: UserField) {
    return visibleFieldError(field, validationErrors, serverErrors, touched, submitAttempted);
  }

  function handleClose() {
    if (isSubmitting) return;
    onClose();
  }

  async function handleCreateUser() {
    if (isSubmitting || !zonesReady || !organismsReady) return;
    const nextErrors = buildAddUserErrors(form);
    setSubmitAttempted(true);
    if (hasFormErrors(nextErrors)) {
      focusInvalidField.current = true;
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const payload = toCreateLoginReq(form);
      const created = await createLogin(payload);
      onUserCreated(created);
      setForm(EMPTY_ADD_FORM);
      setTouched({});
      setSubmitAttempted(false);
      setServerErrors({});
      onClose();
    } catch (err) {
      const parsedErrors = parseServerFieldErrors(err);
      setServerErrors(parsedErrors.fields);
      setSubmitError(formatServerValidationFallback(err, parsedErrors));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth={false}
      fullWidth
      slotProps={{
        paper: {
          sx: { width: 'calc(100% - 32px)', maxWidth: '768px', m: 2 },
          component: 'form',
          ...{ noValidate: true },
          onSubmit: (event) => {
            event.preventDefault();
            void handleCreateUser();
          },
        },
      }}
    >
      <DialogTitle>Додати користувача</DialogTitle>
      <DialogContent className="space-y-3 py-3">
        {lookups.zonesError ? (
          <PowerAlert severity="error">{`Не вдалося завантажити зони: ${lookups.zonesError}`}</PowerAlert>
        ) : null}
        {lookups.organismsError ? (
          <PowerAlert severity="error">{`Не вдалося завантажити організми: ${lookups.organismsError}`}</PowerAlert>
        ) : null}
        {submitError ? <PowerAlert severity="error">{submitError}</PowerAlert> : null}

        <div ref={formRef} className="grid gap-3 md:grid-cols-2">
          <TextField
            label="Delta логін"
            value={form.deltaLogin}
            onChange={(event) => {
              const deltaLogin = event.target.value;
              setForm((prev) => ({ ...prev, deltaLogin, login: deltaLogin }));
              setServerErrors((current) => ({
                ...clearAuthenticationGroupServerError(current, 'deltaLogin'),
                login: undefined,
              }));
            }}
            onBlur={() => touch('deltaLogin')}
            required={!form.passwordAuthEnabled}
            error={Boolean(fieldError('deltaLogin'))}
            helperText={fieldError('deltaLogin')}
            fullWidth
            disabled={isSubmitting}
            autoFocus
          />

          <TextField
            label="Логін"
            value={form.login}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, login: event.target.value }));
              changeServerField('login');
            }}
            onBlur={() => touch('login')}
            required
            error={Boolean(fieldError('login'))}
            helperText={fieldError('login')}
            fullWidth
            disabled={isSubmitting}
          />

          <div className="md:col-span-2">
            <FormControlLabel
              control={
                <Switch
                  checked={form.passwordAuthEnabled}
                  onChange={(event) => {
                    setForm((prev) => ({
                      ...prev,
                      passwordAuthEnabled: event.target.checked,
                      password: event.target.checked ? prev.password : '',
                    }));
                    setShowPassword(false);
                    setServerErrors(clearAuthenticationServerErrors);
                  }}
                  disabled={isSubmitting}
                  inputProps={
                    serverErrors.passwordAuthEnabled
                      ? { 'aria-describedby': 'add-password-authentication-error' }
                      : undefined
                  }
                />
              }
              label="Вхід за паролем"
            />
            {serverErrors.passwordAuthEnabled ? (
              <p id="add-password-authentication-error" className="text-xs text-error" role="alert">
                {serverErrors.passwordAuthEnabled}
              </p>
            ) : null}
          </div>

          {form.passwordAuthEnabled ? (
            <TextField
              label="Пароль"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={form.password}
              onChange={(event) => {
                setForm((prev) => ({ ...prev, password: event.target.value }));
                setServerErrors((current) =>
                  clearAuthenticationGroupServerError(current, 'password'),
                );
              }}
              onBlur={() => touch('password')}
              required
              error={Boolean(fieldError('password'))}
              helperText={fieldError('password')}
              fullWidth
              disabled={isSubmitting}
              className="md:col-span-2"
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      type="button"
                      aria-label={showPassword ? 'Приховати пароль' : 'Показати пароль'}
                      onClick={() => setShowPassword((prev) => !prev)}
                      onMouseDown={(event) => event.preventDefault()}
                      edge="end"
                      disabled={isSubmitting}
                    >
                      {showPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
          ) : null}

          <Autocomplete
            options={organismAutocompleteOptions}
            value={organismAutocompleteOptions.find((opt) => opt.id === form.organismId) || null}
            onChange={(_, newValue) => {
              const value = newValue?.id ?? null;
              debugLog('add:organism change', { newValue, parsed: value });
              setForm((prev) => ({ ...prev, organismId: value }));
              changeServerField('organism');
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
                onBlur={() => touch('organism')}
                error={Boolean(fieldError('organism'))}
                helperText={fieldError('organism')}
              />
            )}
          />

          <TextField
            select
            label="Ролі"
            value={form.roles}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, roles: asStringArray(event.target.value) }));
              changeServerField('roles');
            }}
            onBlur={() => touch('roles')}
            required
            fullWidth
            SelectProps={{
              multiple: true,
              renderValue: (selected) => (selected as string[]).join(', ') || '—',
            }}
            error={Boolean(fieldError('roles'))}
            helperText={fieldError('roles')}
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
              changeServerField('zone');
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
                required
                onBlur={() => touch('zone')}
                error={Boolean(fieldError('zone'))}
                helperText={fieldError('zone')}
              />
            )}
          />

          <MessengerProfileSelect
            value={form.signalProfileId}
            onChange={(signalProfileId) => setForm((prev) => ({ ...prev, signalProfileId }))}
            disabled={isSubmitting}
          />
          <TextField
            label="Нотатка"
            value={form.description}
            onChange={(event) => {
              setForm((prev) => ({ ...prev, description: event.target.value }));
            }}
            fullWidth
            multiline
            minRows={2}
            disabled={isSubmitting}
            className="md:col-span-2"
          />
        </div>
      </DialogContent>
      <DialogActions>
        <PowerButton type="button" onClick={handleClose} disabled={isSubmitting}>
          Скасувати
        </PowerButton>
        <PowerButton variant="contained" type="submit" disabled={!canSubmit}>
          Додати
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

export function EditUserDialog(props: {
  open: boolean;
  login: Login | null;
  onClose: () => void;
  onUserUpdated: (login: Login) => void;
  lookups: UserLookups;
  disableRestoreFocus?: boolean;
}) {
  const { open, login, onClose, onUserUpdated, lookups, disableRestoreFocus = false } = props;
  const [form, setForm] = useState<EditUserForm | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState<UserFieldState>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<UserServerErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const focusInvalidField = useRef(false);

  const zonesReady = lookups.zonesStatus === 'success';
  const zonesLoading = lookups.zonesStatus === 'loading';
  const organismsReady = lookups.organismsStatus === 'success';
  const organismsLoading = lookups.organismsStatus === 'loading';
  const validationErrors = form && login ? buildEditUserErrors(form, login) : {};
  const canSubmit =
    (zonesReady || Boolean(form?.sigintZoneId)) &&
    (organismsReady || Boolean(form?.organismId)) &&
    !isSubmitting &&
    Boolean(form) &&
    !hasFormErrors(validationErrors);
  const deltaLoginRequired = Boolean(
    form &&
    login &&
    !form.deleted &&
    !form.passwordAuthEnabled &&
    (form.deltaLogin.trim() !== (login.deltaLogin ?? '').trim() ||
      form.passwordAuthEnabled !== login.passwordAuthEnabled ||
      form.password.length > 0 ||
      (login.deleted && !form.deleted)),
  );
  const passwordRequired = Boolean(
    form && login && !login.passwordAuthEnabled && form.passwordAuthEnabled && !form.hasPassword,
  );

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
  const selectedOrganismEnabled =
    lookups.organisms.find((organism) => organism.id === form?.organismId)?.enabled ??
    (form?.organismId === login?.organismId ? login?.organismEnabled : undefined);

  useEffect(() => {
    if (!open || !login) {
      setForm(null);
      setTouched({});
      setSubmitAttempted(false);
      setServerErrors({});
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
      signalProfileId: login.signalProfileId,
      description: login.description ?? '',
      passwordAuthEnabled: login.passwordAuthEnabled,
      hasPassword: login.hasPassword,
    });
    setTouched({});
    setSubmitAttempted(false);
    setServerErrors({});
    setShowPassword(false);
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

  useEffect(() => {
    if (!focusInvalidField.current) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    focusInvalidField.current = false;
  }, [submitAttempted, validationErrors]);

  function touch(field: UserField) {
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));
  }

  function changeServerField(field: UserField) {
    setServerErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  }

  function fieldError(field: UserField) {
    return visibleFieldError(field, validationErrors, serverErrors, touched, submitAttempted);
  }

  function handleClose() {
    if (isSubmitting) return;
    onClose();
  }

  async function handleSave() {
    if (
      !form ||
      isSubmitting ||
      !(zonesReady || Boolean(form.sigintZoneId)) ||
      !(organismsReady || Boolean(form.organismId))
    ) {
      return;
    }
    const nextErrors = buildEditUserErrors(form, login!);
    setSubmitAttempted(true);
    if (hasFormErrors(nextErrors)) {
      focusInvalidField.current = true;
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const updated = await updateLogin(toUpdateLoginReq(form, login!));
      onUserUpdated(updated);
      onClose();
    } catch (err) {
      const parsedErrors = parseServerFieldErrors(err);
      setServerErrors(parsedErrors.fields);
      setSubmitError(formatServerValidationFallback(err, parsedErrors));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth={false}
      fullWidth
      disableRestoreFocus={disableRestoreFocus}
      slotProps={{
        paper: {
          sx: { width: 'calc(100% - 32px)', maxWidth: '768px', m: 2 },
          component: 'form',
          ...{ noValidate: true },
          onSubmit: (event) => {
            event.preventDefault();
            void handleSave();
          },
        },
      }}
    >
      <DialogTitle>Редагувати користувача</DialogTitle>
      <DialogContent className="space-y-3 py-3">
        {lookups.zonesError ? (
          <PowerAlert severity="error">{`Не вдалося завантажити зони: ${lookups.zonesError}`}</PowerAlert>
        ) : null}
        {lookups.organismsError ? (
          <PowerAlert severity="error">{`Не вдалося завантажити організми: ${lookups.organismsError}`}</PowerAlert>
        ) : null}
        {submitError ? <PowerAlert severity="error">{submitError}</PowerAlert> : null}

        {form ? (
          <div ref={formRef} className="grid gap-3 md:grid-cols-2">
            <div className="flex min-w-0 items-center gap-2 text-echo-sm text-muted-foreground md:col-span-2">
              <span>UUID:</span>
              <UserUuidValue uuid={form.id} shortValue={formatUuidShort(form.id)} />
              <CopyUuidButton uuid={form.id} />
            </div>

            <TextField
              label="Логін"
              value={form.login}
              onChange={(event) => {
                setForm((prev) => (prev ? { ...prev, login: event.target.value } : prev));
                changeServerField('login');
              }}
              onBlur={() => touch('login')}
              required
              fullWidth
              error={Boolean(fieldError('login'))}
              helperText={fieldError('login')}
              disabled={isSubmitting}
              autoFocus
            />

            <TextField
              label="Delta логін"
              value={form.deltaLogin}
              onChange={(event) => {
                setForm((prev) => (prev ? { ...prev, deltaLogin: event.target.value } : prev));
                setServerErrors((current) =>
                  clearAuthenticationGroupServerError(current, 'deltaLogin'),
                );
              }}
              onBlur={() => touch('deltaLogin')}
              required={deltaLoginRequired}
              error={Boolean(fieldError('deltaLogin'))}
              helperText={fieldError('deltaLogin')}
              fullWidth
              disabled={isSubmitting}
            />

            <div className="flex items-center md:col-span-2">
              <FormControlLabel
                control={
                  <Switch
                    checked={form.passwordAuthEnabled}
                    onChange={(event) => {
                      setForm((prev) => {
                        if (!prev) return prev;
                        return {
                          ...prev,
                          passwordAuthEnabled: event.target.checked,
                          password: event.target.checked ? prev.password : '',
                        };
                      });
                      setShowPassword(false);
                      setServerErrors(clearAuthenticationServerErrors);
                    }}
                    disabled={isSubmitting}
                    inputProps={
                      serverErrors.passwordAuthEnabled
                        ? {
                            'aria-describedby': `edit-password-authentication-error-${form.id}`,
                          }
                        : undefined
                    }
                  />
                }
                label="Вхід за паролем"
              />
              {serverErrors.passwordAuthEnabled ? (
                <p
                  id={`edit-password-authentication-error-${form.id}`}
                  className="text-xs text-error"
                  role="alert"
                >
                  {serverErrors.passwordAuthEnabled}
                </p>
              ) : null}
            </div>

            {form.passwordAuthEnabled ? (
              <TextField
                label="Новий пароль"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={form.password}
                onChange={(event) => {
                  setForm((prev) => (prev ? { ...prev, password: event.target.value } : prev));
                  setServerErrors((current) =>
                    clearAuthenticationGroupServerError(current, 'password'),
                  );
                }}
                onBlur={() => touch('password')}
                required={passwordRequired}
                helperText={fieldError('password') || 'Залиште порожнім, щоб не змінювати'}
                error={Boolean(fieldError('password'))}
                fullWidth
                disabled={isSubmitting || !form.passwordAuthEnabled}
                className="md:col-span-2"
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        type="button"
                        aria-label={showPassword ? 'Приховати пароль' : 'Показати пароль'}
                        onClick={() => setShowPassword((prev) => !prev)}
                        onMouseDown={(event) => event.preventDefault()}
                        edge="end"
                        disabled={isSubmitting || !form.passwordAuthEnabled}
                      >
                        {showPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
            ) : null}

            <Autocomplete
              options={organismAutocompleteOptions}
              value={organismAutocompleteOptions.find((opt) => opt.id === form.organismId) || null}
              onChange={(_, newValue) => {
                const value = newValue?.id ?? null;
                debugLog('edit:organism change', { newValue, parsed: value });
                setForm((prev) => (prev ? { ...prev, organismId: value } : prev));
                changeServerField('organism');
              }}
              loading={organismsLoading}
              disabled={isSubmitting}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              getOptionLabel={(option) => option.label}
              className="md:col-span-2"
              renderOption={(props, option) =>
                renderLookupAutocompleteOption(props, option, 'edit-organism')
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Організм"
                  required
                  onBlur={() => touch('organism')}
                  error={Boolean(fieldError('organism'))}
                  helperText={fieldError('organism')}
                />
              )}
            />

            <TextField
              select
              label="Ролі"
              value={form.roles}
              onChange={(event) => {
                setForm((prev) =>
                  prev ? { ...prev, roles: asStringArray(event.target.value) } : prev,
                );
                changeServerField('roles');
              }}
              onBlur={() => touch('roles')}
              required
              fullWidth
              SelectProps={{
                multiple: true,
                renderValue: (selected) => (selected as string[]).join(', ') || '—',
              }}
              error={Boolean(fieldError('roles'))}
              helperText={fieldError('roles')}
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
                debugLog('edit:zone change', { newValue, parsed: value });
                setForm((prev) => (prev ? { ...prev, sigintZoneId: value } : prev));
                changeServerField('zone');
              }}
              loading={zonesLoading}
              disabled={isSubmitting}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              getOptionLabel={(option) => option.label}
              renderOption={(props, option) =>
                renderLookupAutocompleteOption(props, option, 'edit-zone')
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Зона"
                  required
                  onBlur={() => touch('zone')}
                  error={Boolean(fieldError('zone'))}
                  helperText={fieldError('zone')}
                />
              )}
            />

            <MessengerProfileSelect
              value={form.signalProfileId}
              onChange={(signalProfileId) =>
                setForm((prev) => (prev ? { ...prev, signalProfileId } : prev))
              }
              disabled={isSubmitting}
            />

            <div className="md:col-span-2">
              <FormControlLabel
                control={
                  <Switch
                    checked={!form.deleted}
                    onChange={(event) => {
                      setForm((prev) =>
                        prev ? { ...prev, deleted: !event.target.checked } : prev,
                      );
                    }}
                    disabled={isSubmitting}
                    inputProps={{ 'aria-describedby': `active-helper-${form.id}` }}
                  />
                }
                label="Активний"
              />
              <p id={`active-helper-${form.id}`} className="text-xs text-muted-foreground">
                Вимкнення блокує доступ після збереження.
              </p>
              {selectedOrganismEnabled === false ? (
                <PowerAlert className="mt-2" severity="warning">
                  Організм деактивовано, тому доступ користувача заблоковано незалежно від стану
                  облікового запису.
                </PowerAlert>
              ) : null}
            </div>

            <TextField
              label="Нотатка"
              value={form.description}
              onChange={(event) => {
                setForm((prev) => (prev ? { ...prev, description: event.target.value } : prev));
              }}
              fullWidth
              multiline
              minRows={2}
              disabled={isSubmitting}
              className="md:col-span-2"
            />
            {login?.roles.includes('Api') ? (
              <ApiSenders apiId={login.id} disabled={isSubmitting} />
            ) : null}
          </div>
        ) : null}
      </DialogContent>
      <DialogActions>
        <PowerButton type="button" onClick={handleClose} disabled={isSubmitting}>
          Скасувати
        </PowerButton>
        <PowerButton variant="contained" type="submit" disabled={!canSubmit}>
          Зберегти
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

function RowActions(props: {
  login: Login;
  onEdit: (login: Login) => void;
  onUserUpdated: (login: Login) => void;
}) {
  const { notify } = usePowerSnackbar();
  const [isResettingTotp, setIsResettingTotp] = useState(false);

  async function handleReset2fa() {
    if (!props.login.totpEnabled || isResettingTotp) return;
    setIsResettingTotp(true);
    try {
      const updated = await updateLogin(toClearTotpReq(props.login));
      props.onUserUpdated(updated);
      notify({ message: '2FA скинуто', severity: 'success' });
    } catch (error) {
      notify({
        message: error instanceof Error && error.message ? error.message : 'Не вдалося скинути 2FA',
        severity: 'error',
      });
    } finally {
      setIsResettingTotp(false);
    }
  }

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', gap: 0.5 }}>
      <MrtRowActionButton
        label="Редагувати"
        onClick={() => props.onEdit(props.login)}
        icon={<EditIcon fontSize="small" />}
        opensModal
      />
      <MrtRowActions forceMenu>
        <MrtRowActionButton
          label="Скинути 2FA"
          onClick={() => {
            void handleReset2fa();
          }}
          disabled={!props.login.totpEnabled || isResettingTotp}
          icon={<LockResetIcon fontSize="small" />}
        />
      </MrtRowActions>
    </Box>
  );
}

function UsersTable(props: {
  data: Login[];
  loading: boolean;
  onEdit: (login: Login) => void;
  onUserUpdated: (login: Login) => void;
}) {
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
    renderRowActions: ({ row }) => (
      <RowActions login={row.original} onEdit={props.onEdit} onUserUpdated={props.onUserUpdated} />
    ),
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
        size: 76,
        minSize: 76,
        maxSize: 76,
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
            <UsersTable
              data={logins}
              loading
              onEdit={(login) => setEditingLogin(login)}
              onUserUpdated={(login) =>
                setLogins((prev) => prev.map((item) => (item.id === login.id ? login : item)))
              }
            />
          </div>
        }
      >
        <div className="flex w-full min-w-0 flex-1 min-h-0">
          <UsersTable
            data={logins}
            loading={false}
            onEdit={(login) => setEditingLogin(login)}
            onUserUpdated={(login) =>
              setLogins((prev) => prev.map((item) => (item.id === login.id ? login : item)))
            }
          />
        </div>
      </TableContentState>
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-echo-lg overflow-hidden">
      <div className="shrink-0">
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
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">{renderTable()}</div>

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
    </div>
  );
}

function AllUsersTab() {
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

export function AdminUsersNeoPage() {
  return <AllUsersTab />;
}
