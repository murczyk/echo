import RefreshIcon from '@mui/icons-material/Refresh';
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
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { MaterialReactTable } from 'material-react-table';

import type {
  AiEngineItem,
  AiIntelReportAttemptItem,
  AiIntelReportSettingsItem,
} from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PageHeader } from '../../components/PageHeader';
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
  mrtTextCell,
  renderColumnActionsMenuItems,
  useAppMaterialReactTable,
  type AppMrtColumnDef,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import {
  getAiIntelReportSettings,
  listAiIntelReportAttempts,
  saveAiIntelReportSettings,
} from '../../services/api/ai-intel-report';
import { listAiEngines } from '../../services/api/ai-engines';

const ATTEMPTS_DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'createdAt',
  'durationMs',
  'login',
  'aiEngineName',
  'sourceMessageId',
  'outcome',
  'result',
];
const ATTEMPTS_DEFAULT_COLUMN_VISIBILITY = {
  createdAt: true,
  durationMs: true,
  login: true,
  aiEngineName: true,
  sourceMessageId: true,
  outcome: true,
  result: true,
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Невідома помилка';
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}

function outcomeLabel(outcome: string): string {
  if (outcome === 'success') return 'Успішно';
  if (outcome === 'failed') return 'Помилка';
  if (outcome === 'disabled') return 'Вимкнено';
  return outcome;
}

function attemptResult(attempt: AiIntelReportAttemptItem): string {
  return attempt.suggestions.join(' · ') || attempt.error || attempt.rawResponse || '—';
}

function AttemptDetailsDialog({
  attempt,
  onClose,
}: {
  attempt: AiIntelReportAttemptItem | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={attempt !== null} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Спроба швидкої пропозиції</DialogTitle>
      <DialogContent dividers>
        {attempt ? (
          <Stack spacing={2}>
            <Typography variant="body2">
              {formatDateTime(attempt.createdAt)} · {attempt.login} · повідомлення{' '}
              {attempt.sourceMessageId}
            </Typography>
            <Typography variant="body2">
              Движок: {attempt.aiEngineName ?? '—'} · тривалість: {attempt.durationMs} мс · стан:{' '}
              {outcomeLabel(attempt.outcome)}
            </Typography>
            <Box>
              <Typography variant="subtitle2">Перевірені пропозиції</Typography>
              <Typography
                component="pre"
                sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {attempt.suggestions.join('\n\n') || '—'}
              </Typography>
            </Box>
            <Box>
              <Typography variant="subtitle2">Відповідь моделі</Typography>
              <Typography
                component="pre"
                sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {attempt.rawResponse ?? '—'}
              </Typography>
            </Box>
            <Box>
              <Typography variant="subtitle2">Помилка</Typography>
              <Typography
                component="pre"
                sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {attempt.error ?? '—'}
              </Typography>
            </Box>
          </Stack>
        ) : null}
      </DialogContent>
      <DialogActions>
        <PowerButton variant="contained" onClick={onClose}>
          Закрити
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

function AttemptsTable({
  attempts,
  loading,
  onView,
}: {
  attempts: AiIntelReportAttemptItem[];
  loading: boolean;
  onView: (attempt: AiIntelReportAttemptItem) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo<AppMrtColumnDef<AiIntelReportAttemptItem>[]>(
    () => [
      {
        id: 'createdAt',
        accessorFn: (attempt) => formatDateTime(attempt.createdAt),
        header: 'Час',
        size: 180,
      },
      {
        accessorKey: 'durationMs',
        header: 'Тривалість, мс',
        size: 150,
      },
      { accessorKey: 'login', header: 'Користувач', size: 180 },
      {
        accessorKey: 'aiEngineName',
        header: 'Движок',
        size: 180,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => row.original.aiEngineName ?? '—',
          fullValue: ({ row }) => row.original.aiEngineName ?? '—',
        }),
      },
      {
        accessorKey: 'sourceMessageId',
        header: 'Повідомлення',
        size: 150,
      },
      {
        accessorKey: 'outcome',
        header: 'Стан',
        size: 130,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => (
          <Chip
            size="small"
            label={outcomeLabel(row.original.outcome)}
            color={
              row.original.outcome === 'success'
                ? 'success'
                : row.original.outcome === 'failed'
                  ? 'error'
                  : 'default'
            }
          />
        ),
      },
      {
        id: 'result',
        accessorFn: attemptResult,
        header: 'Результат / помилка',
        size: 500,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => attemptResult(row.original),
          fullValue: ({ row }) => attemptResult(row.original),
        }),
      },
    ],
    [],
  );
  const table = useAppMaterialReactTable({
    ...getDefaultMRTOptions<AiIntelReportAttemptItem>(),
    columns,
    data: attempts,
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
        hasRows: attempts.length > 0,
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

export function AdminAiIntelReportsPage() {
  const [settings, setSettings] = useState<AiIntelReportSettingsItem | null>(null);
  const [engines, setEngines] = useState<AiEngineItem[]>([]);
  const [attempts, setAttempts] = useState<AiIntelReportAttemptItem[]>([]);
  const [selectedAttempt, setSelectedAttempt] = useState<AiIntelReportAttemptItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [attemptsLoading, setAttemptsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptsError, setAttemptsError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();
  const eligibleEngines = useMemo(
    () => engines.filter((engine) => engine.enabled && engine.callsignEnabled),
    [engines],
  );

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    setAttemptsError(null);
    const [settingsResult, attemptsResult] = await Promise.allSettled([
      Promise.all([getAiIntelReportSettings(), listAiEngines()]),
      listAiIntelReportAttempts(),
    ]);
    if (settingsResult.status === 'fulfilled') {
      const [nextSettings, nextEngines] = settingsResult.value;
      setSettings(nextSettings);
      setEngines(nextEngines);
    } else {
      setError(`Не вдалося завантажити налаштування: ${errorMessage(settingsResult.reason)}`);
    }
    if (attemptsResult.status === 'fulfilled') {
      setAttempts(attemptsResult.value);
    } else {
      const message = `Не вдалося завантажити спроби: ${errorMessage(attemptsResult.reason)}`;
      setAttemptsError(message);
      notify({ severity: 'error', message });
    }
    setLoading(false);
  }

  async function refreshAttempts() {
    setAttemptsLoading(true);
    setAttemptsError(null);
    try {
      setAttempts(await listAiIntelReportAttempts());
    } catch (loadError) {
      const message = `Не вдалося завантажити спроби: ${errorMessage(loadError)}`;
      setAttemptsError(message);
      notify({ severity: 'error', message });
    } finally {
      setAttemptsLoading(false);
    }
  }

  async function save() {
    if (!settings) return;
    if (settings.quickSuggestionEnabled && !settings.quickAiEngineId) {
      setError('Оберіть ШІ движок для швидких розвіддонесень.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      setSettings(
        await saveAiIntelReportSettings({
          quickSuggestionEnabled: settings.quickSuggestionEnabled,
          quickAiEngineId: settings.quickAiEngineId,
        }),
      );
      notify({ severity: 'success', message: 'Налаштування розвіддонесень збережено.' });
    } catch (saveError) {
      const message = `Не вдалося зберегти налаштування: ${errorMessage(saveError)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <PageLoadingState />;
  if (!settings) {
    return (
      <Stack spacing={2}>
        <PowerAlert severity="error">{error ?? 'Налаштування не знайдено.'}</PowerAlert>
        <PowerButton variant="outlined" onClick={() => void load()}>
          Повторити
        </PowerButton>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <PageHeader title="Розвіддонесення" />
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      <Card variant="outlined" sx={{ borderRadius: 0 }}>
        <CardContent>
          <Stack spacing={3}>
            <FormControlLabel
              control={
                <Switch
                  checked={settings.quickSuggestionEnabled}
                  disabled={saving}
                  onChange={(_, checked) =>
                    setSettings((current) =>
                      current ? { ...current, quickSuggestionEnabled: checked } : current,
                    )
                  }
                />
              }
              label="Пропонувати розвіддонесення швидким алгоритмом"
            />
            <FormControl fullWidth disabled={saving || !settings.quickSuggestionEnabled}>
              <InputLabel id="quick-intel-report-engine-label">ШІ движок</InputLabel>
              <Select
                labelId="quick-intel-report-engine-label"
                label="ШІ движок"
                value={settings.quickAiEngineId ?? ''}
                onChange={(event) =>
                  setSettings((current) =>
                    current ? { ...current, quickAiEngineId: event.target.value || null } : current,
                  )
                }
              >
                <MenuItem value="">Не вибрано</MenuItem>
                {eligibleEngines.map((engine) => (
                  <MenuItem key={engine.id} value={engine.id}>
                    {engine.name} · {engine.modelName}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {eligibleEngines.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Немає увімкнених движків із підтримкою позивних і розвіддонесень.
              </Typography>
            ) : null}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
              <PowerButton
                variant="contained"
                disabled={saving}
                startIcon={saving ? <CircularProgress size={18} /> : undefined}
                onClick={() => void save()}
              >
                Зберегти
              </PowerButton>
            </Box>
          </Stack>
        </CardContent>
      </Card>
      <TableStateProvider
        tableId="admin-ai-intel-report-attempts"
        defaultColumnOrder={ATTEMPTS_DEFAULT_COLUMN_ORDER}
        defaultColumnVisibility={ATTEMPTS_DEFAULT_COLUMN_VISIBILITY}
        defaultEnableColumnOrdering={false}
      >
        <Stack spacing={2}>
          <TablePageToolbar
            title="Спроби швидких пропозицій"
            withGlobalTextFilter
            internalActionsDisabled={attemptsLoading && attempts.length === 0}
            actions={
              <PowerButton
                startIcon={<RefreshIcon />}
                variant="outlined"
                onClick={() => void refreshAttempts()}
                disabled={attemptsLoading}
              >
                Оновити
              </PowerButton>
            }
          />
          {attemptsError ? <PowerAlert severity="error">{attemptsError}</PowerAlert> : null}
          <AttemptsTable
            attempts={attempts}
            loading={attemptsLoading}
            onView={setSelectedAttempt}
          />
        </Stack>
      </TableStateProvider>
      <AttemptDetailsDialog attempt={selectedAttempt} onClose={() => setSelectedAttempt(null)} />
    </Stack>
  );
}
