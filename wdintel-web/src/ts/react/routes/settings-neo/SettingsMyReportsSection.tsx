import DownloadIcon from '@mui/icons-material/DownloadOutlined';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import ReplayIcon from '@mui/icons-material/ReplayOutlined';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Typography,
  Tooltip,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type MRT_ColumnDef, type MRT_ColumnFiltersState, type MRT_SortingState } from 'material-react-table';

import type { ReportHistoryRow } from '../../../../Bindings';
import { downloadBlob } from '../../utils/download-blob';
import { formatErrorMessage } from '../rer-network-details-neo/use-rer-network-details-neo-page.helpers';
import { cancelReportHistory, downloadReportHistory, isCancelledReportHistory, listReportHistory, retryReportHistory, type ReportHistoryBatchRsp } from '../../services/api/report-history';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PowerAlert } from '../../components/PowerAlert';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { SettingsNeoTable } from './SettingsNeoTable';
import { CUSTOM_CELL_STYLES } from '../../components/mui-customized/table/custom-styles';
import { MrtRowActionButton, MrtRowActions, mrtRowActionsColumnSize } from '../../components/MrtRowActionButton';
import { InternalTableActions } from '../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';

type LoadState = 'idle' | 'loading' | 'success' | 'error';

type LoadReportHistory = (options?: { signal?: AbortSignal }) => Promise<ReportHistoryRow[]>;

type ReportHistoryQueryState = {
  globalFilter: string;
  columnFilters: MRT_ColumnFiltersState;
  sorting: MRT_SortingState;
};

type LoadReportHistoryBatch = (
  req: ReportHistoryQueryState & { offset: number; limit: number },
  options?: { signal?: AbortSignal },
) => Promise<ReportHistoryBatchRsp>;

type Props = {
  active: boolean;
};

export type ReportHistoryTableSectionProps = {
  active: boolean;
  title: string;
  tableId: string;
  panelId?: string;
  labelledBy?: string;
  includeAuthor?: boolean;
  fullHeight?: boolean;
  showReportCount?: boolean;
  loadReportHistory?: LoadReportHistory;
  loadReportHistoryBatch?: LoadReportHistoryBatch;
};

const DEFAULT_REPORTS_COLUMNS_VISIBILITY = {
  actions: true,
  reportKind: true,
  details: true,
  createdAt: true,
  status: true,
  plannedForTs: false,
  startedAt: false,
  queuePosition: true,
  bgtaskId: false,
  completedAt: false,
};

const DEFAULT_REPORTS_COLUMN_ORDER = [
  'mrt-row-numbers',
  'actions',
  'reportKind',
  'details',
  'createdAt',
  'status',
  'plannedForTs',
  'startedAt',
  'queuePosition',
  'bgtaskId',
  'completedAt',
];

const DEFAULT_REPORTS_WITH_AUTHOR_COLUMNS_VISIBILITY = {
  ...DEFAULT_REPORTS_COLUMNS_VISIBILITY,
  requestedBy: true,
  errorLog: true,
};

const DEFAULT_REPORTS_WITH_AUTHOR_COLUMN_ORDER = [
  'mrt-row-numbers',
  'actions',
  'reportKind',
  'requestedBy',
  'details',
  'createdAt',
  'status',
  'plannedForTs',
  'startedAt',
  'queuePosition',
  'bgtaskId',
  'completedAt',
  'errorLog',
];

const DEFAULT_REPORTS_SORTING: MRT_SortingState = [{ id: 'createdAt', desc: true }];

const REPORTS_FULL_HEIGHT_ROOT_SX = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  boxSizing: 'border-box',
} as const;

const REPORTS_FULL_HEIGHT_CONTENT_SX = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  boxSizing: 'border-box',
} as const;

const REPORTS_FULL_HEIGHT_STACK_SX = {
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
} as const;

const REPORTS_TABLE_WRAPPER_SX = {
  width: '100%',
  minWidth: 0,
  overflow: 'hidden',
} as const;

const REPORTS_FULL_HEIGHT_TABLE_WRAPPER_SX = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
} as const;

const REPORT_LOADING_ROW_COUNT = 8;
const REPORT_HISTORY_BATCH_SIZE = 200;

const REPORTS_LOADING_TABLE_WRAPPER_SX = {
  height: 384,
  minHeight: 384,
  maxHeight: 384,
} as const;

const REPORT_STATUS_LABELS: Record<string, string> = {
  planned: 'Очікує запуску',
  in_progress: 'Формується',
  done: 'Готово',
  failed: 'Помилка',
};

const REPORT_KIND_LABELS: Record<string, string> = {
  tags: 'З донесенням',
  pelengs: 'Пеленги',
  babak: 'Бабак',
  interception: 'Перехоплення',
  senders: 'Відправники',
  posts: 'Пости',
  posts_docx: 'Пости',
  mouse: 'Мишка',
  reo: 'РЕО',
  digest: 'Дайджест',
  rer_report: 'РЕР Звіт',
  active_networks: 'Активні радіомережі',
  network_frequencies: 'Частоти Радіомереж',
  report_1213: 'Звіт 1.2.13',
  summary_table: 'Підсумкова таблиця',
  kmz: 'KMZ',
  geojson: 'GeoJSON',
  etalonka: 'Еталонний опис',
  goi: 'Звіт ГОІ',
  legacy: 'Звіт',
};

function formatReportDate(value: string | null): string {
  if (value === null || value.trim() === '') return '';
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('uk-UA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatReportDateOrDash(value: string | null | undefined): string {
  return formatReportDate(value ?? null) || '—';
}

function formatReportId(value: number | null | undefined): string {
  return value == null ? '—' : `#${value}`;
}

function statusColor(status: string): 'default' | 'primary' | 'success' | 'error' | 'warning' {
  if (status === 'done') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'in_progress') return 'primary';
  if (status === 'planned') return 'warning';
  return 'default';
}

function formatReportKind(reportKind: string): string {
  return REPORT_KIND_LABELS[reportKind] ?? '???';
}

function formatReportProgress(progress: number): string {
  return `${Math.max(0, Math.min(100, Math.round(progress)))}%`;
}

function formatReportStatus(row: ReportHistoryRow): string {
  if (isCancelledReportHistory(row)) {
    return 'Скасовано';
  }
  if (row.status === 'planned' && row.blockedByReportId != null) {
    return `Очікує завершення звіту #${row.blockedByReportId}`;
  }
  const label = REPORT_STATUS_LABELS[row.status] ?? row.status;
  if (row.status !== 'in_progress') return label;
  return `${label} ${formatReportProgress(row.progress)}`;
}

function buildReportLoadingRows(): ReportHistoryRow[] {
  return Array.from({ length: REPORT_LOADING_ROW_COUNT }, (_, index) => ({
    id: -index - 1,
    reportKind: '',
    requestedBy: '',
    createdAt: '',
    status: 'planned',
    completedAt: null,
    hasFile: false,
    fileName: null,
    contentType: null,
    bgtaskId: null,
    lastError: null,
    isCancelled: false,
    details: '',
    progress: 0,
    errorLog: null,
    startedAt: null,
    plannedForTs: null,
    queuePosition: null,
    blockedByReportId: null,
    blockedByStartedAt: null,
    blockedByBgtaskId: null,
  }));
}

export const REPORT_CANCEL_RUNNING_WARNING =
  'Звіт буде скасовано в черзі. Якщо зараз виконується довгий запит, він може завершитись перед повною зупинкою.';

function canCancelReport(row: ReportHistoryRow): boolean {
  return row.status === 'planned' || row.status === 'in_progress';
}

function ReportHistoryRowActions({
  row,
  onDownload,
  onRetry,
  onCancel,
}: {
  row: ReportHistoryRow;
  onDownload: (row: ReportHistoryRow) => void;
  onRetry: (row: ReportHistoryRow) => void;
  onCancel: (row: ReportHistoryRow) => void;
}) {
  const isCancelled = isCancelledReportHistory(row);
  const hasActions = (row.status === 'done' && row.hasFile) || (row.status === 'failed' && !isCancelled) || canCancelReport(row);
  if (!hasActions) {
    return null;
  }

  return (
    <MrtRowActions forceMenu>
      {row.status === 'done' && row.hasFile ? (
        <MrtRowActionButton label="Завантажити" icon={<DownloadIcon fontSize="small" />} onClick={() => onDownload(row)} />
      ) : null}
      {row.status === 'failed' && !isCancelled ? (
        <MrtRowActionButton label="Повторити" icon={<ReplayIcon fontSize="small" />} tone="warning" onClick={() => onRetry(row)} />
      ) : null}
      {canCancelReport(row) ? (
        <MrtRowActionButton label="Скасувати" icon={<CancelOutlinedIcon fontSize="small" />} tone="danger" opensModal onClick={() => onCancel(row)} />
      ) : null}
    </MrtRowActions>
  );
}

export function SettingsMyReportsSection({ active }: Props) {
  return (
    <ReportHistoryTableSection
      active={active}
      title="Мої звіти"
      tableId="settings-neo-my-reports-v3"
      panelId="settings-neo-panel-my-reports"
      labelledBy="settings-neo-tab-my-reports"
    />
  );
}

export function ReportHistoryTableSection({
  active,
  title,
  tableId,
  panelId,
  labelledBy,
  includeAuthor = false,
  fullHeight = false,
  showReportCount = false,
  loadReportHistory = listReportHistory,
  loadReportHistoryBatch,
}: ReportHistoryTableSectionProps) {
  const [rows, setRows] = useState<ReportHistoryRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorLogRow, setErrorLogRow] = useState<ReportHistoryRow | null>(null);
  const [cancelRow, setCancelRow] = useState<ReportHistoryRow | null>(null);
  const [queryState, setQueryState] = useState<ReportHistoryQueryState>({
    globalFilter: '',
    columnFilters: [],
    sorting: DEFAULT_REPORTS_SORTING,
  });
  const [totalRows, setTotalRows] = useState<number | null>(null);
  const [hasMoreRows, setHasMoreRows] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadRows = useCallback(async (signal?: AbortSignal, append = false, offset = 0) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoadState((current) => (current === 'success' ? current : 'loading'));
    }
    setError(null);
    try {
      if (loadReportHistoryBatch) {
        const rsp = await loadReportHistoryBatch(
          { ...queryState, offset, limit: REPORT_HISTORY_BATCH_SIZE },
          signal ? { signal } : undefined,
        );
        setRows((current) => (append ? [...current, ...rsp.rows] : rsp.rows));
        setTotalRows(rsp.total);
        setHasMoreRows(rsp.hasMore);
        setNextOffset(rsp.nextOffset);
      } else {
        const nextRows = await loadReportHistory(signal ? { signal } : undefined);
        setRows(nextRows);
        setTotalRows(nextRows.length);
        setHasMoreRows(false);
        setNextOffset(nextRows.length);
      }
      setLoadState('success');
    } catch (loadError) {
      if (signal?.aborted) return;
      if (!append) {
        setRows([]);
        setLoadState('error');
      }
      setError(formatErrorMessage(loadError));
    } finally {
      setLoadingMore(false);
    }
  }, [loadReportHistory, loadReportHistoryBatch, queryState]);

  useEffect(() => {
    if (!active) return;
    const abortController = new AbortController();
    void loadRows(abortController.signal);
    return () => {
      abortController.abort();
    };
  }, [active, loadRows]);

  useEffect(() => {
    if (!active || loadReportHistoryBatch) return;
    let stopped = false;
    let timeoutId: number | null = null;
    let abortController: AbortController | null = null;

    const poll = async () => {
      abortController?.abort();
      abortController = new AbortController();
      await loadRows(abortController.signal);
      if (!stopped) {
        timeoutId = window.setTimeout(poll, 5000);
      }
    };

    timeoutId = window.setTimeout(poll, 5000);
    return () => {
      stopped = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      abortController?.abort();
    };
  }, [active, loadReportHistoryBatch, loadRows]);

  useEffect(() => {
    if (!active) {
      setRows([]);
      setLoadState('idle');
      setError(null);
      setErrorLogRow(null);
      setCancelRow(null);
      setTotalRows(null);
      setHasMoreRows(false);
      setNextOffset(0);
      setLoadingMore(false);
    }
  }, [active]);

  const handleQueryStateChange = useCallback((nextQueryState: ReportHistoryQueryState) => {
    setQueryState((current) => (JSON.stringify(current) === JSON.stringify(nextQueryState) ? current : nextQueryState));
  }, []);

  const handleLoadMore = useCallback(() => {
    if (!loadReportHistoryBatch || loadingMore || !hasMoreRows) return;
    void loadRows(undefined, true, nextOffset);
  }, [hasMoreRows, loadReportHistoryBatch, loadingMore, loadRows, nextOffset]);

  async function handleDownload(row: ReportHistoryRow) {
    if (!row.hasFile || row.status !== 'done') return;
    try {
      const blob = await downloadReportHistory(row.id);
      downloadBlob(blob, row.fileName ?? `report-${row.id}`);
    } catch (downloadError) {
      setError(formatErrorMessage(downloadError));
    }
  }

  async function handleRetry(row: ReportHistoryRow) {
    if (row.status !== 'failed') return;
    try {
      const updated = await retryReportHistory(row.id);
      setRows((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (retryError) {
      setError(formatErrorMessage(retryError));
    }
  }

  async function handleCancel(row: ReportHistoryRow) {
    if (!canCancelReport(row)) return;
    if (row.status === 'in_progress') {
      setCancelRow(row);
      return;
    }

    try {
      const updated = await cancelReportHistory(row.id);
      setRows((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (cancelError) {
      setError(formatErrorMessage(cancelError));
    }
  }

  async function confirmCancelInFlightRow() {
    if (cancelRow === null) return;
    const row = cancelRow;
    setCancelRow(null);
    try {
      const updated = await cancelReportHistory(row.id);
      setRows((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (cancelError) {
      setError(formatErrorMessage(cancelError));
    }
  }

  const columns = useMemo<MRT_ColumnDef<ReportHistoryRow>[]>(
    () => {
      const nextColumns: MRT_ColumnDef<ReportHistoryRow>[] = [
        {
          id: 'actions',
          header: 'Дії',
          size: mrtRowActionsColumnSize(1),
          minSize: mrtRowActionsColumnSize(1),
          maxSize: mrtRowActionsColumnSize(1),
          enableSorting: false,
          enableColumnActions: false,
          enableColumnFilter: false,
          enableColumnOrdering: false,
          enableResizing: false,
          enableHiding: false,
          muiTableHeadCellProps: {
            sx: {
              ...CUSTOM_CELL_STYLES,
              justifyContent: 'center',
              display: 'flex',
              flexDirection: 'row',
              padding: '10px!important',
              minHeight: '56px',
              backgroundColor: 'var(--bs-body-bg)',
              '& .Mui-TableHeadCell-Content': {
                width: '100%',
                minHeight: '28px',
                justifyContent: 'center',
              },
              '& .Mui-TableHeadCell-Content-Labels': {
                flex: 1,
                justifyContent: 'center',
              },
              '& .Mui-TableHeadCell-Content-Wrapper': {
                width: '100%',
                textAlign: 'center',
              },
              '& .Mui-TableHeadCell-ResizeHandle-Wrapper': {
                display: 'none',
              },
            },
          },
          muiTableBodyCellProps: {
            sx: {
              ...CUSTOM_CELL_STYLES,
              justifyContent: 'center',
              display: 'flex',
              padding: '10px!important',
            },
          },
          Cell: ({ row }) => (
            <ReportHistoryRowActions
              row={row.original}
              onDownload={(report) => void handleDownload(report)}
              onRetry={(report) => void handleRetry(report)}
              onCancel={(report) => void handleCancel(report)}
            />
          ),
        },
        {
          id: 'reportKind',
          accessorFn: (row) => formatReportKind(row.reportKind),
          header: 'Вид',
          Cell: ({ row }) => formatReportKind(row.original.reportKind),
        },
        {
          accessorKey: 'details',
          header: 'Деталі',
          enableSorting: false,
          enableColumnFilter: false,
          Cell: ({ row }) =>
            row.original.details ? (
              <Tooltip title={row.original.details}>
                <Typography component="span" variant="body2">
                  {row.original.details}
                </Typography>
              </Tooltip>
            ) : null,
        },
      ];

      if (includeAuthor) {
        nextColumns.push(
          {
            accessorKey: 'requestedBy',
            header: 'Автор',
            Cell: ({ row }) => row.original.requestedBy,
          },
          {
            id: 'errorLog',
            accessorFn: (row) => (row.errorLog && row.errorLog.length > 0 ? 'Переглянути' : ''),
            header: 'Помилки',
            enableSorting: false,
            enableColumnFilter: false,
            Cell: ({ row }) => {
              if (!row.original.errorLog || row.original.errorLog.length === 0) return null;
              return (
                <Button size="small" variant="outlined" onClick={() => setErrorLogRow(row.original)}>
                  Переглянути
                </Button>
              );
            },
          },
        );
      }

      nextColumns.push(
        {
          accessorKey: 'createdAt',
          header: 'Створено',
          Cell: ({ row }) => formatReportDate(row.original.createdAt),
        },
        {
          id: 'status',
          accessorFn: (row) => formatReportStatus(row),
          header: 'Статус',
          Cell: ({ row }) => {
            const chip = (
              <Chip
                size="small"
                color={statusColor(row.original.status)}
                label={formatReportStatus(row.original)}
                variant={row.original.status === 'planned' ? 'outlined' : 'filled'}
              />
            );
            if (!includeAuthor || row.original.status !== 'failed' || isCancelledReportHistory(row.original) || !row.original.lastError) {
              return chip;
            }
            return <Tooltip title={row.original.lastError}>{chip}</Tooltip>;
          },
        },
        {
          accessorKey: 'plannedForTs',
          header: 'План',
          Cell: ({ row }) => formatReportDateOrDash(row.original.plannedForTs),
        },
        {
          accessorKey: 'startedAt',
          header: 'Почато',
          Cell: ({ row }) => formatReportDateOrDash(row.original.startedAt),
        },
        {
          accessorKey: 'queuePosition',
          header: 'Черга',
          Cell: ({ row }) => formatReportId(row.original.queuePosition),
        },
        {
          accessorKey: 'bgtaskId',
          header: 'ID задачі',
          Cell: ({ row }) => formatReportId(row.original.bgtaskId),
        },
        {
          accessorKey: 'completedAt',
          header: 'Завершено',
          Cell: ({ row }) => formatReportDate(row.original.completedAt),
        },
      );

      return nextColumns;
    },
    [handleCancel, handleDownload, handleRetry, includeAuthor],
  );

  return (
    <Box
      id={panelId}
      role={panelId ? 'tabpanel' : undefined}
      aria-labelledby={labelledBy}
      sx={fullHeight ? REPORTS_FULL_HEIGHT_ROOT_SX : undefined}
    >
      <Box
        sx={{
          p: 3,
          ...(fullHeight ? REPORTS_FULL_HEIGHT_CONTENT_SX : {}),
        }}
      >
        <Stack
          spacing={2}
          useFlexGap={fullHeight}
          sx={fullHeight ? REPORTS_FULL_HEIGHT_STACK_SX : undefined}
        >
          <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
            <Stack direction="row" alignItems="baseline" gap={1}>
              <Typography component="h2" variant="h6" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
                {title}
              </Typography>
              {showReportCount && loadState === 'success' ? (
                <Typography component="span" variant="subtitle1" color="text.secondary" sx={{ fontWeight: 600 }}>
                  {totalRows === null ? rows.length : `${rows.length}/${totalRows}`}
                </Typography>
              ) : null}
            </Stack>
          </Stack>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

          <TableStateProvider
            tableId={tableId}
            defaultColumnOrder={includeAuthor ? DEFAULT_REPORTS_WITH_AUTHOR_COLUMN_ORDER : DEFAULT_REPORTS_COLUMN_ORDER}
            defaultColumnVisibility={
              includeAuthor ? DEFAULT_REPORTS_WITH_AUTHOR_COLUMNS_VISIBILITY : DEFAULT_REPORTS_COLUMNS_VISIBILITY
            }
            defaultEnableColumnOrdering={false}
            defaultSorting={DEFAULT_REPORTS_SORTING}
          >
            <Stack direction="row" justifyContent="flex-end" alignItems="center" gap={1}>
              <InternalTableActions filtersHidden fullScreenEnabled>
                <Tooltip title="Оновити">
                  <span>
                    <IconButton size="small" disabled={loadState === 'loading' || loadingMore} onClick={() => void loadRows()}>
                      <RefreshIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </InternalTableActions>
            </Stack>
            <Box
              sx={{
                ...REPORTS_TABLE_WRAPPER_SX,
                ...(loadState === 'loading' && !fullHeight ? REPORTS_LOADING_TABLE_WRAPPER_SX : {}),
                ...(fullHeight ? REPORTS_FULL_HEIGHT_TABLE_WRAPPER_SX : {}),
              }}
            >
              <SettingsNeoTable
                columns={columns}
                data={rows}
                loading={loadState === 'loading'}
                loadingRows={buildReportLoadingRows()}
                layoutMode="grid"
                showToolbarInternalActions
                enableTopToolbar
                toolbarFiltersHidden
                toolbarFullScreenEnabled
                manualFiltering={loadReportHistoryBatch !== undefined}
                manualSorting={loadReportHistoryBatch !== undefined}
                onQueryStateChange={loadReportHistoryBatch ? handleQueryStateChange : undefined}
              />
            </Box>
            {loadReportHistoryBatch && hasMoreRows ? (
              <Stack direction="row" justifyContent="center">
                <Button variant="outlined" disabled={loadingMore || loadState === 'loading'} onClick={handleLoadMore}>
                  {loadingMore ? 'Завантаження...' : 'Load more'}
                </Button>
              </Stack>
            ) : null}
          </TableStateProvider>
        </Stack>
      </Box>
      <ConfirmDangerDialog
        open={cancelRow !== null}
        onClose={() => setCancelRow(null)}
        onConfirm={() => void confirmCancelInFlightRow()}
        title="Скасування звіту"
        description={cancelRow?.status === 'in_progress' ? REPORT_CANCEL_RUNNING_WARNING : 'Звіт буде скасовано і прибрано з черги.'}
        cancelLabel="СКАСУВАТИ"
        confirmLabel="СКАСУВАТИ ЗВІТ"
        maxWidth="xs"
        fullWidth
      />
      <Dialog open={errorLogRow !== null} onClose={() => setErrorLogRow(null)} fullWidth maxWidth="md">
        <DialogTitle>Помилки</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {(errorLogRow?.errorLog ?? []).map((entry, index) => (
              <Box key={`${entry.timestamp}-${index}`}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                  <Chip size="small" label={entry.login || 'system'} />
                  <Typography variant="body2" color="text.secondary">
                    {formatReportDate(entry.timestamp)}
                  </Typography>
                </Stack>
                <Typography
                  component="pre"
                  variant="body2"
                  sx={{
                    m: 0,
                    fontFamily: 'monospace',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {entry.message}
                </Typography>
              </Box>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setErrorLogRow(null)}>Закрити</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
