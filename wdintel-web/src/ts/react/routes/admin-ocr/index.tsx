import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import {
  Box,
  Card,
  CardContent,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
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
import { saveMediaSummarySettings } from '../../services/api/media-summary';
import {
  MediaSummaryAction,
  MediaSummaryOverlay,
} from '../shared/message-card/attachment-preview/MediaSummaryPreview';

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'document',
  'engine',
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
  engine: true,
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
        id: 'engine',
        accessorFn: (job) => job.aiEngineName ?? job.modelName ?? '',
        header: 'OCR-движок',
        size: 180,
        Cell: ({ row }) => row.original.aiEngineName ?? row.original.modelName ?? '—',
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
  const sourceUrl = job ? `/api/admin/ocr/${encodeURIComponent(job.mediaId)}/media` : '';
  const isImage = job?.contentType.toLowerCase().startsWith('image/') ?? false;
  const [summaryVisible, setSummaryVisible] = useState(job?.summary != null);
  const [summaryStatus, setSummaryStatus] = useState(job?.summary ?? null);

  useEffect(() => {
    setSummaryVisible(job?.summary != null);
    setSummaryStatus(job?.summary ?? null);
  }, [job?.mediaId, job?.summary]);

  const sourcePreview = isImage ? (
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
  );

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
        {job?.aiEngineName || job?.modelName ? (
          <PowerChip selected color="default" label={`OCR: ${job.aiEngineName ?? job.modelName}`} />
        ) : null}
        {job?.durationMs != null ? (
          <PowerChip
            selected
            color="info"
            label={`Тривалість: ${formatDuration(job.durationMs)}`}
          />
        ) : null}
        <MediaSummaryAction
          status={summaryStatus}
          active={summaryVisible}
          onClick={() => setSummaryVisible((visible) => !visible)}
        />
        <IconButton aria-label="Закрити" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent
        dividers
        sx={{ p: 0, display: 'flex', flexDirection: { xs: 'column', md: 'row' }, minHeight: 0 }}
      >
        <PreviewPane title="Оригінал">
          <MediaSummaryOverlay
            source={sourcePreview}
            mediaId={job?.mediaId}
            status={summaryStatus}
            visible={summaryVisible}
            onStatusChange={setSummaryStatus}
            onClose={() => setSummaryVisible(false)}
            summaryAccess="admin-ocr"
          />
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
  const [summarySaving, setSummarySaving] = useState(false);
  const [summaryEnabled, setSummaryEnabled] = useState(false);
  const [summaryEngineId, setSummaryEngineId] = useState('');
  const [summaryDirty, setSummaryDirty] = useState(false);
  const [ocrEngineIds, setOcrEngineIds] = useState<string[]>([]);
  const [mainOcrEngineId, setMainOcrEngineId] = useState('');
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
    if (page == null || summaryDirty) return;
    setSummaryEnabled(page.mediaSummarySettings.enabled);
    setSummaryEngineId(page.mediaSummarySettings.aiEngineId ?? '');
    setOcrEngineIds(page.settings.selectedAiEngineIds);
    setMainOcrEngineId(page.settings.mainAiEngineId ?? '');
  }, [page, summaryDirty]);

  useEffect(() => {
    if (!activeJobs(page)) return;
    const interval = window.setInterval(() => void load(true), 10_000);
    return () => window.clearInterval(interval);
  }, [load, page]);

  async function changeWorkerEnabled(workerEnabled: boolean) {
    setSaving(true);
    try {
      const settings = await saveOcrSettings({
        workerEnabled,
        aiEngineIds: ocrEngineIds,
        mainAiEngineId: mainOcrEngineId || null,
      });
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

  async function saveEngineSettings() {
    setSaving(true);
    try {
      const settings = await saveOcrSettings({
        workerEnabled: page?.settings.workerEnabled ?? false,
        aiEngineIds: ocrEngineIds,
        mainAiEngineId: mainOcrEngineId || null,
      });
      setPage((current) => (current ? { ...current, settings } : current));
      notify({ severity: 'success', message: 'OCR-движки збережено.' });
    } catch (saveError) {
      notify({
        severity: 'error',
        message: `Не вдалося зберегти OCR-движки: ${errorMessage(saveError)}`,
      });
    } finally {
      setSaving(false);
    }
  }

  async function saveSummarySettings() {
    if (summaryEnabled && summaryEngineId === '') {
      notify({
        severity: 'error',
        message: 'Оберіть ШІ движок для стислого опису документів.',
      });
      return;
    }
    setSummarySaving(true);
    try {
      const mediaSummarySettings = await saveMediaSummarySettings({
        enabled: summaryEnabled,
        aiEngineId: summaryEngineId || null,
      });
      setPage((current) => (current ? { ...current, mediaSummarySettings } : current));
      setSummaryDirty(false);
      notify({ severity: 'success', message: 'Налаштування стислого опису збережено.' });
    } catch (saveError) {
      notify({
        severity: 'error',
        message: `Не вдалося зберегти стислий опис: ${errorMessage(saveError)}`,
      });
    } finally {
      setSummarySaving(false);
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

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6">OCR-движки</Typography>
            <Typography variant="body2" color="text.secondary">
              Вибрані движки доступні для повторної обробки. Автоматична черга використовує лише
              головний движок.
            </Typography>
            <FormControl fullWidth disabled={saving || page == null}>
              <InputLabel id="ocr-engines-label">Доступні OCR-движки</InputLabel>
              <Select
                multiple
                labelId="ocr-engines-label"
                label="Доступні OCR-движки"
                value={ocrEngineIds}
                renderValue={(selected) =>
                  selected
                    .map(
                      (id) => page?.settings.engines.find((engine) => engine.id === id)?.name ?? id,
                    )
                    .join(', ')
                }
                onChange={(event) => {
                  const next = event.target.value as string[];
                  setOcrEngineIds(next);
                  if (!next.includes(mainOcrEngineId)) setMainOcrEngineId(next[0] ?? '');
                }}
              >
                {(page?.settings.engines ?? []).map((engine) => (
                  <MenuItem key={engine.id} value={engine.id}>
                    <Checkbox checked={ocrEngineIds.includes(engine.id)} />
                    {engine.name} · {engine.modelName}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth disabled={saving || page == null || ocrEngineIds.length === 0}>
              <InputLabel id="ocr-main-engine-label">Головний OCR-движок</InputLabel>
              <Select
                labelId="ocr-main-engine-label"
                label="Головний OCR-движок"
                value={mainOcrEngineId}
                onChange={(event) => setMainOcrEngineId(event.target.value)}
              >
                {ocrEngineIds.map((id) => {
                  const engine = page?.settings.engines.find((item) => item.id === id);
                  return (
                    <MenuItem key={id} value={id}>
                      {engine?.name ?? id} · {engine?.modelName ?? ''}
                    </MenuItem>
                  );
                })}
              </Select>
            </FormControl>
            <Box>
              <PowerButton
                variant="contained"
                disabled={
                  saving || page == null || (ocrEngineIds.length > 0 && mainOcrEngineId === '')
                }
                onClick={() => void saveEngineSettings()}
              >
                Зберегти OCR-движки
              </PowerButton>
            </Box>
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6">Стислий опис документів</Typography>
            <Typography variant="body2" color="text.secondary">
              Нові завершені OCR-завдання для JPG і PNG надсилатимуть очищений текст обраному ШІ
              движку. Наявні документи не обробляються повторно.
            </Typography>
            <FormControlLabel
              control={
                <Switch
                  checked={summaryEnabled}
                  disabled={summarySaving || page == null}
                  onChange={(_, checked) => {
                    setSummaryEnabled(checked);
                    setSummaryDirty(true);
                  }}
                />
              }
              label="Стислий опис документів"
            />
            <FormControl fullWidth disabled={summarySaving || page == null}>
              <InputLabel id="media-summary-engine-label">ШІ движок</InputLabel>
              <Select
                labelId="media-summary-engine-label"
                label="ШІ движок"
                value={summaryEngineId}
                onChange={(event) => {
                  setSummaryEngineId(event.target.value);
                  setSummaryDirty(true);
                }}
              >
                <MenuItem value="">
                  <em>Не вибрано</em>
                </MenuItem>
                {(page?.mediaSummarySettings.engines ?? []).map((engine) => (
                  <MenuItem key={engine.id} value={engine.id}>
                    {engine.name} · {engine.modelName}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {summaryEnabled && (page?.mediaSummarySettings.engines.length ?? 0) === 0 ? (
              <PowerAlert severity="warning">Немає увімкнених ШІ движків.</PowerAlert>
            ) : null}
            <Box>
              <PowerButton
                variant="contained"
                disabled={
                  summarySaving ||
                  page == null ||
                  !summaryDirty ||
                  (summaryEnabled && summaryEngineId === '')
                }
                onClick={() => void saveSummarySettings()}
              >
                Зберегти
              </PowerButton>
            </Box>
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
