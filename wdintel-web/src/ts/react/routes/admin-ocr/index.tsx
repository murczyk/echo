import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import {
  Box,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  MaterialReactTable,
  type MRT_ColumnDef,
  useMaterialReactTable,
} from 'material-react-table';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { OcrJobItem, OcrPageRsp } from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerChip } from '../../components/PowerChip';
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
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { getOcrPage, saveOcrSettings } from '../../services/api/ocr';

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'document',
  'sourceCreatedAt',
  'state',
  'qualityStatus',
  'pages',
  'durationMs',
  'attempts',
  'updatedAt',
];

const DEFAULT_COLUMN_VISIBILITY = {
  document: true,
  sourceCreatedAt: true,
  state: true,
  qualityStatus: true,
  pages: true,
  durationMs: true,
  attempts: true,
  updatedAt: true,
  'mrt-row-actions': true,
};

const STATE_LABELS: Record<string, string> = {
  queued: 'У черзі',
  submitted: 'Обробляється',
  retry_wait: 'Очікує повтору',
  completed: 'Завершено',
  failed: 'Помилка',
};

const QUALITY_LABELS: Record<string, string> = {
  accepted: 'Прийнято',
  degraded: 'Знижена якість',
  failed: 'Помилка',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDateTime(timestamp: number | null): string {
  if (timestamp == null) return '—';
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(timestamp));
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs == null) return '—';
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} хв ${seconds} с` : `${seconds} с`;
}

function stateColor(state: string): 'default' | 'info' | 'success' | 'error' | 'warning' {
  if (state === 'completed') return 'success';
  if (state === 'failed') return 'error';
  if (state === 'retry_wait') return 'warning';
  if (state === 'submitted') return 'info';
  return 'default';
}

function qualityColor(qualityStatus: string | null): 'default' | 'success' | 'error' | 'warning' {
  if (qualityStatus === 'accepted') return 'success';
  if (qualityStatus === 'degraded') return 'warning';
  if (qualityStatus === 'failed') return 'error';
  return 'default';
}

function activeJobs(page: OcrPageRsp | null): boolean {
  return Boolean(page && page.counts.queued + page.counts.submitted + page.counts.retryWait > 0);
}

function StatusPill({ state }: { state: string }) {
  return <PowerChip selected color={stateColor(state)} label={STATE_LABELS[state] ?? state} />;
}

function QualityPill({ qualityStatus }: { qualityStatus: string | null }) {
  if (qualityStatus == null) return <>—</>;
  return (
    <PowerChip
      selected
      color={qualityColor(qualityStatus)}
      label={QUALITY_LABELS[qualityStatus] ?? qualityStatus}
    />
  );
}

function OcrJobsTable({
  jobs,
  loading,
  onView,
}: {
  jobs: OcrJobItem[];
  loading: boolean;
  onView: (job: OcrJobItem) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo<MRT_ColumnDef<OcrJobItem>[]>(
    () => [
      {
        id: 'document',
        accessorFn: (job) => job.fileName || job.mediaId,
        header: 'Документ',
        size: 280,
        Cell: ({ row }) => (
          <Tooltip
            title={row.original.lastError ?? ''}
            disableHoverListener={!row.original.lastError}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap sx={{ maxWidth: 280 }}>
                {row.original.fileName || row.original.mediaId}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {row.original.contentType} · {formatSize(row.original.sizeBytes)}
              </Typography>
            </Box>
          </Tooltip>
        ),
      },
      {
        id: 'sourceCreatedAt',
        accessorFn: (job) => job.sourceCreatedAt,
        header: 'Створено',
        size: 170,
        Cell: ({ row }) => formatDateTime(row.original.sourceCreatedAt),
      },
      {
        accessorKey: 'state',
        header: 'Стан',
        size: 150,
        Cell: ({ row }) => <StatusPill state={row.original.state} />,
      },
      {
        accessorKey: 'qualityStatus',
        header: 'Якість',
        size: 160,
        Cell: ({ row }) => <QualityPill qualityStatus={row.original.qualityStatus} />,
      },
      {
        id: 'pages',
        accessorFn: (job) => job.totalPages,
        header: 'Сторінки',
        size: 110,
        Cell: ({ row }) =>
          row.original.totalPages > 0
            ? `${row.original.processedPages}/${row.original.totalPages}`
            : '—',
      },
      {
        accessorKey: 'durationMs',
        header: 'Тривалість',
        size: 130,
        Cell: ({ row }) => formatDuration(row.original.durationMs),
      },
      {
        accessorKey: 'attempts',
        header: 'Спроби',
        size: 100,
      },
      {
        id: 'updatedAt',
        accessorFn: (job) => job.updatedAt,
        header: 'Оновлено',
        size: 170,
        Cell: ({ row }) => formatDateTime(row.original.updatedAt),
      },
    ],
    [],
  );

  const table = useMaterialReactTable({
    columns,
    data: jobs,
    ...getDefaultMRTOptions<OcrJobItem>(),
    enableSorting: false,
    enableGlobalFilter: false,
    enableColumnActions: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowNumbers: true,
    enableRowActions: true,
    enablePagination: false,
    enableBottomToolbar: false,
    enableTopToolbar: false,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => (
      <MrtRowActions>
        <MrtRowActionButton
          label="Порівняти оригінал та OCR"
          icon={<VisibilityOutlinedIcon fontSize="small" />}
          disabled={row.original.previewUrl == null}
          onClick={() => onView(row.original)}
          opensModal
        />
      </MrtRowActions>
    ),
    enableColumnOrdering: false,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    columnFilterDisplayMode: 'popover',
    globalFilterFn: 'contains',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    defaultColumn: { size: 170, renderColumnActionsMenuItems },
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
    muiTablePaperProps: ({ table }) => getDefaultMrtPaperProps({ table, loading }),
    muiTableContainerProps: ({ table }) =>
      getDefaultMrtContainerProps({
        loading,
        fullScreen: table.getState().isFullScreen,
        hasRows: jobs.length > 0,
      }),
    state: {
      showAlertBanner: false,
      showProgressBars: loading,
      columnVisibility: tableStateContext.columnVisibility,
      columnFilters: tableStateContext.columnFilters,
      density: tableStateContext.density,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table, tableStateContext]);

  return <MaterialReactTable table={table} />;
}

function PreviewPane({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box
      sx={{ flex: '1 1 50%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Typography
        variant="subtitle2"
        sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider', bgcolor: 'action.hover' }}
      >
        {title}
      </Typography>
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', bgcolor: 'background.default' }}>
        {children}
      </Box>
    </Box>
  );
}

function OcrEvaluationDialog({ job, onClose }: { job: OcrJobItem | null; onClose: () => void }) {
  const sourceUrl = job ? `/api/messenger/media/${encodeURIComponent(job.mediaId)}` : '';
  const isImage = job?.contentType.toLowerCase().startsWith('image/') ?? false;

  return (
    <Dialog
      open={job != null}
      onClose={onClose}
      fullWidth
      maxWidth="xl"
      PaperProps={{ sx: { height: '92svh', maxHeight: '92svh' } }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Typography component="span" variant="h6" noWrap sx={{ flex: 1 }}>
          {job?.fileName || 'OCR'}
        </Typography>
        {job ? <StatusPill state={job.state} /> : null}
        {job ? <QualityPill qualityStatus={job.qualityStatus} /> : null}
        {job?.durationMs != null ? (
          <PowerChip
            selected
            color="info"
            label={`Тривалість: ${formatDuration(job.durationMs)}`}
          />
        ) : null}
        <IconButton aria-label="Закрити" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent
        dividers
        sx={{ p: 0, display: 'flex', flexDirection: { xs: 'column', md: 'row' }, minHeight: 0 }}
      >
        <PreviewPane title="Оригінал">
          {isImage ? (
            <Box
              component="img"
              src={sourceUrl}
              alt={job?.fileName || 'Оригінал'}
              sx={{ width: '100%', height: '100%', objectFit: 'contain', p: 1 }}
            />
          ) : (
            <Box
              component="iframe"
              title="Оригінал"
              src={sourceUrl}
              referrerPolicy="no-referrer"
              sx={{ flex: 1, minWidth: 0, border: 0 }}
            />
          )}
        </PreviewPane>
        <Box sx={{ borderLeft: { md: 1 }, borderTop: { xs: 1, md: 0 }, borderColor: 'divider' }} />
        <PreviewPane title="Результат OCR">
          {job?.previewUrl ? (
            <Box
              component="iframe"
              title="Результат OCR"
              src={job.previewUrl}
              sandbox=""
              referrerPolicy="no-referrer"
              sx={{ flex: 1, minWidth: 0, border: 0, bgcolor: 'background.paper' }}
            />
          ) : null}
        </PreviewPane>
      </DialogContent>
    </Dialog>
  );
}

function AdminOcrPageBody() {
  const [page, setPage] = useState<OcrPageRsp | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<OcrJobItem | null>(null);
  const { notify } = usePowerSnackbar();

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const response = await getOcrPage();
        setPage(response);
        setError(null);
      } catch (loadError) {
        const message = `Не вдалося завантажити OCR: ${errorMessage(loadError)}`;
        setError(message);
        if (quiet) notify({ severity: 'error', message });
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!activeJobs(page)) return;
    const interval = window.setInterval(() => void load(true), 10_000);
    return () => window.clearInterval(interval);
  }, [load, page]);

  async function changeWorkerEnabled(workerEnabled: boolean) {
    setSaving(true);
    try {
      const settings = await saveOcrSettings({ workerEnabled });
      setPage((current) => (current ? { ...current, settings } : current));
      notify({
        severity: 'success',
        message: workerEnabled ? 'OCR-воркер увімкнено.' : 'Нові OCR-завдання зупинено.',
      });
      await load(true);
    } catch (saveError) {
      notify({
        severity: 'error',
        message: `Не вдалося зберегти OCR: ${errorMessage(saveError)}`,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack spacing={2.5} sx={{ minWidth: 0 }}>
      <TablePageToolbar
        title="OCR"
        titleInfo="Автоматичне розпізнавання PDF, JPG і PNG за останні сім днів."
        internalActionsHidden
        actions={
          <PowerButton
            variant="outlined"
            startIcon={loading ? <CircularProgress size={16} /> : <RefreshIcon />}
            disabled={loading}
            onClick={() => void load()}
          >
            Оновити
          </PowerButton>
        }
      />

      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
              <FormControlLabel
                control={
                  <Switch
                    checked={page?.settings.workerEnabled ?? false}
                    disabled={saving || page == null}
                    onChange={(_, checked) => void changeWorkerEnabled(checked)}
                  />
                }
                label="OCR-воркер"
              />
              <PowerChip
                selected
                color={page?.settings.configured ? 'success' : 'error'}
                label={page?.settings.configured ? 'Налаштовано' : 'Не налаштовано'}
              />
              <PowerChip
                selected
                color={page?.settings.extractorReady ? 'success' : 'warning'}
                label={
                  page?.settings.extractorReady ? 'Extractor готовий' : 'Extractor недоступний'
                }
              />
            </Stack>
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              <PowerChip label={`У черзі: ${page?.counts.queued ?? 0}`} />
              <PowerChip color="info" label={`Обробляється: ${page?.counts.submitted ?? 0}`} />
              <PowerChip color="warning" label={`Очікує повтору: ${page?.counts.retryWait ?? 0}`} />
              <PowerChip color="success" label={`Завершено: ${page?.counts.completed ?? 0}`} />
              <PowerChip color="error" label={`Помилки: ${page?.counts.failed ?? 0}`} />
            </Stack>
            <Typography variant="body2" color="text.secondary">
              Вимкнення зупиняє пошук і відправлення нових документів, але вже відправлені завдання
              завершуються та зберігаються.
            </Typography>
            {page?.settings.readinessError ? (
              <PowerAlert severity="warning">{page.settings.readinessError}</PowerAlert>
            ) : null}
          </Stack>
        </CardContent>
      </Card>

      <OcrJobsTable jobs={page?.jobs ?? []} loading={loading} onView={setPreview} />
      <OcrEvaluationDialog job={preview} onClose={() => setPreview(null)} />
    </Stack>
  );
}

export function AdminOcrPage() {
  return (
    <TableStateProvider
      tableId="admin-ocr"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
    >
      <AdminOcrPageBody />
    </TableStateProvider>
  );
}
