import DownloadIcon from '@mui/icons-material/DownloadOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import ReplayIcon from '@mui/icons-material/ReplayOutlined';
import { Box, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { type MRT_ColumnDef } from 'material-react-table';

import type { ReportHistoryRow } from '../../../../Bindings';
import { downloadBlob } from '../../utils/download-blob';
import { formatErrorMessage } from '../rer-network-details-neo/use-rer-network-details-neo-page.helpers';
import { downloadReportHistory, listReportHistory, retryReportHistory } from '../../services/api/report-history';
import { PowerAlert } from '../../components/PowerAlert';
import { FULL_HEIGHT_LOADING_ROW_COUNT } from '../../components/mui-customized/table/custom-styles';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { SettingsNeoTable } from './SettingsNeoTable';

type LoadState = 'idle' | 'loading' | 'success' | 'error';

type LoadReportHistory = (options?: { signal?: AbortSignal }) => Promise<ReportHistoryRow[]>;

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
  loadReportHistory?: LoadReportHistory;
};

const DEFAULT_REPORTS_COLUMNS_VISIBILITY = {
  reportKind: true,
  createdAt: true,
  status: true,
  completedAt: true,
  actions: true,
};

const DEFAULT_REPORTS_COLUMN_ORDER = [
  'mrt-row-numbers',
  'reportKind',
  'createdAt',
  'status',
  'completedAt',
  'actions',
];

const DEFAULT_REPORTS_WITH_AUTHOR_COLUMNS_VISIBILITY = {
  ...DEFAULT_REPORTS_COLUMNS_VISIBILITY,
  requestedBy: true,
};

const DEFAULT_REPORTS_WITH_AUTHOR_COLUMN_ORDER = [
  'mrt-row-numbers',
  'reportKind',
  'requestedBy',
  'createdAt',
  'status',
  'completedAt',
  'actions',
];

const DEFAULT_REPORTS_SORTING = [{ id: 'createdAt', desc: true }];

const REPORT_STATUS_LABELS: Record<string, string> = {
  planned: 'В черзі',
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

function statusColor(status: string): 'default' | 'primary' | 'success' | 'error' | 'warning' {
  if (status === 'done') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'in_progress') return 'primary';
  if (status === 'planned') return 'warning';
  return 'default';
}

function buildReportLoadingRows(): ReportHistoryRow[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
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
  }));
}

export function SettingsMyReportsSection({ active }: Props) {
  return (
    <ReportHistoryTableSection
      active={active}
      title="Мої Звіти"
      tableId="settings-neo-my-reports-v1"
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
  loadReportHistory = listReportHistory,
}: ReportHistoryTableSectionProps) {
  const [rows, setRows] = useState<ReportHistoryRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<number | null>(null);

  async function loadRows(signal?: AbortSignal) {
    setLoadState((current) => (current === 'success' ? current : 'loading'));
    setError(null);
    try {
      const nextRows = await loadReportHistory(signal ? { signal } : undefined);
      setRows(nextRows);
      setLoadState('success');
    } catch (loadError) {
      if (signal?.aborted) return;
      setRows([]);
      setLoadState('error');
      setError(formatErrorMessage(loadError));
    }
  }

  useEffect(() => {
    if (!active) return;
    const abortController = new AbortController();
    void loadRows(abortController.signal);
    return () => {
      abortController.abort();
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const hasRunningRows = rows.some((row) => row.status === 'planned' || row.status === 'in_progress');
    if (!hasRunningRows) return;
    const intervalId = window.setInterval(() => {
      void loadRows();
    }, 5000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [active, rows]);

  async function handleDownload(row: ReportHistoryRow) {
    if (!row.hasFile || row.status !== 'done') return;
    setActionInFlight(row.id);
    try {
      const blob = await downloadReportHistory(row.id);
      downloadBlob(blob, row.fileName ?? `report-${row.id}`);
    } catch (downloadError) {
      setError(formatErrorMessage(downloadError));
    } finally {
      setActionInFlight(null);
    }
  }

  async function handleRetry(row: ReportHistoryRow) {
    if (row.status !== 'failed') return;
    setActionInFlight(row.id);
    try {
      const updated = await retryReportHistory(row.id);
      setRows((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (retryError) {
      setError(formatErrorMessage(retryError));
    } finally {
      setActionInFlight(null);
    }
  }

  const columns = useMemo<MRT_ColumnDef<ReportHistoryRow>[]>(
    () => {
      const nextColumns: MRT_ColumnDef<ReportHistoryRow>[] = [
        {
          accessorKey: 'reportKind',
          header: 'Вид',
          Cell: ({ row }) => REPORT_KIND_LABELS[row.original.reportKind] ?? row.original.reportKind,
        },
      ];

      if (includeAuthor) {
        nextColumns.push({
          accessorKey: 'requestedBy',
          header: 'Автор',
          Cell: ({ row }) => row.original.requestedBy,
        });
      }

      nextColumns.push(
        {
          accessorKey: 'createdAt',
          header: 'Створено',
          Cell: ({ row }) => formatReportDate(row.original.createdAt),
        },
        {
          accessorKey: 'status',
          header: 'Статус',
          Cell: ({ row }) => (
            <Chip
              size="small"
              color={statusColor(row.original.status)}
              label={REPORT_STATUS_LABELS[row.original.status] ?? row.original.status}
              variant={row.original.status === 'planned' ? 'outlined' : 'filled'}
            />
          ),
        },
        {
          accessorKey: 'completedAt',
          header: 'Завершено',
          Cell: ({ row }) => formatReportDate(row.original.completedAt),
        },
        {
          id: 'actions',
          header: '',
          enableSorting: false,
          enableColumnActions: false,
          enableColumnFilter: false,
          size: 88,
          Cell: ({ row }) => {
            const report = row.original;
            const disabled = actionInFlight === report.id;
            if (report.status === 'failed') {
              return (
                <Tooltip title="Повторити">
                  <span>
                    <IconButton size="small" disabled={disabled} onClick={() => void handleRetry(report)}>
                      <ReplayIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              );
            }
            return (
              <Tooltip title={report.hasFile ? 'Завантажити' : ''}>
                <span>
                  <IconButton
                    size="small"
                    disabled={disabled || report.status !== 'done' || !report.hasFile}
                    onClick={() => void handleDownload(report)}
                  >
                    <DownloadIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            );
          },
        },
      );

      return nextColumns;
    },
    [actionInFlight, includeAuthor],
  );


  return (
    <Box id={panelId} role={panelId ? 'tabpanel' : undefined} aria-labelledby={labelledBy}>
      <Box sx={{ p: 3 }}>
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
            <Typography component="h2" variant="h6" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
              {title}
            </Typography>
            <Tooltip title="Оновити">
              <span>
                <IconButton size="small" disabled={loadState === 'loading'} onClick={() => void loadRows()}>
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
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
            <Box sx={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>
              <SettingsNeoTable
                columns={columns}
                data={rows}
                loading={loadState === 'loading'}
                loadingRows={buildReportLoadingRows()}
              />
            </Box>
          </TableStateProvider>
        </Stack>
      </Box>
    </Box>
  );
}
