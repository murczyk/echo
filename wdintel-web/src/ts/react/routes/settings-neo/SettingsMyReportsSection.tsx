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
import { type MRT_ColumnFiltersState, type MRT_SortingState } from 'material-react-table';

import type { ReportHistoryRow } from '../../../../Bindings';
import { downloadBlob } from '../../utils/download-blob';
import { formatErrorMessage } from '../rer-network-details-neo/use-rer-network-details-neo-page.helpers';
import {
  cancelReportHistory,
  downloadReportHistory,
  isCancelledReportHistory,
  listReportHistory,
  rerunSuccessfulReportHistory,
  retryReportHistory,
  type ReportHistoryBatchRsp,
} from '../../services/api/report-history';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PowerAlert } from '../../components/PowerAlert';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import {
  mrtTextCell,
  type AppMrtColumnDef,
} from '../../components/mui-customized/table/get-default-table-options';
import { SettingsNeoTable } from './SettingsNeoTable';
import { CUSTOM_CELL_STYLES } from '../../components/mui-customized/table/custom-styles';
import { FULL_HEIGHT_LOADING_ROW_COUNT } from '../../components/mui-customized/table/custom-styles';
import {
  MrtRowActionButton,
  MrtRowActions,
  mrtRowActionsColumnSize,
} from '../../components/MrtRowActionButton';
import { InternalTableActions } from '../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { AnalysisPaginationControl } from '../rer-analysis-neo/components/AnalysisPaginationControl';

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
  compactFullHeight?: boolean;
  showReportCount?: boolean;
  loadingRowCount?: number;
  loadReportHistory?: LoadReportHistory;
  loadReportHistoryBatch?: LoadReportHistoryBatch;
  allowSuccessfulRerun?: boolean;
};

const DEFAULT_REPORTS_COLUMNS_VISIBILITY = {
  actions: true,
  reportKind: true,
  reportPeriod: true,
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
  'reportPeriod',
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
  executionTime: true,
  errorLog: true,
};

const DEFAULT_REPORTS_WITH_AUTHOR_COLUMN_ORDER = [
  'mrt-row-numbers',
  'actions',
  'reportKind',
  'requestedBy',
  'reportPeriod',
  'details',
  'createdAt',
  'status',
  'plannedForTs',
  'startedAt',
  'queuePosition',
  'bgtaskId',
  'completedAt',
  'executionTime',
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

const REPORTS_FULL_HEIGHT_BATCH_SHELL_SX = {
  flex: 1,
  minHeight: 0,
  height: '100%',
  overflow: 'hidden',
  border: '1px solid',
  borderColor: 'var(--bs-border-color)',
  backgroundColor: 'var(--bs-body-bg)',
  boxSizing: 'border-box',
} as const;

const REPORTS_FULL_HEIGHT_BATCH_CONTENT_SX = {
  flex: 1,
  minHeight: 0,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  boxSizing: 'border-box',
} as const;

const REPORTS_FULL_HEIGHT_BATCH_TABLE_WRAPPER_SX = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
} as const;

const REPORTS_FULL_HEIGHT_BATCH_TABLE_PAPER_SX = {
  flex: 1,
  height: '100%',
  minHeight: 0,
  maxHeight: '100%',
  overflow: 'hidden',
} as const;

const REPORTS_FULL_HEIGHT_BATCH_TABLE_CONTAINER_SX = {
  height: '100%',
  minHeight: 0,
  maxHeight: '100%',
  overflowX: 'auto',
  overflowY: 'auto',
  overflow: 'auto',
} as const;

const REPORTS_FULL_HEIGHT_BATCH_HEAD_CELL_SX = {
  position: 'sticky',
  top: 0,
  zIndex: 5,
  backgroundColor: 'var(--bs-body-bg)',
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

const REPORT_STATUS_FILTER_OPTIONS = Object.entries(REPORT_STATUS_LABELS).map(([value, text]) => ({
  text,
  value,
}));

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
  sposob: 'Способ',
  active_networks: 'Активні радіомережі',
  network_frequencies: 'Частоти Радіомереж',
  report_125: 'Звіт 1.2.5',
  report_1213: 'Звіт 1.2.13',
  summary_table: 'Підсумкова таблиця',
  kmz: 'KMZ',
  geojson: 'GeoJSON',
  etalonka: 'Еталонний опис',
  goi: 'Звіт ГОІ',
  goi_associations: 'Висновки ГОІ',
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

function parseReportDate(value: string | null | undefined): Date | null {
  if (value == null || value.trim() === '') return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
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

function formatReportDuration(totalSeconds: number): string {
  if (totalSeconds < 0) return '';

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [
    days > 0 ? `${days}д` : null,
    days > 0 || hours > 0 ? `${hours}г` : null,
    days > 0 || hours > 0 || minutes > 0 ? `${minutes}хв` : null,
    `${seconds}с`,
  ];

  return parts.filter((part) => part !== null).join(' ');
}

function reportDurationSeconds(startedAt: Date, completedAt: Date): number | null {
  const totalSeconds = Math.floor((completedAt.getTime() - startedAt.getTime()) / 1000);
  return totalSeconds < 0 ? null : totalSeconds;
}

function formatReportExecutionTime(row: ReportHistoryRow): string {
  if (row.status !== 'done' || !row.hasFile) return '';

  const createdAt = parseReportDate(row.createdAt);
  const startedAt = parseReportDate(row.startedAt);
  const completedAt = parseReportDate(row.completedAt);
  if (createdAt === null || completedAt === null) return '';

  if (startedAt === null) {
    const totalSeconds = reportDurationSeconds(createdAt, completedAt);
    return totalSeconds === null ? '' : formatReportDuration(totalSeconds);
  }

  const queueSeconds = reportDurationSeconds(createdAt, startedAt);
  const executionSeconds = reportDurationSeconds(startedAt, completedAt);
  if (queueSeconds === null || executionSeconds === null) return '';

  return `очікування ${formatReportDuration(queueSeconds)}, виконання ${formatReportDuration(
    executionSeconds,
  )}`;
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

function buildReportLoadingRows(rowCount: number): ReportHistoryRow[] {
  return Array.from({ length: rowCount }, (_, index) => ({
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
    reportPeriod: null,
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
  allowSuccessfulRerun,
  onDownload,
  onRetry,
  onSuccessfulRerun,
  onCancel,
}: {
  row: ReportHistoryRow;
  allowSuccessfulRerun: boolean;
  onDownload: (row: ReportHistoryRow) => void;
  onRetry: (row: ReportHistoryRow) => void;
  onSuccessfulRerun: (row: ReportHistoryRow) => void;
  onCancel: (row: ReportHistoryRow) => void;
}) {
  const isCancelled = isCancelledReportHistory(row);
  const hasActions =
    (row.status === 'done' && row.hasFile) ||
    (row.status === 'done' && allowSuccessfulRerun) ||
    (row.status === 'failed' && !isCancelled) ||
    canCancelReport(row);
  if (!hasActions) {
    return null;
  }

  return (
    <MrtRowActions forceMenu>
      {row.status === 'done' && row.hasFile ? (
        <MrtRowActionButton
          label="Завантажити"
          icon={<DownloadIcon fontSize="small" />}
          onClick={() => onDownload(row)}
        />
      ) : null}
      {row.status === 'done' && allowSuccessfulRerun ? (
        <MrtRowActionButton
          label="Сформувати повторно"
          icon={<ReplayIcon fontSize="small" />}
          tone="warning"
          onClick={() => onSuccessfulRerun(row)}
        />
      ) : null}
      {row.status === 'failed' && !isCancelled ? (
        <MrtRowActionButton
          label="Повторити"
          icon={<ReplayIcon fontSize="small" />}
          tone="warning"
          onClick={() => onRetry(row)}
        />
      ) : null}
      {canCancelReport(row) ? (
        <MrtRowActionButton
          label="Скасувати"
          icon={<CancelOutlinedIcon fontSize="small" />}
          tone="danger"
          opensModal
          onClick={() => onCancel(row)}
        />
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
  compactFullHeight = false,
  showReportCount = false,
  loadingRowCount = REPORT_LOADING_ROW_COUNT,
  loadReportHistory = listReportHistory,
  loadReportHistoryBatch,
  allowSuccessfulRerun = false,
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
  const [pageIndex, setPageIndex] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);

  const loadRows = useCallback(
    async (signal?: AbortSignal, offset = 0, pageNavigation = false) => {
      if (pageNavigation) {
        setPageLoading(true);
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
          setRows(rsp.rows);
          setTotalRows(rsp.total);
          setHasMoreRows(rsp.hasMore);
          setPageIndex(Math.floor(offset / REPORT_HISTORY_BATCH_SIZE));
        } else {
          const nextRows = await loadReportHistory(signal ? { signal } : undefined);
          setRows(nextRows);
          setTotalRows(nextRows.length);
          setHasMoreRows(false);
          setPageIndex(0);
        }
        setLoadState('success');
      } catch (loadError) {
        if (signal?.aborted) return;
        if (!pageNavigation) {
          setRows([]);
          setLoadState('error');
        }
        setError(formatErrorMessage(loadError));
      } finally {
        setPageLoading(false);
      }
    },
    [loadReportHistory, loadReportHistoryBatch, queryState],
  );

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
      setPageIndex(0);
      setPageLoading(false);
    }
  }, [active]);

  const useBatchShell = fullHeight && loadReportHistoryBatch !== undefined;
  const contentPadding = fullHeight && compactFullHeight ? 2 : 3;
  const contentStackSpacing = fullHeight && compactFullHeight ? 1.5 : 2;

  const handleQueryStateChange = useCallback((nextQueryState: ReportHistoryQueryState) => {
    setQueryState((current) =>
      JSON.stringify(current) === JSON.stringify(nextQueryState) ? current : nextQueryState,
    );
  }, []);

  const lastPageIndex = Math.max(0, Math.ceil((totalRows ?? 0) / REPORT_HISTORY_BATCH_SIZE) - 1);
  const openPage = useCallback(
    (nextPageIndex: number) => {
      if (!loadReportHistoryBatch || pageLoading) return;
      void loadRows(undefined, nextPageIndex * REPORT_HISTORY_BATCH_SIZE, true);
    },
    [loadReportHistoryBatch, loadRows, pageLoading],
  );

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

  async function handleSuccessfulRerun(row: ReportHistoryRow) {
    if (!allowSuccessfulRerun || row.status !== 'done') return;
    try {
      await rerunSuccessfulReportHistory(row.id);
      await loadRows(
        undefined,
        loadReportHistoryBatch ? pageIndex * REPORT_HISTORY_BATCH_SIZE : 0,
        loadReportHistoryBatch !== undefined,
      );
    } catch (rerunError) {
      setError(formatErrorMessage(rerunError));
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

  const columns = useMemo<AppMrtColumnDef<ReportHistoryRow>[]>(() => {
    const nextColumns: AppMrtColumnDef<ReportHistoryRow>[] = [
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
        meta: { overflowMode: 'none' },
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
            allowSuccessfulRerun={allowSuccessfulRerun}
            onDownload={(report) => void handleDownload(report)}
            onRetry={(report) => void handleRetry(report)}
            onSuccessfulRerun={(report) => void handleSuccessfulRerun(report)}
            onCancel={(report) => void handleCancel(report)}
          />
        ),
      },
      {
        id: 'reportKind',
        accessorFn: (row) => formatReportKind(row.reportKind),
        header: 'Вид',
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatReportKind(row.original.reportKind),
          fullValue: ({ row }) => formatReportKind(row.original.reportKind),
        }),
      },
      {
        accessorKey: 'reportPeriod',
        header: 'Період',
        enableSorting: false,
        enableColumnFilter: false,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => row.original.reportPeriod ?? '',
          fullValue: ({ row }) => row.original.reportPeriod ?? '',
        }),
      },
      {
        accessorKey: 'details',
        header: 'Деталі',
        enableSorting: false,
        enableColumnFilter: false,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => row.original.details ?? '',
          fullValue: ({ row }) => row.original.details ?? '',
        }),
      },
    ];

    if (includeAuthor) {
      nextColumns.push(
        {
          accessorKey: 'requestedBy',
          header: 'Автор',
          meta: { overflowMode: 'text' },
          Cell: mrtTextCell({
            displayValue: ({ row }) => row.original.requestedBy,
            fullValue: ({ row }) => row.original.requestedBy ?? '',
          }),
        },
        {
          id: 'errorLog',
          accessorFn: (row) => (row.errorLog && row.errorLog.length > 0 ? 'Переглянути' : ''),
          header: 'Помилки',
          enableSorting: false,
          enableColumnFilter: false,
          meta: { overflowMode: 'none' },
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
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatReportDate(row.original.createdAt),
          fullValue: ({ row }) => formatReportDate(row.original.createdAt),
        }),
      },
      {
        id: 'status',
        accessorFn: (row) => formatReportStatus(row),
        header: 'Статус',
        meta: { overflowMode: 'none' },
        ...(includeAuthor
          ? {
              filterVariant: 'multi-select' as const,
              filterSelectOptions: REPORT_STATUS_FILTER_OPTIONS,
              filterFn: 'arrIncludesSome',
            }
          : {}),
        Cell: ({ row }) => {
          const chip = (
            <Chip
              size="small"
              color={statusColor(row.original.status)}
              label={formatReportStatus(row.original)}
              variant={row.original.status === 'planned' ? 'outlined' : 'filled'}
            />
          );
          if (
            !includeAuthor ||
            row.original.status !== 'failed' ||
            isCancelledReportHistory(row.original) ||
            !row.original.lastError
          ) {
            return chip;
          }
          return <Tooltip title={row.original.lastError}>{chip}</Tooltip>;
        },
      },
      {
        accessorKey: 'plannedForTs',
        header: 'План',
        enableSorting: false,
        enableColumnFilter: false,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatReportDateOrDash(row.original.plannedForTs),
          fullValue: ({ row }) => formatReportDateOrDash(row.original.plannedForTs),
        }),
      },
      {
        accessorKey: 'startedAt',
        header: 'Почато',
        enableSorting: false,
        enableColumnFilter: false,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatReportDateOrDash(row.original.startedAt),
          fullValue: ({ row }) => formatReportDateOrDash(row.original.startedAt),
        }),
      },
      {
        accessorKey: 'queuePosition',
        header: 'Черга',
        enableSorting: false,
        enableColumnFilter: false,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatReportId(row.original.queuePosition),
          fullValue: ({ row }) => formatReportId(row.original.queuePosition),
        }),
      },
      {
        accessorKey: 'bgtaskId',
        header: 'ID задачі',
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatReportId(row.original.bgtaskId),
          fullValue: ({ row }) => formatReportId(row.original.bgtaskId),
        }),
      },
      {
        accessorKey: 'completedAt',
        header: 'Завершено',
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatReportDate(row.original.completedAt),
          fullValue: ({ row }) => formatReportDate(row.original.completedAt),
        }),
      },
    );

    if (includeAuthor) {
      nextColumns.push({
        id: 'executionTime',
        accessorFn: (row) => formatReportExecutionTime(row),
        header: 'Час виконання',
        enableSorting: false,
        enableColumnFilter: false,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatReportExecutionTime(row.original),
          fullValue: ({ row }) => formatReportExecutionTime(row.original),
        }),
      });
    }

    return nextColumns;
  }, [
    allowSuccessfulRerun,
    handleCancel,
    handleDownload,
    handleRetry,
    handleSuccessfulRerun,
    includeAuthor,
  ]);

  return (
    <Box
      id={panelId}
      role={panelId ? 'tabpanel' : undefined}
      aria-labelledby={labelledBy}
      sx={fullHeight ? REPORTS_FULL_HEIGHT_ROOT_SX : undefined}
    >
      <Box
        sx={{
          p: contentPadding,
          ...(fullHeight ? REPORTS_FULL_HEIGHT_CONTENT_SX : {}),
        }}
      >
        <Stack
          spacing={contentStackSpacing}
          useFlexGap={fullHeight}
          sx={fullHeight ? REPORTS_FULL_HEIGHT_STACK_SX : undefined}
        >
          {!useBatchShell ? (
            <Stack direction="row" alignItems="baseline" justifyContent="space-between" gap={2}>
              <Stack direction="row" alignItems="baseline" gap={1}>
                <Typography
                  component="h1"
                  variant="h5"
                  sx={{ m: 0, fontWeight: 600, lineHeight: 1.2 }}
                >
                  {title}
                </Typography>
                {showReportCount && loadState === 'success' ? (
                  <Typography
                    component="span"
                    variant="subtitle1"
                    color="text.secondary"
                    sx={{ fontWeight: 600 }}
                  >
                    {totalRows === null ? rows.length : `${rows.length}/${totalRows}`}
                  </Typography>
                ) : null}
              </Stack>
            </Stack>
          ) : null}
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

          <TableStateProvider
            tableId={tableId}
            defaultColumnOrder={
              includeAuthor
                ? DEFAULT_REPORTS_WITH_AUTHOR_COLUMN_ORDER
                : DEFAULT_REPORTS_COLUMN_ORDER
            }
            defaultColumnVisibility={
              includeAuthor
                ? DEFAULT_REPORTS_WITH_AUTHOR_COLUMNS_VISIBILITY
                : DEFAULT_REPORTS_COLUMNS_VISIBILITY
            }
            defaultEnableColumnOrdering={false}
            defaultSorting={DEFAULT_REPORTS_SORTING}
          >
            {useBatchShell ? (
              <>
                <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
                  <Typography
                    component="h1"
                    variant="h5"
                    sx={{ m: 0, fontWeight: 600, lineHeight: 1.2 }}
                  >
                    {title}
                  </Typography>
                  <Stack direction="row" alignItems="center" gap={1}>
                    <AnalysisPaginationControl
                      centerTab="messages"
                      pageIndex={pageIndex}
                      pageSize={REPORT_HISTORY_BATCH_SIZE}
                      messagesCount={rows.length}
                      totalCount={totalRows}
                      totalLoading={loadState === 'loading' && totalRows === null}
                      loading={loadState === 'loading'}
                      noMoreToLoad={!hasMoreRows}
                      busy={pageLoading}
                      onFirstPage={() => openPage(0)}
                      onLastPage={() => openPage(lastPageIndex)}
                      onPrevPage={() => openPage(pageIndex - 1)}
                      onNextPage={() => openPage(pageIndex + 1)}
                    />
                    <InternalTableActions filtersHidden fullScreenEnabled>
                      <Tooltip title="Оновити">
                        <span>
                          <IconButton
                            size="small"
                            disabled={loadState === 'loading' || pageLoading}
                            onClick={() => openPage(pageIndex)}
                          >
                            <RefreshIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </InternalTableActions>
                  </Stack>
                </Stack>
                <Box sx={REPORTS_FULL_HEIGHT_BATCH_SHELL_SX}>
                  <Box sx={REPORTS_FULL_HEIGHT_BATCH_CONTENT_SX}>
                    <Box
                      sx={{
                        ...REPORTS_TABLE_WRAPPER_SX,
                        ...REPORTS_FULL_HEIGHT_TABLE_WRAPPER_SX,
                        ...REPORTS_FULL_HEIGHT_BATCH_TABLE_WRAPPER_SX,
                      }}
                    >
                      <SettingsNeoTable
                        columns={columns}
                        data={rows}
                        loading={loadState === 'loading'}
                        loadingRows={buildReportLoadingRows(loadingRowCount)}
                        layoutMode="grid"
                        showToolbarInternalActions={false}
                        enableTopToolbar={false}
                        enableBottomToolbar={false}
                        tableContainerBorderless
                        tablePaperSx={REPORTS_FULL_HEIGHT_BATCH_TABLE_PAPER_SX}
                        tableContainerSx={REPORTS_FULL_HEIGHT_BATCH_TABLE_CONTAINER_SX}
                        tableHeadCellSx={REPORTS_FULL_HEIGHT_BATCH_HEAD_CELL_SX}
                        manualFiltering={loadReportHistoryBatch !== undefined}
                        manualSorting={loadReportHistoryBatch !== undefined}
                        onQueryStateChange={handleQueryStateChange}
                      />
                    </Box>
                  </Box>
                </Box>
              </>
            ) : (
              <>
                <Stack direction="row" justifyContent="flex-end" alignItems="center" gap={1}>
                  <InternalTableActions filtersHidden fullScreenEnabled>
                    <Tooltip title="Оновити">
                      <span>
                        <IconButton
                          size="small"
                          disabled={loadState === 'loading' || pageLoading}
                          onClick={() => void loadRows()}
                        >
                          <RefreshIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </InternalTableActions>
                </Stack>
                <Box
                  sx={{
                    ...REPORTS_TABLE_WRAPPER_SX,
                    ...(loadState === 'loading' && !fullHeight
                      ? REPORTS_LOADING_TABLE_WRAPPER_SX
                      : {}),
                    ...(fullHeight ? REPORTS_FULL_HEIGHT_TABLE_WRAPPER_SX : {}),
                  }}
                >
                  <SettingsNeoTable
                    columns={columns}
                    data={rows}
                    loading={loadState === 'loading'}
                    loadingRows={buildReportLoadingRows(loadingRowCount)}
                    layoutMode="grid"
                    showToolbarInternalActions
                    enableTopToolbar
                    toolbarFiltersHidden
                    toolbarFullScreenEnabled
                    manualFiltering={loadReportHistoryBatch !== undefined}
                    manualSorting={loadReportHistoryBatch !== undefined}
                    tablePaperSx={fullHeight ? REPORTS_FULL_HEIGHT_BATCH_TABLE_PAPER_SX : undefined}
                    tableContainerSx={
                      fullHeight ? REPORTS_FULL_HEIGHT_BATCH_TABLE_CONTAINER_SX : undefined
                    }
                    onQueryStateChange={loadReportHistoryBatch ? handleQueryStateChange : undefined}
                  />
                </Box>
              </>
            )}
          </TableStateProvider>
        </Stack>
      </Box>
      <ConfirmDangerDialog
        open={cancelRow !== null}
        onClose={() => setCancelRow(null)}
        onConfirm={() => void confirmCancelInFlightRow()}
        title="Скасування звіту"
        description={
          cancelRow?.status === 'in_progress'
            ? REPORT_CANCEL_RUNNING_WARNING
            : 'Звіт буде скасовано і прибрано з черги.'
        }
        cancelLabel="СКАСУВАТИ"
        confirmLabel="СКАСУВАТИ ЗВІТ"
        maxWidth="xs"
        fullWidth
      />
      <Dialog
        open={errorLogRow !== null}
        onClose={() => setErrorLogRow(null)}
        fullWidth
        maxWidth="md"
      >
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
