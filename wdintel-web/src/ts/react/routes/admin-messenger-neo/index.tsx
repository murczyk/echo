import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import LinkIcon from '@mui/icons-material/Link';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutline';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import {
  Alert,
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  MRT_ColumnDef,
  MaterialReactTable,
  useMaterialReactTable,
} from 'material-react-table';
import React from 'react';

import {
  AccountStatusReq,
  AreaOfResponsibility,
  EchoAccountF1,
  LinkAccountReq,
  LinkEchoOperatorReq,
  Login,
} from '../../../../Bindings';
import { Info } from '../../components/info';
import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/mui-customized/button';
import { IconButton } from '../../components/mui-customized/icon-button';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
} from '../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import { TableTopToolbar } from '../../components/mui-customized/table/components/table-top-toolbar';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { listAors } from '../../services/api/aor';
import { restartDatasource } from '../../services/api/admin';
import {
  editAccount,
  getQrCode,
  isLinked,
  linkAccount,
  linkOperator,
  listAccounts,
  unlinkAccount,
} from '../../services/api/messenger';
import { listLogins } from '../../services/api/logins';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

type PhoneForm = {
  messengerType: string;
  phoneNumber: string;
  name: string;
  description: string;
  aorId: number | null;
};

type ApiForm = {
  apiEndpoint: string;
  apiLogin: string | null;
  name: string;
  description: string;
  aorId: number | null;
};

type EditForm = {
  id: number;
  displayName: string;
  description: string;
  aorId: number | null;
};

type LinkStep = 'form' | 'qr' | 'success';
type LinkMode = 'phone' | 'api';

type QrData = {
  accountId: number;
  qrCode: string;
  account: EchoAccountF1;
};

type StatusMessage = {
  kind: 'success' | 'error';
  message: string;
} | null;

type EchoAccountLegacy = {
  id: number;
  area_of_responsibility: EchoAccountF1['areaOfResponsibility'];
  status: string;
  created_at: number;
  client_id: number | null;
  display_name: string;
  system_service_name: string | null;
  description: string | null;
  messenger: string;
  phone_number: string;
  api_login: string | null;
  api_endpoint: string | null;
  is_linked: boolean;
  is_imported: boolean;
  signal_port: string | null;
  process_name: string | null;
  attachments_path: string | null;
  echo_client_id: string | null;
  echo_account_id: string | null;
  echo_client_lock_id: string | null;
};

const DEFAULT_COLUMNS_VISIBILITY = {
  displayName: true,
  systemServiceName: true,
  phoneOrApi: true,
  messenger: true,
  debugInfo: true,
  description: true,
  aor: true,
  status: true,
};

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'displayName',
  'systemServiceName',
  'phoneOrApi',
  'messenger',
  'debugInfo',
  'description',
  'aor',
  'status',
];

const defaultPhoneForm: PhoneForm = {
  messengerType: 'signal',
  phoneNumber: '',
  name: '',
  description: '',
  aorId: null,
};

const defaultApiForm: ApiForm = {
  apiEndpoint: '',
  apiLogin: null,
  name: '',
  description: '',
  aorId: null,
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0)
    return error.message;
  return 'Невідома помилка. Спробуйте ще раз.';
}

function extractQrCodeBase64(response: unknown): string {
  if (!response || typeof response !== 'object') return '';
  const qrCode =
    (response as { qrCodeBase64?: unknown }).qrCodeBase64 ??
    (response as { qr_code_base64?: unknown }).qr_code_base64;
  return typeof qrCode === 'string' ? qrCode : '';
}

function extractIsLinked(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const isLinked =
    (response as { isLinked?: unknown }).isLinked ??
    (response as { is_linked?: unknown }).is_linked;
  return typeof isLinked === 'boolean' ? isLinked : false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function normalizeDescription(description: string): string | null {
  if (!description.trim()) return null;
  return description.trim();
}

function normalizeToSystemName(displayName: string): string {
  const lower = displayName.toLowerCase();
  const withHyphens = lower.replace(/\s+/g, '-');

  const mapping: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'h',
    ґ: 'g',
    д: 'd',
    е: 'e',
    є: 'ye',
    ж: 'zh',
    з: 'z',
    и: 'y',
    і: 'i',
    ї: 'yi',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'kh',
    ц: 'ts',
    ч: 'ch',
    ш: 'sh',
    щ: 'shch',
    ь: '',
    ю: 'yu',
    я: 'ya',
  };

  const mapped = Array.from(withHyphens)
    .map((char) => mapping[char] ?? char)
    .join('');

  const filtered = mapped.replace(/[^a-z0-9_-]/gi, '');
  const collapsed = filtered
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  if (collapsed.length < 4) {
    if (collapsed.length === 0) return 'account';
    return `${collapsed}-${(collapsed.length + 1) % 1000}`;
  }

  if (collapsed.length > 50) return collapsed.slice(0, 50);

  return collapsed;
}

function validateDisplayName(name: string): string | null {
  if (name.trim().length < 2) return 'Назва акаунту має бути мінімум 2 символи';
  if (name.trim().length > 50)
    return 'Назва акаунту має бути максимум 50 символів';
  return null;
}

function validateAorId(aorId: number | null): string | null {
  if (aorId === null) return 'Потрібно вибрати смугу відповідальності';
  return null;
}

function validateApiEndpoint(endpoint: string): string | null {
  if (!endpoint.trim()) return 'API посилання не може бути порожнім';
  if (!endpoint.startsWith('https'))
    return 'API посиланян має бути валідним URL (починається з https://)';
  if (endpoint.trim().length < 10) return 'API посилання занадто короткe';
  return null;
}

function validateApiUser(apiLogin: string | null): string | null {
  if (!apiLogin) return 'Потрібно вибрати API користувача';
  if (apiLogin.length < 3)
    return 'API користувач занадто короткий (мінімум 3 символи)';
  return null;
}

function getStatusText(account: EchoAccountF1): string {
  if (account.isLinked) {
    if (account.status === 'active') return 'Активний';
    if (account.status === 'paused') return 'Призупинено';
    if (account.status === 'ready') return 'Готовий';
    return account.status;
  }

  if (account.status === 'ready') {
    return account.isImported ? 'Імпортовано' : 'Очікує підключення';
  }

  return 'Не підключено';
}

function getStatusColorClass(account: EchoAccountF1): string {
  if (account.isLinked) {
    if (account.status === 'active') return 'text-green-600';
    if (account.status === 'paused') return 'text-yellow-600';
    if (account.status === 'ready') return 'text-blue-600';
    return 'text-gray-600';
  }

  if (account.status === 'ready') {
    return account.isImported ? 'text-purple-600' : 'text-orange-600';
  }

  return 'text-orange-600';
}

function buildDebugDetails(account: EchoAccountF1) {
  return [
    { label: 'echo_client_config.process_name', value: account.processName },
    { label: 'echo_client_config.signal_port', value: account.signalPort },
    {
      label: 'echo_client_config.signal_api_attachment_path',
      value: account.attachmentsPath,
    },
    { label: 'echo_client.id', value: account.echoClientId },
    { label: 'echo_account.id', value: account.echoAccountId },
    { label: 'echo_client_lock.id', value: account.echoClientLockId },
  ].filter((item) => item.value);
}

function buildEditRequest(
  editForm: EditForm,
  account: EchoAccountF1
): AccountStatusReq {
  const currentIsActive = account.status === 'active';

  return {
    accountId: editForm.id,
    aorId: editForm.aorId,
    isActive: currentIsActive,
    displayName: editForm.displayName,
    description: normalizeDescription(editForm.description),
    apiLogin: account.apiLogin,
    apiEndpoint: account.apiEndpoint,
  };
}

function updateAccountInList(
  accounts: EchoAccountF1[],
  accountId: number,
  updater: (account: EchoAccountF1) => EchoAccountF1
) {
  return accounts.map((account) =>
    account.id === accountId ? updater(account) : account
  );
}

function getMessengerLabel(messenger: string) {
  if (messenger === 'signal') return 'Signal';
  if (messenger === 'whatsapp') return 'WhatsApp';
  if (messenger === 'echo_operator') return 'ЕХО Оператор';
  return messenger;
}

function MessengerIcon({ messenger }: { messenger: string }) {
  if (messenger === 'signal')
    return <i className="bi bi-signal text-blue-500" title="Signal" />;
  if (messenger === 'whatsapp')
    return <i className="bi bi-whatsapp text-green-500" title="WhatsApp" />;
  if (messenger === 'echo_operator')
    return <i className="bi bi-link text-red-500" title="ЕХО Оператор" />;
  return <i className="bi bi-chat-fill text-gray-500" title={messenger} />;
}

function useMessengerColumns(): MRT_ColumnDef<EchoAccountF1>[] {
  return React.useMemo(
    () => [
      {
        header: 'Назва акаунту',
        accessorKey: 'displayName',
        size: 180,
      },
      {
        header: 'Системний сервіс',
        accessorKey: 'systemServiceName',
        Cell: ({ cell }) => (
          <span className="text-sm">
            {(cell.getValue<string>() || '').trim() || '—'}
          </span>
        ),
        size: 160,
      },
      {
        header: 'Номер/API Користувач',
        accessorKey: 'phoneOrApi',
        accessorFn: (row) =>
          row.messenger === 'echo_operator'
            ? `API: ${row.apiLogin || ''}`
            : row.phoneNumber,
        Cell: ({ row }) =>
          row.original.messenger === 'echo_operator' ? (
            row.original.apiLogin ? (
              <span>API: {row.original.apiLogin}</span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )
          ) : (
            <span>{row.original.phoneNumber}</span>
          ),
        size: 160,
      },
      {
        header: 'Месенджер',
        accessorKey: 'messenger',
        Cell: ({ row }) => <MessengerIcon messenger={row.original.messenger} />,
        size: 80,
      },
      {
        header: 'Інформація для дебагу',
        accessorKey: 'debugInfo',
        accessorFn: (row) =>
          buildDebugDetails(row)
            .map((item) => item.value)
            .filter(Boolean)
            .join(' | '),
        Cell: ({ row }) => {
          const details = buildDebugDetails(row.original);
          if (details.length === 0)
            return <span className="text-muted-foreground">—</span>;

          return (
            <ul className="space-y-1 list-disc list-inside ml-2 text-xs">
              {details.map((detail) => (
                <li key={detail.label}>
                  <strong>{detail.label}</strong>: {detail.value}
                </li>
              ))}
            </ul>
          );
        },
        size: 240,
      },
      {
        header: 'Опис',
        accessorKey: 'description',
        Cell: ({ row }) => {
          const description = row.original.description;
          const endpoint = row.original.apiEndpoint;
          const trimmedDescription = description?.trim() || '';
          const displayDescription =
            trimmedDescription.length > 50
              ? `${trimmedDescription.slice(0, 50)}...`
              : trimmedDescription;

          return (
            <div className="space-y-1 text-sm">
              {trimmedDescription ? (
                <span title={trimmedDescription}>{displayDescription}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
              {row.original.messenger === 'echo_operator' && endpoint ? (
                <div className="text-xs text-gray-500" title={endpoint}>
                  Endpoint:{' '}
                  {endpoint.length > 30
                    ? `${endpoint.slice(0, 30)}...`
                    : endpoint}
                </div>
              ) : null}
            </div>
          );
        },
        size: 200,
      },
      {
        header: 'Смуга відповідальності',
        accessorKey: 'aor',
        accessorFn: (row) => row.areaOfResponsibility?.name || '—',
        Cell: ({ row }) => (
          <span>{row.original.areaOfResponsibility?.name || '—'}</span>
        ),
        size: 160,
      },
      {
        header: 'Статус',
        accessorKey: 'status',
        accessorFn: (row) => getStatusText(row),
        Cell: ({ row }) => (
          <span className={getStatusColorClass(row.original)}>
            {getStatusText(row.original)}
          </span>
        ),
        size: 140,
      },
    ],
    []
  );
}

type TableActionsProps = {
  account: EchoAccountF1;
  disabled: boolean;
  onRestart: (accountId: number) => void;
  onEdit: (accountId: number) => void;
  onDelete: (accountId: number) => void;
  onToggleStatus: (accountId: number) => void;
  onConnect: (accountId: number) => void;
};

function TableRowActions(props: TableActionsProps) {
  const { account } = props;

  return (
    <div className="grid grid-cols-2 gap-1">
      <Tooltip title="Перезапустити">
        <span>
          <IconButton
            size="small"
            disabled={props.disabled}
            onClick={() => props.onRestart(account.id)}
            className="table-action-btn"
          >
            <RestartAltIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Редагувати">
        <span>
          <IconButton
            size="small"
            disabled={props.disabled}
            onClick={() => props.onEdit(account.id)}
            className="table-action-btn"
          >
            <EditIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      {account.isLinked ? (
        <Tooltip
          title={account.status === 'active' ? 'Відвʼязати' : 'Активувати'}
        >
          <span>
            <IconButton
              size="small"
              disabled={props.disabled}
              onClick={() => props.onToggleStatus(account.id)}
              className="table-action-btn"
            >
              {account.status === 'active' ? (
                <PauseCircleOutlineIcon />
              ) : (
                <PlayCircleOutlineIcon />
              )}
            </IconButton>
          </span>
        </Tooltip>
      ) : (
        <Tooltip title="Підключити">
          <span>
            <IconButton
              size="small"
              disabled={props.disabled}
              onClick={() => props.onConnect(account.id)}
              className="table-action-btn"
            >
              <LinkIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      )}
      <Tooltip title="Видалити">
        <span>
          <IconButton
            size="small"
            disabled={props.disabled}
            onClick={() => props.onDelete(account.id)}
            className="icon-btn icon-btn-danger"
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </div>
  );
}

type MessengerAccountsTableProps = {
  data: EchoAccountF1[];
  actionsDisabled: boolean;
  onRestart: (accountId: number) => void;
  onEdit: (accountId: number) => void;
  onDelete: (accountId: number) => void;
  onToggleStatus: (accountId: number) => void;
  onConnect: (accountId: number) => void;
};

const defaultMRTOptions = getDefaultMRTOptions<EchoAccountF1>();

function MessengerAccountsTable(props: MessengerAccountsTableProps) {
  const columns = useMessengerColumns();
  const tableStateContext = useTableStateContext();

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
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
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
    renderRowActions: ({ row }) => (
      <TableRowActions
        account={row.original}
        disabled={props.actionsDisabled}
        onRestart={props.onRestart}
        onEdit={props.onEdit}
        onDelete={props.onDelete}
        onToggleStatus={props.onToggleStatus}
        onConnect={props.onConnect}
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
    state,
  });

  React.useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function AdminMessengerNeoPageBody() {
  const [accounts, setAccounts] = React.useState<EchoAccountF1[]>([]);
  const [accountsStatus, setAccountsStatus] =
    React.useState<LoadingStatus>('idle');
  const [accountsError, setAccountsError] = React.useState<string | null>(null);
  const [aors, setAors] = React.useState<AreaOfResponsibility[]>([]);
  const [aorsStatus, setAorsStatus] = React.useState<LoadingStatus>('idle');
  const [apiUsers, setApiUsers] = React.useState<Login[]>([]);
  const [apiUsersStatus, setApiUsersStatus] =
    React.useState<LoadingStatus>('idle');
  const [linkMode, setLinkMode] = React.useState<LinkMode>('phone');
  const [linkStep, setLinkStep] = React.useState<LinkStep>('form');
  const [linkSidebarOpen, setLinkSidebarOpen] = React.useState(false);
  const [phoneForm, setPhoneForm] = React.useState<PhoneForm>(defaultPhoneForm);
  const [apiForm, setApiForm] = React.useState<ApiForm>(defaultApiForm);
  const [formErrors, setFormErrors] = React.useState<Record<string, string>>(
    {}
  );
  const [qrData, setQrData] = React.useState<QrData | null>(null);
  const [linkSuccessAccount, setLinkSuccessAccount] =
    React.useState<EchoAccountF1 | null>(null);
  const [linkStatus, setLinkStatus] = React.useState<StatusMessage>(null);
  const [editSidebarOpen, setEditSidebarOpen] = React.useState(false);
  const [editForm, setEditForm] = React.useState<EditForm | null>(null);
  const [editErrors, setEditErrors] = React.useState<Record<string, string>>(
    {}
  );
  const [deleteAccountId, setDeleteAccountId] = React.useState<number | null>(
    null
  );
  const [actionStatus, setActionStatus] = React.useState<StatusMessage>(null);
  const [isMutating, setIsMutating] = React.useState(false);

  async function loadAccounts() {
    setAccountsStatus('loading');
    setAccountsError(null);
    try {
      const rsp = await listAccounts();
      setAccounts(transformAccounts(rsp.accounts));
      setAccountsStatus('success');
    } catch (error) {
      setAccountsStatus('error');
      setAccountsError(formatErrorMessage(error));
    }
  }

  function transformAccounts(accounts: Array<EchoAccountF1 | EchoAccountLegacy>): EchoAccountF1[] {
    // transform objects from BE model to FE model
    return accounts.map((account) => ({
      id: account.id,
      areaOfResponsibility:
        'areaOfResponsibility' in account ? account.areaOfResponsibility : account.area_of_responsibility,
      status: account.status,
      createdAt: 'createdAt' in account ? account.createdAt : account.created_at,
      clientId: 'clientId' in account ? account.clientId : account.client_id,
      displayName: 'displayName' in account ? account.displayName : account.display_name,
      systemServiceName:
        'systemServiceName' in account ? account.systemServiceName : account.system_service_name,
      description: account.description,
      messenger: account.messenger,
      phoneNumber: 'phoneNumber' in account ? account.phoneNumber : account.phone_number,
      apiLogin: 'apiLogin' in account ? account.apiLogin : account.api_login,
      apiEndpoint: 'apiEndpoint' in account ? account.apiEndpoint : account.api_endpoint,
      isLinked: 'isLinked' in account ? account.isLinked : account.is_linked,
      isImported: 'isImported' in account ? account.isImported : account.is_imported,
      signalPort: 'signalPort' in account ? account.signalPort : account.signal_port,
      processName: 'processName' in account ? account.processName : account.process_name,
      attachmentsPath:
        'attachmentsPath' in account ? account.attachmentsPath : account.attachments_path,
      echoClientId: 'echoClientId' in account ? account.echoClientId : account.echo_client_id,
      echoAccountId: 'echoAccountId' in account ? account.echoAccountId : account.echo_account_id,
      echoClientLockId:
        'echoClientLockId' in account ? account.echoClientLockId : account.echo_client_lock_id,
    }));
  }
  async function loadAors() {
    setAorsStatus('loading');
    try {
      const list = await listAors({ sortBy: null });
      setAors(list);
      setAorsStatus('success');
    } catch (error) {
      setAorsStatus('error');
      setActionStatus({
        kind: 'error',
        message: `Помилка завантаження смуг: ${formatErrorMessage(error)}`,
      });
    }
  }

  async function loadApiUsers() {
    if (apiUsersStatus === 'loading' || apiUsersStatus === 'success') return;
    setApiUsersStatus('loading');
    try {
      const rsp = await listLogins({ sortBy: null, filterByRoles: ['Api'] });
      setApiUsers(rsp.users);
      setApiUsersStatus('success');
    } catch (error) {
      setApiUsersStatus('error');
      setActionStatus({
        kind: 'error',
        message: `Помилка завантаження API користувачів: ${formatErrorMessage(
          error
        )}`,
      });
    }
  }

  React.useEffect(() => {
    loadAccounts();
    loadAors();
  }, []);

  React.useEffect(() => {
    if (linkStep !== 'qr' || !qrData) return;

    const intervalId = window.setInterval(async () => {
      try {
        const rsp = await isLinked({ accountId: qrData.accountId });
        if (extractIsLinked(rsp)) {
          setAccounts((prev) =>
            updateAccountInList(prev, qrData.accountId, (account) => ({
              ...account,
              isLinked: true,
            }))
          );
          setLinkSuccessAccount(qrData.account);
          setLinkStep('success');
        }
      } catch (_) {
        // silent polling failure
      }
    }, 3000);

    return () => window.clearInterval(intervalId);
  }, [linkStep, qrData?.accountId]);

  function resetLinkFlow() {
    setLinkMode('phone');
    setLinkStep('form');
    setLinkSidebarOpen(false);
    setPhoneForm(defaultPhoneForm);
    setApiForm(defaultApiForm);
    setFormErrors({});
    setQrData(null);
    setLinkSuccessAccount(null);
    setLinkStatus(null);
  }

  function openLinkSidebar() {
    setLinkSidebarOpen(true);
    setLinkStep('form');
    setLinkStatus(null);
    setLinkSuccessAccount(null);
    setQrData(null);
  }

  function closeLinkSidebar() {
    resetLinkFlow();
  }

  function switchLinkMode(nextMode: LinkMode) {
    setLinkMode(nextMode);
    setLinkStep('form');
    setFormErrors({});
    setLinkStatus(null);
    if (nextMode === 'phone') {
      setPhoneForm(defaultPhoneForm);
    } else {
      setApiForm(defaultApiForm);
    }
    if (nextMode === 'api') {
      loadApiUsers();
    }
  }

  async function fetchQrCode(accountId: number) {
    const maxAttempts = 2;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const qrRsp = await getQrCode({ accountId });
        const qrCode = extractQrCodeBase64(qrRsp);

        if (qrCode.trim().length > 0) {
          setQrData((prev) =>
            prev && prev.accountId === accountId
              ? { ...prev, qrCode }
              : prev
          );
          return;
        }

        if (attempt < maxAttempts - 1) {
          await wait(1000);
          continue;
        }
      } catch (error) {
        if (attempt < maxAttempts - 1) {
          await wait(1000);
          continue;
        }

        setLinkStatus({
          kind: 'error',
          message: `Помилка отримання QR коду: ${formatErrorMessage(error)}`,
        });
        return;
      }
    }

    setLinkStatus({
      kind: 'error',
      message: 'Помилка отримання QR коду: порожня відповідь сервера.',
    });
  }

  async function submitLinkForm() {
    const errors: Record<string, string> = {};

    if (linkMode === 'phone') {
      const nameError = validateDisplayName(phoneForm.name);
      if (nameError) errors.displayName = nameError;

      const aorError = validateAorId(phoneForm.aorId);
      if (aorError) errors.aorId = aorError;

      if (Object.keys(errors).length > 0) {
        setFormErrors(errors);
        return;
      }

      if (phoneForm.aorId === null) {
        setFormErrors({ aorId: 'Потрібно вибрати смугу відповідальності' });
        return;
      }

      const request: LinkAccountReq = {
        messenger: phoneForm.messengerType,
        phone: phoneForm.phoneNumber,
        displayName: phoneForm.name.trim(),
        systemServiceName: normalizeToSystemName(phoneForm.name),
        description: normalizeDescription(phoneForm.description),
        aorId: phoneForm.aorId,
      };

      setIsMutating(true);
      setLinkStatus(null);

      try {
        const rsp = await linkAccount(request);
        setAccounts((prev) => [rsp.account, ...prev]);
        setQrData({
          accountId: rsp.account.id,
          qrCode: '',
          account: rsp.account,
        });
        setLinkStep('qr');
        await fetchQrCode(rsp.account.id);
      } catch (error) {
        setLinkStatus({
          kind: 'error',
          message: `Помилка прив'язування акаунту: ${formatErrorMessage(
            error
          )}`,
        });
      } finally {
        setIsMutating(false);
      }
      return;
    }

    const nameError = validateDisplayName(apiForm.name);
    if (nameError) errors.displayName = nameError;

    const aorError = validateAorId(apiForm.aorId);
    if (aorError) errors.aorId = aorError;

    const apiEndpointError = validateApiEndpoint(apiForm.apiEndpoint);
    if (apiEndpointError) errors.apiEndpoint = apiEndpointError;

    const apiUserError = validateApiUser(apiForm.apiLogin);
    if (apiUserError) errors.apiUser = apiUserError;

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    if (!apiForm.apiLogin || apiForm.aorId === null) {
      setFormErrors({
        apiUser: 'Потрібно вибрати API користувача',
        aorId: 'Потрібно вибрати смугу відповідальності',
      });
      return;
    }

    const request: LinkEchoOperatorReq = {
      apiLogin: apiForm.apiLogin,
      apiEndpoint: apiForm.apiEndpoint.trim(),
      displayName: apiForm.name.trim(),
      description: normalizeDescription(apiForm.description),
      aorId: apiForm.aorId,
    };

    setIsMutating(true);
    setLinkStatus(null);

    try {
      const rsp = await linkOperator(request);
      setAccounts((prev) => [rsp.account, ...prev]);
      resetLinkFlow();
    } catch (error) {
      setLinkStatus({
        kind: 'error',
        message: `Помилка прив'язування акаунту: ${formatErrorMessage(error)}`,
      });
    } finally {
      setIsMutating(false);
    }
  }

  function openEditSidebar(accountId: number) {
    const account = accounts.find((item) => item.id === accountId);
    if (!account) return;

    setEditForm({
      id: account.id,
      displayName: account.displayName,
      description: account.description || '',
      aorId: account.areaOfResponsibility?.id ?? null,
    });
    setEditErrors({});
    setEditSidebarOpen(true);
  }

  function closeEditSidebar() {
    setEditSidebarOpen(false);
    setEditForm(null);
    setEditErrors({});
  }

  async function submitEditForm() {
    if (!editForm) return;

    const errors: Record<string, string> = {};
    const nameError = validateDisplayName(editForm.displayName);
    if (nameError) errors.displayName = nameError;
    const aorError = validateAorId(editForm.aorId);
    if (aorError) errors.aorId = aorError;

    if (Object.keys(errors).length > 0) {
      setEditErrors(errors);
      return;
    }

    const account = accounts.find((item) => item.id === editForm.id);
    if (!account) return;

    setIsMutating(true);
    try {
      await editAccount(buildEditRequest(editForm, account));
      const updatedAor = aors.find((aor) => aor.id === editForm.aorId) || null;
      setAccounts((prev) =>
        updateAccountInList(prev, editForm.id, (current) => ({
          ...current,
          displayName: editForm.displayName,
          description: normalizeDescription(editForm.description),
          areaOfResponsibility: updatedAor,
        }))
      );
      closeEditSidebar();
    } catch (error) {
      setActionStatus({
        kind: 'error',
        message: `Помилка редагування акаунту: ${formatErrorMessage(error)}`,
      });
    } finally {
      setIsMutating(false);
    }
  }

  async function handleDeleteConfirm() {
    if (deleteAccountId === null) return;
    setIsMutating(true);
    try {
      await unlinkAccount({ accountId: deleteAccountId });
      setAccounts((prev) =>
        prev.filter((account) => account.id !== deleteAccountId)
      );
      setDeleteAccountId(null);
    } catch (error) {
      setActionStatus({
        kind: 'error',
        message: `Помилка видалення акаунту: ${formatErrorMessage(error)}`,
      });
      setDeleteAccountId(null);
    } finally {
      setIsMutating(false);
    }
  }

  async function handleToggleStatus(accountId: number) {
    const account = accounts.find((item) => item.id === accountId);
    if (!account) return;

    const request: AccountStatusReq = {
      accountId: account.id,
      aorId: account.areaOfResponsibility?.id ?? null,
      isActive: account.status !== 'active',
      displayName: account.displayName,
      description: account.description,
      apiLogin: account.apiLogin,
      apiEndpoint: account.apiEndpoint,
    };

    setIsMutating(true);
    try {
      await editAccount(request);
      setAccounts((prev) =>
        updateAccountInList(prev, accountId, (current) => ({
          ...current,
          status: current.status === 'active' ? 'paused' : 'active',
        }))
      );
    } catch (error) {
      setActionStatus({
        kind: 'error',
        message: `Помилка зміни статусу акаунту: ${formatErrorMessage(error)}`,
      });
    } finally {
      setIsMutating(false);
    }
  }

  async function handleRestartDatasource(accountId: number) {
    setIsMutating(true);
    try {
      await restartDatasource(accountId);
      setActionStatus({
        kind: 'success',
        message: 'Запит на перезапуск надіслано.',
      });
    } catch (error) {
      setActionStatus({
        kind: 'error',
        message: `Помилка перезапуску джерела: ${formatErrorMessage(error)}`,
      });
    } finally {
      setIsMutating(false);
    }
  }

  async function handleConnectExisting(accountId: number) {
    const account = accounts.find((item) => item.id === accountId);
    if (!account) return;
    setLinkSidebarOpen(true);
    setLinkMode('phone');
    setLinkStep('qr');
    setQrData({ accountId, qrCode: '', account });
    setLinkStatus(null);
    setLinkSuccessAccount(null);
    await fetchQrCode(accountId);
  }

  const aorOptions = aors.map((aor) => (
    <MenuItem key={aor.id} value={aor.id}>
      {aor.name}
    </MenuItem>
  ));

  const apiUserOptions = apiUsers.map((user) => (
    <MenuItem key={user.login} value={user.login}>
      {user.login}
    </MenuItem>
  ));

  const renderAccountsTable = () => {
    if (accountsStatus === 'loading') {
      return (
        <div className="flex items-center justify-center py-12">
          <CircularProgress size={28} />
        </div>
      );
    }
    if (accountsStatus === 'error') {
      return (
        <div className="text-center py-8 text-red-600">
          {accountsError || 'Помилка завантаження'}
        </div>
      );
    }
    if (accountsStatus === 'success') {
      return (
        <div className="table-responsive-modern">
          <MessengerAccountsTable
            data={accounts}
            actionsDisabled={isMutating}
            onRestart={handleRestartDatasource}
            onEdit={openEditSidebar}
            onDelete={setDeleteAccountId}
            onToggleStatus={handleToggleStatus}
            onConnect={handleConnectExisting}
          />
        </div>
      );
    }
    return null;
  };

  const renderDeleteDialog = () => (
    <Dialog
      open={deleteAccountId !== null}
      onClose={() => setDeleteAccountId(null)}
    >
      <DialogTitle>Підтвердження видалення</DialogTitle>
      <DialogContent>
        <Typography className="text-sm text-muted-foreground">
          Ви впевнені, що хочете видалити цей акаунт месенджера?
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" onClick={() => setDeleteAccountId(null)}>
          Скасувати
        </Button>
        <Button
          variant="contained"
          color="error"
          onClick={handleDeleteConfirm}
          disabled={isMutating}
        >
          Видалити
        </Button>
      </DialogActions>
    </Dialog>
  );

  const renderLinkSidebar = () => (
    <Drawer
      anchor="right"
      open={linkSidebarOpen}
      onClose={closeLinkSidebar}
      PaperProps={{ sx: { width: { xs: '100%', sm: 420 } } }}
    >
      <Box className="flex flex-col h-full">
        <Box className="p-6 border-b border-border">
          <Typography variant="h6" className="!font-semibold mb-1">
            Прив'язати новий акаунт
          </Typography>
          <Typography variant="body2" className="text-muted-foreground">
            Введіть дані для прив'язування акаунту месенджера
          </Typography>
        </Box>

        {linkStep === 'form' ? (
          <Box className="flex-1 overflow-y-auto p-6 space-y-5">
            <Box className="flex gap-2">
              <Button
                variant={linkMode === 'phone' ? 'contained' : 'outlined'}
                onClick={() => switchLinkMode('phone')}
              >
                Телефон
              </Button>
              <Button
                variant={linkMode === 'api' ? 'contained' : 'outlined'}
                onClick={() => switchLinkMode('api')}
              >
                API
              </Button>
            </Box>

            {linkMode === 'phone' ? (
              <div className="space-y-4">
                <TextField
                  select
                  label="Тип месенджера"
                  value={phoneForm.messengerType}
                  onChange={(event) =>
                    setPhoneForm((prev) => ({
                      ...prev,
                      messengerType: event.target.value,
                    }))
                  }
                  fullWidth
                >
                  <MenuItem value="signal">Signal</MenuItem>
                  <MenuItem value="whatsapp">WhatsApp</MenuItem>
                  <MenuItem value="echo_operator">ЕХО Оператор</MenuItem>
                </TextField>
                <TextField
                  label="Номер телефону"
                  value={phoneForm.phoneNumber}
                  onChange={(event) =>
                    setPhoneForm((prev) => ({
                      ...prev,
                      phoneNumber: event.target.value,
                    }))
                  }
                  placeholder="+380XXXXXXXXX"
                  fullWidth
                />
              </div>
            ) : (
              <div className="space-y-4">
                <TextField
                  label="API посилання"
                  value={apiForm.apiEndpoint}
                  onChange={(event) => {
                    setApiForm((prev) => ({
                      ...prev,
                      apiEndpoint: event.target.value,
                    }));
                    setFormErrors((prev) => ({ ...prev, apiEndpoint: '' }));
                  }}
                  placeholder="https://api.example.com/webhook"
                  error={Boolean(formErrors.apiEndpoint)}
                  helperText={formErrors.apiEndpoint}
                  fullWidth
                />
                <TextField
                  select
                  label="API Користувач"
                  value={apiForm.apiLogin || ''}
                  onChange={(event) => {
                    setApiForm((prev) => ({
                      ...prev,
                      apiLogin: event.target.value || null,
                    }));
                    setFormErrors((prev) => ({ ...prev, apiUser: '' }));
                  }}
                  fullWidth
                  disabled={apiUsersStatus === 'loading'}
                  error={Boolean(formErrors.apiUser)}
                  helperText={formErrors.apiUser}
                >
                  {apiUsersStatus === 'loading' ? (
                    <MenuItem value="">Завантаження...</MenuItem>
                  ) : (
                    apiUserOptions
                  )}
                </TextField>
              </div>
            )}

            <TextField
              label="Назва акаунту"
              value={linkMode === 'phone' ? phoneForm.name : apiForm.name}
              onChange={(event) => {
                if (linkMode === 'phone') {
                  setPhoneForm((prev) => ({
                    ...prev,
                    name: event.target.value,
                  }));
                } else {
                  setApiForm((prev) => ({ ...prev, name: event.target.value }));
                }
                setFormErrors((prev) => ({ ...prev, displayName: '' }));
              }}
              error={Boolean(formErrors.displayName)}
              helperText={formErrors.displayName}
              fullWidth
            />

            <TextField
              select
              label="Смуга відповідальності"
              value={
                linkMode === 'phone'
                  ? phoneForm.aorId ?? ''
                  : apiForm.aorId ?? ''
              }
              onChange={(event) => {
                const value = event.target.value
                  ? Number(event.target.value)
                  : null;
                if (linkMode === 'phone') {
                  setPhoneForm((prev) => ({ ...prev, aorId: value }));
                } else {
                  setApiForm((prev) => ({ ...prev, aorId: value }));
                }
                setFormErrors((prev) => ({ ...prev, aorId: '' }));
              }}
              fullWidth
              error={Boolean(formErrors.aorId)}
              helperText={formErrors.aorId}
              disabled={aorsStatus === 'loading'}
            >
              {aorsStatus === 'loading' ? (
                <MenuItem value="">Завантаження...</MenuItem>
              ) : (
                aorOptions
              )}
            </TextField>

            <TextField
              label="Опис (необов'язково)"
              value={
                linkMode === 'phone'
                  ? phoneForm.description
                  : apiForm.description
              }
              onChange={(event) => {
                if (linkMode === 'phone') {
                  setPhoneForm((prev) => ({
                    ...prev,
                    description: event.target.value,
                  }));
                } else {
                  setApiForm((prev) => ({
                    ...prev,
                    description: event.target.value,
                  }));
                }
              }}
              multiline
              rows={3}
              fullWidth
            />

            {linkStatus?.kind === 'error' ? (
              <Info text={linkStatus.message} color="error" />
            ) : null}
          </Box>
        ) : null}

        {linkStep === 'qr' && qrData ? (
          <Box className="flex-1 overflow-y-auto p-6 text-center space-y-4">
            <Typography variant="subtitle1" className="!font-semibold">
              {getMessengerLabel(qrData.account.messenger)}:{' '}
              {qrData.account.phoneNumber}
            </Typography>
            {qrData.qrCode ? (
              <img
                src={qrData.qrCode}
                className="mx-auto max-w-xs"
                alt="QR code"
              />
            ) : (
              <div className="py-8">Завантаження QR коду...</div>
            )}
            <div className="flex items-center justify-center gap-2">
              <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
              <span className="text-sm text-muted-foreground">
                Очікування підключення...
              </span>
            </div>
            {linkStatus?.kind === 'error' ? (
              <Info text={linkStatus.message} color="error" />
            ) : null}
            <div className="flex items-center justify-center gap-2">
              <Button variant="outlined" onClick={closeLinkSidebar}>
                Скасувати
              </Button>
              <Button
                variant="outlined"
                onClick={() => fetchQrCode(qrData.accountId)}
                startIcon={<RefreshIcon />}
              >
                Оновити QR код
              </Button>
            </div>
          </Box>
        ) : null}

        {linkStep === 'success' && linkSuccessAccount ? (
          <Box className="flex-1 overflow-y-auto p-6 text-center space-y-4">
            <Typography variant="h6" className="!font-semibold">
              Акаунт успішно прив'язано!
            </Typography>
            <div className="text-green-600 text-6xl">✅</div>
            <Typography variant="body2" className="text-muted-foreground">
              {getMessengerLabel(linkSuccessAccount.messenger)}:{' '}
              {linkSuccessAccount.phoneNumber}
            </Typography>
            <Button variant="contained" onClick={closeLinkSidebar}>
              Закрити
            </Button>
          </Box>
        ) : null}

        {linkStep === 'form' ? (
          <Box className="p-6 border-t border-border flex gap-3">
            <Button variant="outlined" onClick={closeLinkSidebar}>
              Скасувати
            </Button>
            <Button
              variant="contained"
              onClick={submitLinkForm}
              disabled={isMutating}
            >
              Прив'язати
            </Button>
          </Box>
        ) : null}
      </Box>
    </Drawer>
  );

  const renderEditSidebar = () => (
    <Drawer
      anchor="right"
      open={editSidebarOpen}
      onClose={closeEditSidebar}
      PaperProps={{ sx: { width: { xs: '100%', sm: 420 } } }}
    >
      <Box className="flex flex-col h-full">
        <Box className="p-6 border-b border-border">
          <Typography variant="h6" className="!font-semibold mb-1">
            Редагувати акаунт
          </Typography>
          <Typography variant="body2" className="text-muted-foreground">
            Змініть дані акаунту месенджера
          </Typography>
        </Box>
        {editForm ? (
          <Box className="flex-1 overflow-y-auto p-6 space-y-4">
            <TextField
              label="Назва акаунту"
              value={editForm.displayName}
              onChange={(event) => {
                setEditForm((prev) =>
                  prev ? { ...prev, displayName: event.target.value } : prev
                );
                setEditErrors((prev) => ({ ...prev, displayName: '' }));
              }}
              error={Boolean(editErrors.displayName)}
              helperText={editErrors.displayName}
              fullWidth
            />
            <TextField
              select
              label="Смуга відповідальності"
              value={editForm.aorId ?? ''}
              onChange={(event) => {
                const value = event.target.value
                  ? Number(event.target.value)
                  : null;
                setEditForm((prev) =>
                  prev ? { ...prev, aorId: value } : prev
                );
                setEditErrors((prev) => ({ ...prev, aorId: '' }));
              }}
              fullWidth
              error={Boolean(editErrors.aorId)}
              helperText={editErrors.aorId}
              disabled={aorsStatus === 'loading'}
            >
              {aorsStatus === 'loading' ? (
                <MenuItem value="">Завантаження...</MenuItem>
              ) : (
                aorOptions
              )}
            </TextField>
            <TextField
              label="Опис (необов'язково)"
              value={editForm.description}
              onChange={(event) =>
                setEditForm((prev) =>
                  prev ? { ...prev, description: event.target.value } : prev
                )
              }
              multiline
              rows={3}
              fullWidth
            />
          </Box>
        ) : null}
        <Box className="p-6 border-t border-border flex gap-3">
          <Button variant="outlined" onClick={closeEditSidebar}>
            Скасувати
          </Button>
          <Button
            variant="contained"
            onClick={submitEditForm}
            disabled={isMutating || !editForm}
          >
            Зберегти
          </Button>
        </Box>
      </Box>
    </Drawer>
  );

  return (
    <div className="mt-2 w-full space-y-4">
      <PageHeader title="Месенджери" />

      {actionStatus?.kind === 'error' ? (
        <Info text={actionStatus.message} color="error" />
      ) : null}
      {actionStatus?.kind === 'success' ? (
        <Alert severity="success" onClose={() => setActionStatus(null)}>
          {actionStatus.message}
        </Alert>
      ) : null}

      <div className="border border-border rounded-lg mb-4 p-4 bg-[var(--bs-tertiary-bg)] flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Управління прив'язаними акаунтами месенджерів
        </div>
        <Button variant="contained" onClick={openLinkSidebar}>
          Прив'язати новий
        </Button>
      </div>

      <TableTopToolbar
        withDatePicker={false}
        withGlobalTextFilter
        header={
          <span className="text-sm text-muted-foreground">
            Усього: {accounts.length}
          </span>
        }
      />
      {renderAccountsTable()}
      {renderDeleteDialog()}
      {renderLinkSidebar()}
      {renderEditSidebar()}
    </div>
  );
}

export function AdminMessengerNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-messenger"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
    >
      <AdminMessengerNeoPageBody />
    </TableStateProvider>
  );
}
