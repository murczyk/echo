import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
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
  IconButton,
  InputLabel,
  MenuItem,
  Pagination,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { AdminAiPositionPage, AdminAiPositionsPage } from '../admin-ai-positions';
import { AdminAiSettlementsPage } from '../admin-ai-settlements';
import { AdminAiTranscriptAnalysisPage } from '../admin-ai-transcript-analysis';
import { AdminAiIntelReportsPage } from '../admin-ai-intel-reports';
import { AdminOcrPage } from '../admin-ocr';
import { AdminDocumentsPage } from '../admin-documents';
import { AiEnginesSection } from '../admin-system-settings-neo/AiEnginesSection';
import {
  type AiAgentEngineCompatibility,
  getAiAgentEngineCompatibility,
  getAiAgentTokenNotice,
  getAiReviewerEngineCompatibility,
} from './engine-eligibility';
import { MattermostWebhookField } from './MattermostWebhookField';
import { ProviderHealthEditor } from './ProviderHealthEditor';
import { errorMessage, formatDateTime, statusColor } from './format';
import { RequestDetailsDialog } from './request-details/RequestDetailsDialog';
import { RequestIdSearchField } from './RequestIdSearchField';
import {
  readAiAgentRequestDeepLink,
  readAiAgentRequestSearch,
  writeAiAgentRequestDeepLink,
  writeAiAgentRequestSearch,
} from './url-state';

export type AiAgentAdminSection =
  | 'providers'
  | 'containers'
  | 'requests'
  | 'dispatcher'
  | 'echo-proxies'
  | 'callsigns'
  | 'settlements'
  | 'transcript-analysis'
  | 'positions'
  | 'position'
  | 'intelligence-reports'
  | 'documents'
  | 'ocr'
  | 'settings';

export function requestDurationSeconds(
  request: Pick<AiAgentAuditRequest, 'createdAt' | 'completedAt' | 'state'>,
  now = Date.now(),
): number | null {
  const end =
    request.completedAt ?? (request.state === 'queued' || request.state === 'running' ? now : null);
  if (end === null || end < request.createdAt) return null;
  return Math.round((end - request.createdAt) / 100) / 10;
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
  firstRowIndex,
  onView,
}: {
  requests: AiAgentAuditRequest[];
  loading: boolean;
  firstRowIndex: number;
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
        Cell: ({ row }) => firstRowIndex + row.index + 1,
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
  const [pageStartIds, setPageStartIds] = useState<string[]>([]);
  const [pageSize, setPageSize] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [firstPage, setFirstPage] = useState(1);
  const loadVersion = useRef(0);
  const openVersion = useRef(0);
  const [searchId, setSearchId] = useState(() => readAiAgentRequestSearch());
  const searchRef = useRef(searchId);
  const [selected, setSelected] = useState<AiAgentAuditRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    const openDeepLink = () => {
      const requestId = readAiAgentRequestDeepLink();
      if (requestId) void openRequest(requestId);
      else closeRequest();
    };
    const onPopState = () => {
      const nextSearch = readAiAgentRequestSearch();
      if (nextSearch !== searchRef.current) search(nextSearch);
      openDeepLink();
    };
    void load().then(openDeepLink);
    window.addEventListener('popstate', onPopState);
    return () => {
      loadVersion.current += 1;
      openVersion.current += 1;
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  function search(nextSearch: string | null) {
    searchRef.current = nextSearch;
    setSearchId(nextSearch);
    void load();
  }

  async function load(nextPage = 1, append = false) {
    const version = ++loadVersion.current;
    setLoading(true);
    setError(null);
    try {
      const response = await listAiAgentAuditRequests(
        nextPage === 1 ? null : pageStartIds[nextPage - 1],
        searchRef.current,
      );
      if (version !== loadVersion.current) return;
      setRequests((current) => (append ? [...current, ...response.items] : response.items));
      if (response.pageStartIds !== null) {
        const starts = response.pageStartIds;
        setPageStartIds((current) => [
          ...current.slice(0, nextPage - 1),
          ...starts,
          ...(nextPage > 1 && starts.length === 2 && starts[1] === current[nextPage]
            ? current.slice(nextPage + 1)
            : []),
        ]);
      }
      setTotal(response.total);
      setPageSize(response.pageSize);
      setPage(nextPage);
      if (!append) setFirstPage(nextPage);
    } catch (loadError) {
      if (version !== loadVersion.current) return;
      const message = `Не вдалося завантажити запити: ${errorMessage(loadError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }

  function closeRequest() {
    openVersion.current += 1;
    setSelected(null);
  }

  async function openRequest(id: string, updateUrl = false) {
    const version = ++openVersion.current;
    try {
      const request = await getAiAgentAuditRequest(id);
      if (version !== openVersion.current) return;
      if (updateUrl) writeAiAgentRequestDeepLink(id);
      setSelected(request);
    } catch (loadError) {
      if (version !== openVersion.current) return;
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
          filter={
            <RequestIdSearchField
              value={searchId}
              onSearch={(nextSearch) => {
                writeAiAgentRequestSearch(nextSearch);
                search(nextSearch);
              }}
            />
          }
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
          firstRowIndex={(firstPage - 1) * pageSize}
          onView={(request) => void openRequest(request.id, true)}
        />
        <Stack spacing={1} alignItems="center">
          {page < pageStartIds.length ? (
            <PowerButton
              variant="outlined"
              disabled={loading}
              onClick={() => void load(page + 1, true)}
            >
              SHOW MORE
            </PowerButton>
          ) : null}
          {pageStartIds.length > 1 ? (
            <Pagination
              count={pageStartIds.length}
              page={page}
              disabled={loading}
              onChange={(_, nextPage) => void load(nextPage)}
            />
          ) : null}
          {total !== null ? (
            <Typography variant="body2" color="text.secondary">
              Усього: {total}
            </Typography>
          ) : null}
        </Stack>
        <RequestDetailsDialog
          request={selected}
          onClose={() => {
            writeAiAgentRequestDeepLink(null);
            closeRequest();
          }}
          onRequestUpdated={(next) => {
            setSelected((current) => (current?.id === next.id ? next : current));
            setRequests((current) => current.map((item) => (item.id === next.id ? next : item)));
          }}
          onOpenRequest={(id) => void openRequest(id, true)}
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

type ProviderRuntimeProfile = AiAgentSettings['providerRuntimeProfiles'][number];

function defaultProviderRuntimeProfile(engine: AiEngineItem): ProviderRuntimeProfile {
  return { ...defaultProviderRuntimeLimits(engine), visionInputEnabled: false };
}

function defaultProviderRuntimeLimits(
  engine: AiEngineItem,
): Omit<ProviderRuntimeProfile, 'visionInputEnabled'> {
  const modelName = engine.modelName.toLowerCase();
  if (modelName === 'gpt-6-sol') {
    return {
      aiEngineId: engine.id,
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 65_536,
      compactionReserveTokens: 131_072,
      compactionKeepRecentTokens: 49_152,
    };
  }
  if (modelName === 'gpt-6-luna') {
    return {
      aiEngineId: engine.id,
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 32_768,
      compactionReserveTokens: 131_072,
      compactionKeepRecentTokens: 32_768,
    };
  }
  if (modelName === 'gpt-5.6-sol') {
    return {
      aiEngineId: engine.id,
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 65_536,
      compactionReserveTokens: 98_304,
      compactionKeepRecentTokens: 49_152,
    };
  }
  if (modelName === 'gpt-5.6-luna') {
    return {
      aiEngineId: engine.id,
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 32_768,
      compactionReserveTokens: 65_536,
      compactionKeepRecentTokens: 32_768,
    };
  }
  if (modelName === 'google/gemma-4-26b-a4b-it') {
    return {
      aiEngineId: engine.id,
      contextWindowTokens: 262_144,
      maxOutputTokens: 16_384,
      compactionReserveTokens: 32_768,
      compactionKeepRecentTokens: 16_384,
    };
  }
  return {
    aiEngineId: engine.id,
    contextWindowTokens: 131_072,
    maxOutputTokens: 16_384,
    compactionReserveTokens: 32_768,
    compactionKeepRecentTokens: 16_384,
  };
}

function ensureProviderRuntimeProfiles(
  settings: AiAgentSettings,
  engines: AiEngineItem[],
  allowedProviderIds = settings.allowedProviderIds,
): AiAgentSettings {
  const profiles = new Map(
    settings.providerRuntimeProfiles.map((profile) => [profile.aiEngineId, profile]),
  );
  for (const aiEngineId of allowedProviderIds) {
    const engine = engines.find((candidate) => candidate.id === aiEngineId);
    if (engine && !profiles.has(aiEngineId)) {
      profiles.set(aiEngineId, defaultProviderRuntimeProfile(engine));
    }
  }
  return {
    ...settings,
    allowedProviderIds,
    providerRuntimeProfiles: Array.from(profiles.values()),
  };
}

function ProviderRuntimeProfilesEditor({
  settings,
  engines,
  onChange,
  onEngineSaved,
}: {
  settings: AiAgentSettings;
  engines: AiEngineItem[];
  onChange: (settings: AiAgentSettings) => void;
  onEngineSaved: (engine: AiEngineItem) => void;
}) {
  function move(aiEngineId: string, offset: -1 | 1) {
    const ids = [...settings.allowedProviderIds];
    const index = ids.indexOf(aiEngineId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    onChange({ ...settings, allowedProviderIds: ids });
  }

  function updateProfile<K extends keyof Omit<ProviderRuntimeProfile, 'aiEngineId'>>(
    aiEngineId: string,
    field: K,
    value: ProviderRuntimeProfile[K],
  ) {
    onChange({
      ...settings,
      providerRuntimeProfiles: settings.providerRuntimeProfiles.map((profile) =>
        profile.aiEngineId === aiEngineId ? { ...profile, [field]: value } : profile,
      ),
    });
  }

  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2">Runtime-профілі провайдерів</Typography>
      <Typography variant="caption" color="text.secondary">
        Порядок визначає список у ШІ-чаті та модель, яку чат пропонує після збою провайдера чи
        відмови моделі.
      </Typography>
      {settings.allowedProviderIds.map((aiEngineId, index) => {
        const engine = engines.find((candidate) => candidate.id === aiEngineId);
        const profile = settings.providerRuntimeProfiles.find(
          (candidate) => candidate.aiEngineId === aiEngineId,
        );
        if (!engine || !profile) return null;
        return (
          <Card key={aiEngineId} variant="outlined" sx={{ borderRadius: 0 }}>
            <CardContent>
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} alignItems="flex-start">
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="subtitle2">
                      {index + 1}. {engine.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {engine.modelName}
                    </Typography>
                  </Box>
                  <Tooltip title="Вище">
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`Перемістити ${engine.name} вище`}
                        disabled={index === 0}
                        onClick={() => move(aiEngineId, -1)}
                      >
                        <ArrowUpwardIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title="Нижче">
                    <span>
                      <IconButton
                        size="small"
                        aria-label={`Перемістити ${engine.name} нижче`}
                        disabled={index === settings.allowedProviderIds.length - 1}
                        onClick={() => move(aiEngineId, 1)}
                      >
                        <ArrowDownwardIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>
                <ProviderHealthEditor engine={engine} onSaved={onEngineSaved} />
                <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5}>
                  <TextField
                    fullWidth
                    type="number"
                    label="Контекст, токенів"
                    value={profile.contextWindowTokens}
                    onChange={(event) =>
                      updateProfile(aiEngineId, 'contextWindowTokens', Number(event.target.value))
                    }
                  />
                  <TextField
                    fullWidth
                    type="number"
                    label="Макс. відповідь, токенів"
                    value={profile.maxOutputTokens}
                    onChange={(event) =>
                      updateProfile(aiEngineId, 'maxOutputTokens', Number(event.target.value))
                    }
                  />
                  <TextField
                    fullWidth
                    type="number"
                    label="Резерв стиснення"
                    value={profile.compactionReserveTokens}
                    onChange={(event) =>
                      updateProfile(
                        aiEngineId,
                        'compactionReserveTokens',
                        Number(event.target.value),
                      )
                    }
                  />
                  <TextField
                    fullWidth
                    type="number"
                    label="Зберегти останні токени"
                    value={profile.compactionKeepRecentTokens}
                    onChange={(event) =>
                      updateProfile(
                        aiEngineId,
                        'compactionKeepRecentTokens',
                        Number(event.target.value),
                      )
                    }
                  />
                </Stack>
                <FormControlLabel
                  control={
                    <Switch
                      checked={profile.visionInputEnabled ?? false}
                      onChange={(event) =>
                        updateProfile(aiEngineId, 'visionInputEnabled', event.target.checked)
                      }
                    />
                  }
                  label="Модель приймає зображення (вкладені фото передаються напряму)"
                />
              </Stack>
            </CardContent>
          </Card>
        );
      })}
    </Stack>
  );
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
      setSettings(ensureProviderRuntimeProfiles(nextSettings, nextEngines));
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
    settings.reviewEnabled ||
    settings.mattermostWebhookConfigured ||
    settings.mattermostWebhookUrl.length > 0;
  const showMattermostChatWebhook =
    settings.mattermostChatEnabled ||
    settings.mattermostChatWebhookConfigured ||
    settings.mattermostChatWebhookUrl.length > 0;

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
                      ? ensureProviderRuntimeProfiles(
                          current,
                          engines,
                          event.target.value as string[],
                        )
                      : current,
                  )
                }
              >
                {engines.map((engine) => providerMenuItem(engine))}
              </Select>
            </FormControl>
            <ProviderRuntimeProfilesEditor
              settings={settings}
              engines={engines}
              onChange={setSettings}
              onEngineSaved={(saved) =>
                setEngines((current) =>
                  current.map((engine) => (engine.id === saved.id ? saved : engine)),
                )
              }
            />
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
            <FormControlLabel
              control={
                <Switch
                  checked={settings.mattermostChatEnabled}
                  disabled={settings.clearMattermostChatWebhook}
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
              <MattermostWebhookField
                label="Mattermost webhook безпекових сповіщень"
                configured={settings.mattermostWebhookConfigured}
                value={settings.mattermostWebhookUrl}
                clear={settings.clearMattermostWebhook}
                onChange={(value) =>
                  setSettings((current) =>
                    current
                      ? { ...current, mattermostWebhookUrl: value, clearMattermostWebhook: false }
                      : current,
                  )
                }
                onClear={(clear) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          clearMattermostWebhook: clear,
                          mattermostWebhookUrl: clear ? '' : current.mattermostWebhookUrl,
                        }
                      : current,
                  )
                }
              />
            ) : null}
            {showMattermostChatWebhook ? (
              <MattermostWebhookField
                label="Mattermost webhook діалогів"
                configured={settings.mattermostChatWebhookConfigured}
                value={settings.mattermostChatWebhookUrl}
                clear={settings.clearMattermostChatWebhook}
                onChange={(value) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          mattermostChatWebhookUrl: value,
                          clearMattermostChatWebhook: false,
                        }
                      : current,
                  )
                }
                onClear={(clear) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          clearMattermostChatWebhook: clear,
                          mattermostChatEnabled: clear ? false : current.mattermostChatEnabled,
                          mattermostChatWebhookUrl: clear ? '' : current.mattermostChatWebhookUrl,
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

export function AdminAiAgentPage({
  section,
  itemId = null,
  tab = null,
}: {
  section: AiAgentAdminSection;
  itemId?: string | null;
  tab?: string | null;
}) {
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
    case 'settlements':
      return <AdminAiSettlementsPage />;
    case 'transcript-analysis':
      return <AdminAiTranscriptAnalysisPage />;
    case 'positions':
      return <AdminAiPositionsPage tab={tab} />;
    case 'position':
      return <AdminAiPositionPage id={itemId} />;
    case 'intelligence-reports':
      return <AdminAiIntelReportsPage />;
    case 'documents':
      return <AdminDocumentsPage />;
    case 'ocr':
      return <AdminOcrPage />;
    case 'settings':
      return <SettingsPage />;
  }
}
