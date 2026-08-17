import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import NetworkCheckIcon from '@mui/icons-material/NetworkCheck';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import {
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { MaterialReactTable } from 'material-react-table';

import type { AiEngineItem } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  mrtCustomCell,
  mrtTextCell,
  useAppMaterialReactTable,
  renderColumnActionsMenuItems,
  type AppMrtColumnDef,
} from '../../components/mui-customized/table/get-default-table-options';
import { MrtOverflowText } from '../../components/mui-customized/table/mrt-overflow';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import {
  AiAgentAuditRequest,
  AiAgentAuditRequestDetail,
  AiAgentContainer,
  AiAgentDispatcher,
  AiAgentEchoProxy,
  AiAgentSettings,
  deleteAiAgentEchoProxy,
  getAiAgentDispatcher,
  getAiAgentAuditRequest,
  getAiAgentSettings,
  listAiAgentAuditRequests,
  listAiAgentContainers,
  listAiAgentEchoProxies,
  retryAiAgentSecurityReview,
  saveAiAgentDispatcher,
  saveAiAgentEchoProxy,
  saveAiAgentSettings,
  startAiAgentContainer,
  stopAiAgentContainer,
  testAiAgentDispatcher,
  testAiAgentEchoProxy,
} from '../../services/api/ai-agent';
import { listAiEngines } from '../../services/api/ai-engines';
import { AdminAiCallsignsPage } from '../admin-ai-callsigns';
import { AiEnginesSection } from '../admin-system-settings-neo/AiEnginesSection';
import {
  type AiAgentEngineCompatibility,
  getAiAgentEngineCompatibility,
  getAiAgentTokenNotice,
  getAiReviewerEngineCompatibility,
} from './engine-eligibility';
import { readAiAgentRequestDeepLink } from './url-state';

export type AiAgentAdminSection =
  | 'providers'
  | 'containers'
  | 'requests'
  | 'dispatcher'
  | 'echo-proxies'
  | 'callsigns'
  | 'settings';

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Невідома помилка';
}

function formatDateTime(timestamp: number | null): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

export function requestDurationSeconds(
  request: Pick<AiAgentAuditRequest, 'createdAt' | 'completedAt' | 'state'>,
  now = Date.now(),
): number | null {
  const end =
    request.completedAt ?? (request.state === 'queued' || request.state === 'running' ? now : null);
  if (end === null || end < request.createdAt) return null;
  return Math.round((end - request.createdAt) / 100) / 10;
}

function statusColor(status: string): 'default' | 'success' | 'warning' | 'error' | 'info' {
  if (['running', 'completed', 'safe', 'sent'].includes(status)) return 'success';
  if (['queued', 'pending', 'starting'].includes(status)) return 'info';
  if (['suspicious', 'stopping'].includes(status)) return 'warning';
  if (['failed', 'critical'].includes(status)) return 'error';
  return 'default';
}

function PageFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Stack spacing={2} alignItems="flex-start">
      <PowerAlert severity="error">{message}</PowerAlert>
      <PowerButton type="button" variant="outlined" onClick={onRetry}>
        Спробувати ще раз
      </PowerButton>
    </Stack>
  );
}

function ProvidersPage() {
  return <AiEnginesSection getCompatibility={getAiAgentEngineCompatibility} />;
}

const CONTAINERS_ROW_ACTIONS_SIZE = 56;
const CONTAINERS_DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'humanLogin',
  'linkedLogin',
  'instanceName',
  'status',
  'resources',
  'lastChangedAt',
];
const CONTAINERS_DEFAULT_COLUMN_VISIBILITY = {
  humanLogin: true,
  linkedLogin: true,
  instanceName: true,
  status: true,
  resources: true,
  lastChangedAt: true,
};
const containersDefaultMRTOptions = getDefaultMRTOptions<AiAgentContainer>();

function ContainersTable({
  containers,
  loading,
  actionId,
  onAction,
}: {
  containers: AiAgentContainer[];
  loading: boolean;
  actionId: string | null;
  onAction: (container: AiAgentContainer, action: 'start' | 'stop') => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo<AppMrtColumnDef<AiAgentContainer>[]>(
    () => [
      {
        accessorKey: 'humanLogin',
        header: 'Користувач',
        size: 180,
        meta: { overflowMode: 'custom', overflowOwner: 'shared-text', interactive: true },
        Cell: mrtCustomCell(({ row }) => (
          <MrtOverflowText
            displayValue={row.original.humanLogin}
            fullValue={row.original.humanLogin}
            interactive
            component="a"
            componentProps={{
              href: `/admin/users-neo/${encodeURIComponent(row.original.humanLoginId)}`,
            }}
          />
        )),
      },
      {
        accessorKey: 'linkedLogin',
        header: 'Пов’язаний логін',
        size: 190,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => row.original.linkedLogin ?? '—',
          fullValue: ({ row }) => row.original.linkedLogin ?? '—',
        }),
      },
      {
        accessorKey: 'instanceName',
        header: 'Інстанс',
        size: 260,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => row.original.instanceName ?? '—',
          fullValue: ({ row }) => row.original.instanceName ?? '—',
        }),
      },
      {
        accessorKey: 'status',
        header: 'Стан',
        size: 170,
        meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
        Cell: mrtCustomCell(({ row }) => (
          <Stack spacing={0.5} alignItems="flex-start">
            <Chip
              size="small"
              label={row.original.status}
              color={statusColor(row.original.status)}
            />
            {row.original.lastError ? (
              <Typography variant="caption" color="error">
                {row.original.lastError}
              </Typography>
            ) : null}
          </Stack>
        )),
      },
      {
        id: 'resources',
        header: 'Ресурси',
        accessorFn: (container) =>
          `${container.cpuCount} vCPU · ${container.memoryMib} MiB · ${container.storageGib} GiB · ${container.processLimit} процесів`,
        size: 310,
      },
      {
        id: 'lastChangedAt',
        header: 'Остання зміна',
        accessorFn: (container) =>
          formatDateTime(
            container.status === 'running' ? container.lastStartedAt : container.lastStoppedAt,
          ),
        size: 180,
      },
    ],
    [],
  );
  const table = useAppMaterialReactTable({
    columns,
    data: containers,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => {
      const running = row.original.status === 'running';
      const transitioning = ['starting', 'stopping'].includes(row.original.status);
      return (
        <MrtRowActions>
          <MrtRowActionButton
            label={running ? 'Force stop' : 'Start'}
            tone={running ? 'danger' : 'default'}
            disabled={transitioning || actionId === row.original.id}
            icon={
              actionId === row.original.id ? (
                <CircularProgress size={16} />
              ) : running ? (
                <StopCircleOutlinedIcon fontSize="small" />
              ) : (
                <PlayArrowIcon fontSize="small" />
              )
            }
            onClick={() => onAction(row.original, running ? 'stop' : 'start')}
          />
        </MrtRowActions>
      );
    },
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
    defaultColumn: { size: 200, renderColumnActionsMenuItems },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: CONTAINERS_ROW_ACTIONS_SIZE,
        minSize: CONTAINERS_ROW_ACTIONS_SIZE,
        maxSize: CONTAINERS_ROW_ACTIONS_SIZE,
      },
      'mrt-row-numbers': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        muiTableBodyCellProps: () => ({
          sx: { justifyContent: 'center', ...CUSTOM_CELL_STYLES },
        }),
      },
    },
    muiTablePaperProps: ({ table }) =>
      getDefaultMrtPaperProps({ table, loading, layout: 'workspace' }),
    muiTableContainerProps: ({ table }) =>
      getDefaultMrtContainerProps({
        loading,
        layout: 'workspace',
        fullScreen: table.getState().isFullScreen,
        hasRows: containers.length > 0,
      }),
    state: {
      showAlertBanner: false,
      showProgressBars: loading,
      globalFilter: tableStateContext.globalFilter,
      columnVisibility: tableStateContext.columnVisibility,
      columnFilters: tableStateContext.columnFilters,
      density: tableStateContext.density,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function ContainersPage() {
  const [containers, setContainers] = useState<AiAgentContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setContainers(await listAiAgentContainers());
    } catch (loadError) {
      const message = `Не вдалося завантажити контейнери: ${errorMessage(loadError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setLoading(false);
    }
  }

  async function runAction(container: AiAgentContainer, action: 'start' | 'stop') {
    setActionId(container.id);
    try {
      if (action === 'start') await startAiAgentContainer(container.humanLoginId);
      else await stopAiAgentContainer(container.humanLoginId);
      notify({
        severity: 'success',
        message: action === 'start' ? 'Запуск контейнера розпочато.' : 'Контейнер зупинено.',
      });
      await load();
    } catch (actionError) {
      notify({
        severity: 'error',
        message: `Не вдалося змінити стан контейнера: ${errorMessage(actionError)}`,
      });
    } finally {
      setActionId(null);
    }
  }

  if (loading && containers.length === 0) return <PageLoadingState />;
  if (error && containers.length === 0)
    return <PageFailure message={error} onRetry={() => void load()} />;

  return (
    <TableStateProvider
      tableId="admin-ai-agent-containers"
      defaultColumnOrder={CONTAINERS_DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={CONTAINERS_DEFAULT_COLUMN_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <Stack spacing={2}>
        <TablePageToolbar
          title="Контейнери ШІ агентів"
          withGlobalTextFilter
          internalActionsDisabled={loading && containers.length === 0}
          actions={
            <PowerButton
              startIcon={<RefreshIcon />}
              variant="outlined"
              onClick={() => void load()}
              disabled={loading}
            >
              Оновити
            </PowerButton>
          }
        />
        {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
        <ContainersTable
          containers={containers}
          loading={loading}
          actionId={actionId}
          onAction={(container, action) => void runAction(container, action)}
        />
      </Stack>
    </TableStateProvider>
  );
}

function RequestDetailsDialog({
  request,
  onClose,
  onReviewRetried,
}: {
  request: AiAgentAuditRequestDetail | null;
  onClose: () => void;
  onReviewRetried: (request: AiAgentAuditRequestDetail) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const { notify } = usePowerSnackbar();

  async function retryReview() {
    if (!request) return;
    setRetrying(true);
    try {
      onReviewRetried(await retryAiAgentSecurityReview(request.id));
      notify({ severity: 'success', message: 'Повторну перевірку поставлено в чергу.' });
    } catch (retryError) {
      notify({
        severity: 'error',
        message: `Не вдалося повторити перевірку: ${errorMessage(retryError)}`,
      });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Dialog open={request !== null} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Запит {request?.id}</DialogTitle>
      <DialogContent dividers>
        {request ? (
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} flexWrap="wrap">
              <Chip size="small" label={request.state} color={statusColor(request.state)} />
              <Chip
                size="small"
                label={`Перевірка: ${request.reviewState}`}
                color={statusColor(request.reviewState)}
              />
              {request.severity ? (
                <Chip size="small" label={request.severity} color={statusColor(request.severity)} />
              ) : null}
            </Stack>
            <Box>
              <Typography variant="subtitle2">Запит користувача</Typography>
              <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {request.prompt}
              </Typography>
            </Box>
            <Box>
              <Typography variant="subtitle2">Відповідь</Typography>
              <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {request.response ?? '—'}
              </Typography>
            </Box>
            <Box>
              <Typography variant="subtitle2">
                Контекст розмови: {request.conversation.title}
              </Typography>
              <Stack spacing={1} sx={{ mt: 1 }}>
                {request.conversation.messages.map((message) => {
                  const selected = message.requestId === request.id;
                  return (
                    <Box
                      key={message.id}
                      sx={{
                        border: 1,
                        borderColor: selected ? 'primary.main' : 'divider',
                        borderRadius: 1,
                        bgcolor: selected ? 'action.selected' : 'background.default',
                        p: 1,
                      }}
                    >
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                        <Chip
                          size="small"
                          label={message.role === 'user' ? 'Користувач' : 'Асистент'}
                          color={message.role === 'user' ? 'info' : 'success'}
                        />
                        <Chip size="small" label={message.requestState} />
                        {selected ? (
                          <Chip size="small" label="Поточний запит" color="primary" />
                        ) : null}
                        <Typography variant="caption" color="text.secondary">
                          {formatDateTime(message.createdAt)}
                        </Typography>
                      </Stack>
                      <Typography
                        sx={{ mt: 0.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                      >
                        {message.content}
                      </Typography>
                    </Box>
                  );
                })}
              </Stack>
            </Box>
            {request.progress.length > 0 ? (
              <Box>
                <Typography variant="subtitle2">Прогрес</Typography>
                {request.progress.map((item, index) => (
                  <Typography key={`${index}-${item}`} variant="body2">
                    {item}
                  </Typography>
                ))}
              </Box>
            ) : null}
            {request.toolActivity.length > 0 ? (
              <Box>
                <Typography variant="subtitle2">Інструменти й API</Typography>
                {request.toolActivity.map((item, index) => (
                  <Typography key={`${index}-${item}`} variant="body2">
                    {item}
                  </Typography>
                ))}
              </Box>
            ) : null}
            <Box>
              <Typography variant="subtitle2">Безпекова перевірка</Typography>
              <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {request.reviewSummary ?? '—'}
              </Typography>
              {request.reviewCategories.length > 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Категорії: {request.reviewCategories.join(', ')}
                </Typography>
              ) : null}
              <Typography variant="body2" color="text.secondary">
                Спроб перевірки: {request.reviewAttemptCount}
              </Typography>
              {request.reviewLastError ? (
                <Typography variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>
                  {request.reviewLastError}
                </Typography>
              ) : null}
            </Box>
            <Box>
              <Typography variant="subtitle2">Mattermost сповіщення</Typography>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Chip
                  size="small"
                  label={request.alertState ?? 'не потрібне'}
                  color={statusColor(request.alertState ?? '')}
                />
                <Typography variant="body2" color="text.secondary">
                  Спроб: {request.alertAttemptCount}
                </Typography>
              </Stack>
              {request.alertLastError ? (
                <Typography variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>
                  {request.alertLastError}
                </Typography>
              ) : null}
            </Box>
            <Typography variant="body2" color="text.secondary">
              Створено: {formatDateTime(request.createdAt)} · Запущено:{' '}
              {formatDateTime(request.startedAt)} · Завершено: {formatDateTime(request.completedAt)}
            </Typography>
          </Stack>
        ) : null}
      </DialogContent>
      <DialogActions>
        {request?.reviewState === 'failed' ? (
          <PowerButton
            variant="outlined"
            disabled={retrying}
            startIcon={retrying ? <CircularProgress size={16} /> : undefined}
            onClick={() => void retryReview()}
          >
            Повторити перевірку
          </PowerButton>
        ) : null}
        <PowerButton variant="contained" onClick={onClose}>
          Закрити
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

const REQUESTS_DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'createdAt',
  'durationSeconds',
  'humanLogin',
  'providerName',
  'state',
  'reviewState',
  'prompt',
];
const REQUESTS_DEFAULT_COLUMN_VISIBILITY = {
  createdAt: true,
  durationSeconds: true,
  humanLogin: true,
  providerName: true,
  state: true,
  reviewState: true,
  prompt: true,
};

function RequestsTable({
  requests,
  loading,
  onView,
}: {
  requests: AiAgentAuditRequest[];
  loading: boolean;
  onView: (request: AiAgentAuditRequest) => void;
}) {
  const tableStateContext = useTableStateContext();
  const hasActiveRequest = requests.some(
    (request) => request.state === 'queued' || request.state === 'running',
  );
  const [durationNow, setDurationNow] = useState(Date.now());
  useEffect(() => {
    if (!hasActiveRequest) return;
    setDurationNow(Date.now());
    const interval = window.setInterval(() => setDurationNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [hasActiveRequest]);
  const columns = useMemo<AppMrtColumnDef<AiAgentAuditRequest>[]>(
    () => [
      {
        id: 'createdAt',
        accessorFn: (request) => formatDateTime(request.createdAt),
        header: 'Час',
        size: 180,
      },
      {
        id: 'durationSeconds',
        accessorFn: (request) => requestDurationSeconds(request, durationNow),
        header: 'Тривалість, с',
        size: 140,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => {
            const seconds = cell.getValue() as number | null;
            return seconds === null ? '—' : seconds.toLocaleString('uk-UA');
          },
          fullValue: ({ cell }) => {
            const seconds = cell.getValue() as number | null;
            return seconds === null ? '—' : seconds.toLocaleString('uk-UA');
          },
        }),
      },
      { accessorKey: 'humanLogin', header: 'Користувач', size: 180 },
      { accessorKey: 'providerName', header: 'Провайдер', size: 180 },
      {
        accessorKey: 'state',
        header: 'Стан',
        size: 140,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => (
          <Chip size="small" label={row.original.state} color={statusColor(row.original.state)} />
        ),
      },
      {
        accessorKey: 'reviewState',
        header: 'Перевірка',
        size: 180,
        meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
        Cell: mrtCustomCell(({ row }) => (
          <Stack direction="row" spacing={1} alignItems="center">
            <Chip
              size="small"
              label={row.original.reviewState}
              color={statusColor(row.original.reviewState)}
            />
            {row.original.severity ? (
              <Typography variant="body2">{row.original.severity}</Typography>
            ) : null}
          </Stack>
        )),
      },
      {
        accessorKey: 'prompt',
        header: 'Запит',
        size: 420,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => row.original.prompt,
          fullValue: ({ row }) => row.original.prompt,
        }),
      },
    ],
    [durationNow],
  );
  const table = useAppMaterialReactTable({
    ...getDefaultMRTOptions<AiAgentAuditRequest>(),
    columns,
    data: requests,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => (
      <MrtRowActions>
        <MrtRowActionButton
          label="Переглянути"
          icon={<VisibilityOutlinedIcon fontSize="small" />}
          onClick={() => onView(row.original)}
          opensModal
        />
      </MrtRowActions>
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
    defaultColumn: { size: 200, renderColumnActionsMenuItems },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: 56,
        minSize: 56,
        maxSize: 56,
      },
      'mrt-row-numbers': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        muiTableBodyCellProps: () => ({
          sx: { justifyContent: 'center', ...CUSTOM_CELL_STYLES },
        }),
      },
    },
    muiTablePaperProps: ({ table }) =>
      getDefaultMrtPaperProps({ table, loading, layout: 'workspace' }),
    muiTableContainerProps: ({ table }) =>
      getDefaultMrtContainerProps({
        loading,
        layout: 'workspace',
        fullScreen: table.getState().isFullScreen,
        hasRows: requests.length > 0,
      }),
    state: {
      showAlertBanner: false,
      showProgressBars: loading,
      globalFilter: tableStateContext.globalFilter,
      columnVisibility: tableStateContext.columnVisibility,
      columnFilters: tableStateContext.columnFilters,
      density: tableStateContext.density,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function RequestsPage() {
  const [requests, setRequests] = useState<AiAgentAuditRequest[]>([]);
  const [selected, setSelected] = useState<AiAgentAuditRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    const openDeepLink = () => {
      const requestId = readAiAgentRequestDeepLink();
      if (requestId) void openRequest(requestId);
    };
    void load().then(openDeepLink);
    window.addEventListener('popstate', openDeepLink);
    return () => window.removeEventListener('popstate', openDeepLink);
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setRequests(await listAiAgentAuditRequests());
    } catch (loadError) {
      const message = `Не вдалося завантажити запити: ${errorMessage(loadError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setLoading(false);
    }
  }

  async function openRequest(id: string) {
    try {
      setSelected(await getAiAgentAuditRequest(id));
    } catch (loadError) {
      notify({
        severity: 'error',
        message: `Не вдалося відкрити запит: ${errorMessage(loadError)}`,
      });
    }
  }

  if (loading && requests.length === 0) return <PageLoadingState />;
  if (error && requests.length === 0)
    return <PageFailure message={error} onRetry={() => void load()} />;

  return (
    <TableStateProvider
      tableId="admin-ai-agent-requests"
      defaultColumnOrder={REQUESTS_DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={REQUESTS_DEFAULT_COLUMN_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <Stack spacing={2}>
        <TablePageToolbar
          title="Запити ШІ агентів"
          withGlobalTextFilter
          internalActionsDisabled={loading && requests.length === 0}
          actions={
            <PowerButton
              startIcon={<RefreshIcon />}
              variant="outlined"
              onClick={() => void load()}
              disabled={loading}
            >
              Оновити
            </PowerButton>
          }
        />
        {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
        <RequestsTable
          requests={requests}
          loading={loading}
          onView={(request) => void openRequest(request.id)}
        />
        <RequestDetailsDialog
          request={selected}
          onClose={() => setSelected(null)}
          onReviewRetried={(next) => {
            setSelected(next);
            setRequests((current) => current.map((item) => (item.id === next.id ? next : item)));
          }}
        />
      </Stack>
    </TableStateProvider>
  );
}

const EMPTY_PROXY: AiAgentEchoProxy = {
  id: '',
  hostname: '',
  upstream: '',
  enabled: true,
  lastTestedAt: null,
  lastTestError: null,
};

function EchoProxyDialog({
  value,
  onClose,
  onSaved,
}: {
  value: AiAgentEchoProxy | null;
  onClose: () => void;
  onSaved: (proxy: AiAgentEchoProxy) => void;
}) {
  const [form, setForm] = useState(EMPTY_PROXY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    if (value) setForm(value);
  }, [value]);

  async function save() {
    if (!form.hostname.trim() || !form.upstream.trim()) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await saveAiAgentEchoProxy({
          ...form,
          hostname: form.hostname.trim(),
          upstream: form.upstream.trim(),
        }),
      );
    } catch (saveError) {
      const message = `Не вдалося зберегти проксі: ${errorMessage(saveError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={value !== null} onClose={() => !saving && onClose()} fullWidth maxWidth="sm">
      <DialogTitle>
        {form.id ? 'Редагувати зворотний проксі' : 'Додати зворотний проксі'}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          <TextField
            required
            label="Публічний hostname ECHO"
            value={form.hostname}
            onChange={(event) =>
              setForm((current) => ({ ...current, hostname: event.target.value }))
            }
          />
          <TextField
            required
            label="Upstream"
            placeholder="echo-staging:443"
            value={form.upstream}
            onChange={(event) =>
              setForm((current) => ({ ...current, upstream: event.target.value }))
            }
          />
          <FormControlLabel
            control={
              <Switch
                checked={form.enabled}
                onChange={(event) =>
                  setForm((current) => ({ ...current, enabled: event.target.checked }))
                }
              />
            }
            label="Увімкнено"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <PowerButton variant="outlined" onClick={onClose} disabled={saving}>
          Скасувати
        </PowerButton>
        <PowerButton
          variant="contained"
          onClick={() => void save()}
          disabled={saving || !form.hostname.trim() || !form.upstream.trim()}
          startIcon={saving ? <CircularProgress size={16} /> : undefined}
        >
          Зберегти
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

function EchoProxiesTable({
  proxies,
  loading,
  actionId,
  onEdit,
  onTest,
  onDelete,
}: {
  proxies: AiAgentEchoProxy[];
  loading: boolean;
  actionId: string | null;
  onEdit: (proxy: AiAgentEchoProxy) => void;
  onTest: (proxy: AiAgentEchoProxy) => void;
  onDelete: (proxy: AiAgentEchoProxy) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo<AppMrtColumnDef<AiAgentEchoProxy>[]>(
    () => [
      { accessorKey: 'hostname', header: 'Hostname', size: 260 },
      { accessorKey: 'upstream', header: 'Upstream', size: 260 },
      {
        id: 'enabled',
        accessorFn: (proxy) => (proxy.enabled ? 'Увімкнено' : 'Вимкнено'),
        header: 'Стан',
        size: 150,
      },
      {
        id: 'lastTestedAt',
        accessorFn: (proxy) => formatDateTime(proxy.lastTestedAt),
        header: 'Останній тест',
        size: 260,
        meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
        Cell: mrtCustomCell(({ row }) => (
          <Stack spacing={0.5} alignItems="flex-start">
            <Typography variant="body2">{formatDateTime(row.original.lastTestedAt)}</Typography>
            {row.original.lastTestError ? (
              <Typography variant="caption" color="error">
                {row.original.lastTestError}
              </Typography>
            ) : null}
          </Stack>
        )),
      },
    ],
    [],
  );
  const table = useAppMaterialReactTable({
    ...getDefaultMRTOptions<AiAgentEchoProxy>(),
    columns,
    data: proxies,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => (
      <Stack direction="row" spacing={0.5}>
        <MrtRowActionButton
          label="Редагувати"
          icon={<EditIcon fontSize="small" />}
          onClick={() => onEdit(row.original)}
          opensModal
        />
        <MrtRowActions forceMenu>
          <MrtRowActionButton
            label="Тест"
            icon={
              actionId === row.original.id ? (
                <CircularProgress size={16} />
              ) : (
                <NetworkCheckIcon fontSize="small" />
              )
            }
            onClick={() => onTest(row.original)}
            disabled={actionId === row.original.id}
          />
          <MrtRowActionButton
            label="Видалити"
            icon={<DeleteIcon fontSize="small" />}
            onClick={() => onDelete(row.original)}
            disabled={actionId === row.original.id}
            tone="danger"
          />
        </MrtRowActions>
      </Stack>
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
    defaultColumn: { size: 200, renderColumnActionsMenuItems },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: 76,
        minSize: 76,
        maxSize: 76,
        enableResizing: false,
      },
      'mrt-row-numbers': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        muiTableBodyCellProps: () => ({
          sx: { justifyContent: 'center', ...CUSTOM_CELL_STYLES },
        }),
      },
    },
    muiTablePaperProps: ({ table }) =>
      getDefaultMrtPaperProps({ table, loading, layout: 'workspace' }),
    muiTableContainerProps: ({ table }) =>
      getDefaultMrtContainerProps({
        loading,
        layout: 'workspace',
        fullScreen: table.getState().isFullScreen,
        hasRows: proxies.length > 0,
      }),
    state: {
      showAlertBanner: false,
      showProgressBars: loading,
      globalFilter: tableStateContext.globalFilter,
      columnVisibility: tableStateContext.columnVisibility,
      columnFilters: tableStateContext.columnFilters,
      density: tableStateContext.density,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: { ...tableStateContext.columnSizing, 'mrt-row-actions': 76 },
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function EchoProxiesPage() {
  const [proxies, setProxies] = useState<AiAgentEchoProxy[]>([]);
  const [editing, setEditing] = useState<AiAgentEchoProxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setProxies(await listAiAgentEchoProxies());
    } catch (loadError) {
      const message = `Не вдалося завантажити зворотні проксі: ${errorMessage(loadError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setLoading(false);
    }
  }

  async function test(proxy: AiAgentEchoProxy) {
    setActionId(proxy.id);
    try {
      const next = await testAiAgentEchoProxy(proxy.id);
      setProxies((current) => current.map((item) => (item.id === next.id ? next : item)));
      if (next.lastTestError) {
        notify({ severity: 'error', message: `Тест не пройдено: ${next.lastTestError}` });
      } else {
        notify({ severity: 'success', message: 'З’єднання з ECHO успішне.' });
      }
    } catch (testError) {
      notify({ severity: 'error', message: `Тест не пройдено: ${errorMessage(testError)}` });
    } finally {
      setActionId(null);
    }
  }

  async function remove(proxy: AiAgentEchoProxy) {
    if (!window.confirm(`Видалити проксі «${proxy.hostname}»?`)) return;
    setActionId(proxy.id);
    try {
      await deleteAiAgentEchoProxy(proxy.id);
      setProxies((current) => current.filter((item) => item.id !== proxy.id));
      notify({ severity: 'success', message: 'Зворотний проксі видалено.' });
    } catch (deleteError) {
      notify({
        severity: 'error',
        message: `Не вдалося видалити проксі: ${errorMessage(deleteError)}`,
      });
    } finally {
      setActionId(null);
    }
  }

  if (loading && proxies.length === 0) return <PageLoadingState />;
  if (error && proxies.length === 0)
    return <PageFailure message={error} onRetry={() => void load()} />;

  return (
    <TableStateProvider
      tableId="admin-ai-agent-echo-proxies"
      defaultColumnOrder={[
        'mrt-row-numbers',
        'mrt-row-actions',
        'hostname',
        'upstream',
        'enabled',
        'lastTestedAt',
      ]}
      defaultColumnVisibility={{
        hostname: true,
        upstream: true,
        enabled: true,
        lastTestedAt: true,
      }}
      defaultEnableColumnOrdering={false}
    >
      <Stack spacing={2}>
        <TablePageToolbar
          title="Зворотні проксі"
          titleInfo="Задають відповідність між публічним hostname ECHO та upstream, через яку контейнер агента підключається до конкретного сервера без прямого доступу до приватних або Tailscale-мереж. Додавання нових серверів описано в echo-ai-agent/DEPLOYMENT.md."
          withGlobalTextFilter
          internalActionsDisabled={loading && proxies.length === 0}
          actions={
            <PowerButton
              startIcon={<AddIcon />}
              variant="contained"
              onClick={() => setEditing({ ...EMPTY_PROXY })}
            >
              Додати
            </PowerButton>
          }
        />
        {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
        <EchoProxiesTable
          proxies={proxies}
          loading={loading}
          actionId={actionId}
          onEdit={setEditing}
          onTest={(proxy) => void test(proxy)}
          onDelete={(proxy) => void remove(proxy)}
        />
        <EchoProxyDialog
          value={editing}
          onClose={() => setEditing(null)}
          onSaved={(proxy) => {
            setProxies((current) => {
              const exists = current.some((item) => item.id === proxy.id);
              return exists
                ? current.map((item) => (item.id === proxy.id ? proxy : item))
                : [...current, proxy];
            });
            setEditing(null);
            notify({ severity: 'success', message: 'Зворотний проксі збережено.' });
          }}
        />
      </Stack>
    </TableStateProvider>
  );
}

function DispatcherPage() {
  const [dispatcher, setDispatcher] = useState<AiAgentDispatcher | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDispatcher(await getAiAgentDispatcher());
    } catch (loadError) {
      const message = `Не вдалося завантажити диспетчер: ${errorMessage(loadError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!dispatcher) return;
    setSaving(true);
    setError(null);
    try {
      setDispatcher(await saveAiAgentDispatcher(dispatcher));
      notify({ severity: 'success', message: 'Диспетчер збережено.' });
    } catch (saveError) {
      const message = `Не вдалося зберегти диспетчер: ${errorMessage(saveError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (!dispatcher) return;
    setTesting(true);
    setError(null);
    try {
      await saveAiAgentDispatcher(dispatcher);
      const tested = await testAiAgentDispatcher();
      setDispatcher(tested);
      if (tested.lastTestError) {
        notify({ severity: 'error', message: `Тест не пройдено: ${tested.lastTestError}` });
      } else {
        notify({ severity: 'success', message: 'З’єднання з диспетчером успішне.' });
      }
    } catch (testError) {
      const message = `Тест не пройдено: ${errorMessage(testError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <PageLoadingState />;
  if (!dispatcher)
    return <PageFailure message={error ?? 'Диспетчер не знайдено.'} onRetry={() => void load()} />;

  const busy = saving || testing;

  return (
    <Stack spacing={2}>
      <PageHeader
        title="Диспетчер"
        titleInfo="Керує захищеним SSH-з’єднанням цього ECHO з контейнерами на echo-ai-agent-vm. Створення ключа, окремого користувача та namespace описано в echo-ai-agent/DEPLOYMENT.md."
      />
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      {dispatcher.lastTestedAt ? (
        <PowerAlert severity={dispatcher.lastTestError ? 'error' : 'success'}>
          Остання перевірка: {formatDateTime(dispatcher.lastTestedAt)}
          {dispatcher.lastTestError ? ` — ${dispatcher.lastTestError}` : ' — успішно'}
        </PowerAlert>
      ) : null}
      <Card variant="outlined" sx={{ borderRadius: 0 }}>
        <CardContent>
          <Stack spacing={3}>
            <TextField
              fullWidth
              label="Хост"
              value={dispatcher.host}
              placeholder="echo-ai-agent-vm.eagle-atria.ts.net"
              disabled={busy}
              onChange={(event) =>
                setDispatcher((current) =>
                  current ? { ...current, host: event.target.value } : current,
                )
              }
            />
            <TextField
              fullWidth
              label="Порт"
              type="number"
              value={dispatcher.sshPort}
              disabled={busy}
              slotProps={{ htmlInput: { min: 1, max: 65535 } }}
              onChange={(event) =>
                setDispatcher((current) =>
                  current ? { ...current, sshPort: Number(event.target.value) } : current,
                )
              }
            />
            <TextField
              fullWidth
              label="Користувач SSH"
              value={dispatcher.sshUser}
              placeholder="echo-ai-agent-staging"
              disabled={busy}
              onChange={(event) =>
                setDispatcher((current) =>
                  current ? { ...current, sshUser: event.target.value } : current,
                )
              }
            />
            <TextField
              fullWidth
              label="Namespace"
              value={dispatcher.namespace}
              placeholder="echo-staging"
              disabled={busy}
              onChange={(event) =>
                setDispatcher((current) =>
                  current ? { ...current, namespace: event.target.value } : current,
                )
              }
            />
            <TextField
              fullWidth
              label="Приватний ключ"
              value={dispatcher.identityFile}
              error={!dispatcher.identityFilePresent}
              helperText={dispatcher.identityFilePresent ? 'Файл доступний' : 'Файл не знайдено'}
              slotProps={{ input: { readOnly: true } }}
            />
            <TextField
              fullWidth
              label="Known hosts"
              value={dispatcher.knownHostsFile}
              error={!dispatcher.knownHostsFilePresent}
              helperText={dispatcher.knownHostsFilePresent ? 'Файл доступний' : 'Файл не знайдено'}
              slotProps={{ input: { readOnly: true } }}
            />
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
              <PowerButton
                variant="outlined"
                disabled={busy}
                startIcon={testing ? <CircularProgress size={16} /> : <NetworkCheckIcon />}
                onClick={() => void test()}
              >
                Перевірити з’єднання
              </PowerButton>
              <PowerButton
                variant="contained"
                disabled={busy}
                startIcon={saving ? <CircularProgress size={16} /> : undefined}
                onClick={() => void save()}
              >
                Зберегти
              </PowerButton>
            </Box>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}

function providerName(engines: AiEngineItem[], id: string): string {
  return engines.find((engine) => engine.id === id)?.name ?? id;
}

function providerMenuItem(
  engine: AiEngineItem,
  options: {
    compatibility?: AiAgentEngineCompatibility;
    disabledReason?: string;
    showAgentTokenWarning?: boolean;
  } = {},
) {
  const compatibility = options.compatibility ?? getAiAgentEngineCompatibility(engine);
  const disabled = !compatibility.compatible || Boolean(options.disabledReason);
  const tokenNotice = getAiAgentTokenNotice(engine);

  return (
    <MenuItem key={engine.id} value={engine.id} disabled={disabled}>
      <Stack spacing={0.25} sx={{ py: 0.5, whiteSpace: 'normal' }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography>{engine.name}</Typography>
          <Chip
            size="small"
            label={compatibility.compatible ? 'Сумісний' : 'Несумісний'}
            color={compatibility.compatible ? 'success' : 'warning'}
          />
          {tokenNotice && options.showAgentTokenWarning !== false ? (
            <Tooltip title={tokenNotice.message} arrow>
              <Box
                component="span"
                aria-label={tokenNotice.message}
                sx={{ display: 'inline-flex', cursor: 'default', lineHeight: 0 }}
              >
                <InfoOutlinedIcon
                  color={tokenNotice.severity === 'warning' ? 'error' : 'info'}
                  sx={{ fontSize: 16 }}
                />
              </Box>
            </Tooltip>
          ) : null}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {options.disabledReason ?? compatibility.explanation}
        </Typography>
      </Stack>
    </MenuItem>
  );
}

function SettingsPage() {
  const [settings, setSettings] = useState<AiAgentSettings | null>(null);
  const [engines, setEngines] = useState<AiEngineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [nextSettings, nextEngines] = await Promise.all([
        getAiAgentSettings(),
        listAiEngines(),
      ]);
      setSettings(nextSettings);
      setEngines(nextEngines);
    } catch (loadError) {
      const message = `Не вдалося завантажити налаштування ШІ: ${errorMessage(loadError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await saveAiAgentSettings(settings));
      notify({ severity: 'success', message: 'Налаштування ШІ збережено.' });
    } catch (saveError) {
      const message = `Не вдалося зберегти налаштування: ${errorMessage(saveError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <PageLoadingState />;
  if (!settings)
    return (
      <PageFailure message={error ?? 'Налаштування не знайдено.'} onRetry={() => void load()} />
    );

  const showMattermostWebhook =
    settings.mattermostChatEnabled ||
    settings.reviewEnabled ||
    settings.mattermostWebhookConfigured ||
    settings.mattermostWebhookUrl.length > 0;

  return (
    <Stack spacing={2}>
      <PageHeader title="Налаштування ШІ агентів" />
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      <Card variant="outlined" sx={{ borderRadius: 0 }}>
        <CardContent>
          <Stack spacing={3}>
            <FormControlLabel
              control={
                <Switch
                  checked={settings.enabled}
                  onChange={(event) =>
                    setSettings((current) =>
                      current ? { ...current, enabled: event.target.checked } : current,
                    )
                  }
                />
              }
              label="Увімкнути ШІ чат"
            />
            <FormControl fullWidth>
              <InputLabel id="ai-agent-allowed-providers-label">Дозволені провайдери</InputLabel>
              <Select
                multiple
                labelId="ai-agent-allowed-providers-label"
                label="Дозволені провайдери"
                value={settings.allowedProviderIds}
                renderValue={(selected) =>
                  selected.map((id) => providerName(engines, id)).join(', ')
                }
                onChange={(event) =>
                  setSettings((current) =>
                    current
                      ? { ...current, allowedProviderIds: event.target.value as string[] }
                      : current,
                  )
                }
              >
                {engines.map((engine) => providerMenuItem(engine))}
              </Select>
            </FormControl>
            <FormControl fullWidth>
              <InputLabel id="ai-agent-default-provider-label">
                Провайдер за замовчуванням
              </InputLabel>
              <Select
                labelId="ai-agent-default-provider-label"
                label="Провайдер за замовчуванням"
                value={settings.defaultProviderId ?? ''}
                renderValue={(selected) =>
                  selected ? providerName(engines, selected as string) : 'Не вибрано'
                }
                onChange={(event) =>
                  setSettings((current) =>
                    current
                      ? { ...current, defaultProviderId: event.target.value || null }
                      : current,
                  )
                }
              >
                <MenuItem value="">Не вибрано</MenuItem>
                {engines.map((engine) =>
                  providerMenuItem(engine, {
                    disabledReason: settings.allowedProviderIds.includes(engine.id)
                      ? undefined
                      : 'Спочатку додайте провайдера до дозволених.',
                  }),
                )}
              </Select>
            </FormControl>
            <TextField
              label="UUID шаблонного логіна"
              value={settings.templateLoginId ?? ''}
              onChange={(event) =>
                setSettings((current) =>
                  current ? { ...current, templateLoginId: event.target.value || null } : current,
                )
              }
            />
            <FormControlLabel
              control={
                <Switch
                  checked={settings.reviewEnabled}
                  onChange={(event) =>
                    setSettings((current) =>
                      current ? { ...current, reviewEnabled: event.target.checked } : current,
                    )
                  }
                />
              }
              label="Асинхронна безпекова перевірка"
            />
            <FormControl fullWidth disabled={!settings.reviewEnabled}>
              <InputLabel id="ai-agent-reviewer-provider-label">Провайдер перевірки</InputLabel>
              <Select
                labelId="ai-agent-reviewer-provider-label"
                label="Провайдер перевірки"
                value={settings.reviewerProviderId ?? ''}
                renderValue={(selected) =>
                  selected ? providerName(engines, selected as string) : 'Не вибрано'
                }
                onChange={(event) =>
                  setSettings((current) =>
                    current
                      ? { ...current, reviewerProviderId: event.target.value || null }
                      : current,
                  )
                }
              >
                <MenuItem value="">Не вибрано</MenuItem>
                {engines.map((engine) =>
                  providerMenuItem(engine, {
                    compatibility: getAiReviewerEngineCompatibility(engine),
                    showAgentTokenWarning: false,
                  }),
                )}
              </Select>
            </FormControl>
            {settings.mattermostWebhookConfigured ? (
              <FormControlLabel
                control={
                  <Switch
                    checked={settings.clearMattermostWebhook}
                    onChange={(event) =>
                      setSettings((current) =>
                        current
                          ? {
                              ...current,
                              clearMattermostWebhook: event.target.checked,
                              mattermostChatEnabled: event.target.checked
                                ? false
                                : current.mattermostChatEnabled,
                              mattermostWebhookUrl: event.target.checked
                                ? ''
                                : current.mattermostWebhookUrl,
                            }
                          : current,
                      )
                    }
                  />
                }
                label="Очистити налаштований Mattermost webhook"
              />
            ) : null}
            <FormControlLabel
              control={
                <Switch
                  checked={settings.mattermostChatEnabled}
                  disabled={settings.clearMattermostWebhook}
                  onChange={(event) =>
                    setSettings((current) =>
                      current
                        ? { ...current, mattermostChatEnabled: event.target.checked }
                        : current,
                    )
                  }
                />
              }
              label="Надсилати запити ШІ чату до Mattermost"
            />
            <Typography variant="caption" color="text.secondary">
              Надсилає текст кожного запиту користувача, провайдера та посилання на аудит.
            </Typography>
            {showMattermostWebhook ? (
              <TextField
                type="url"
                label="Mattermost webhook"
                value={settings.mattermostWebhookUrl}
                disabled={settings.clearMattermostWebhook}
                placeholder={
                  settings.mattermostWebhookConfigured ? 'Налаштовано (введіть для заміни)' : ''
                }
                helperText="Порожнє поле зберігає наявний секрет без змін"
                onChange={(event) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          mattermostWebhookUrl: event.target.value,
                          clearMattermostWebhook: false,
                        }
                      : current,
                  )
                }
              />
            ) : null}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              <PowerButton
                variant="contained"
                disabled={saving}
                startIcon={saving ? <CircularProgress size={16} /> : undefined}
                onClick={() => void save()}
              >
                Зберегти
              </PowerButton>
            </Box>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}

export function AdminAiAgentPage({ section }: { section: AiAgentAdminSection }) {
  switch (section) {
    case 'providers':
      return <ProvidersPage />;
    case 'containers':
      return <ContainersPage />;
    case 'requests':
      return <RequestsPage />;
    case 'dispatcher':
      return <DispatcherPage />;
    case 'echo-proxies':
      return <EchoProxiesPage />;
    case 'callsigns':
      return <AdminAiCallsignsPage />;
    case 'settings':
      return <SettingsPage />;
  }
}
