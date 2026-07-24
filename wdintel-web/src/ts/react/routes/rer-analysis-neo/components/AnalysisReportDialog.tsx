import DownloadIcon from '@mui/icons-material/Download';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  ListItemText,
  LinearProgress,
  MenuItem,
  Select,
  Tab,
  Tabs,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useId } from 'react';

import type { User } from '../../../../../Bindings';
import { ELLIPSIS } from '../../../utils/misc';
import { hasAnyRole } from '../../../utils/roles';
import { parseUtcDateTime } from '../../../services/api/report-history';
import {
  describeAppliedReportFilters,
  REPORT_ADJACENT_FREQS_OPTIONS,
  type AnalysisReportState,
  type ReportTemplateId,
  reportTemplateToMode,
} from '../report-helpers';
import type { AnalysisQueryState } from '../types';
import type { AnalysisAorEntry, AnalysisReportTaskRun } from '../types';

const FORMING_TEXT = `Формується${ELLIPSIS}`;
const PREPARING_TEXT = `Готуємо${ELLIPSIS}`;
const QUEUED_TEXT = 'Очікує запуску';
const REPORT_HISTORY_URL = '/my-reports';

export const analysisReportDialogHintSx = {
  width: { xs: '100%', sm: 'auto' },
  flex: { xs: '0 1 auto', sm: '1 1 320px' },
  minWidth: 0,
} as const;

type Props = {
  aors: AnalysisAorEntry[];
  downloadInFlight: boolean;
  progressExpanded: boolean;
  taskRuns: AnalysisReportTaskRun[];
  open: boolean;
  currentUser: User | null;
  supportNonRerInterceptions: boolean;
  report: AnalysisReportState;
  queryState: AnalysisQueryState;
  onClose: () => void;
  onDownload: () => void;
  onRepeatTaskRun: (id: number) => Promise<void>;
  onSetProgressExpanded: (expanded: boolean) => void;
  onToggleTaskRunLogs: (id: number, expanded: boolean) => void;
  onUpdate: (patch: Partial<AnalysisReportState>) => void;
};

type StageStatus = 'success' | 'running' | 'error' | 'cancelled' | 'pending';

function extractStages(logs: string[]): Array<{ index: number; overall: number; text: string }> {
  const stages = new Map<number, { index: number; overall: number; text: string }>();
  for (const line of logs) {
    const match = /^\[(\d+)\/(\d+)\]\s*(.*)$/.exec(line);
    if (!match) continue;
    const index = Number(match[1]);
    const overall = Number(match[2]);
    if (!Number.isFinite(index) || !Number.isFinite(overall) || index <= 0 || overall <= 0)
      continue;
    stages.set(index, { index, overall, text: match[3] });
  }
  return [...stages.values()].sort((left, right) => left.index - right.index);
}

function getStageStatus(run: AnalysisReportTaskRun, stageIndex: number): StageStatus {
  if (run.running) {
    if (stageIndex < run.curr) return 'success';
    if (stageIndex === run.curr) return 'running';
    return 'pending';
  }
  if (run.cancelled) {
    if (stageIndex < run.curr) return 'success';
    if (stageIndex === run.curr) return 'cancelled';
    return 'pending';
  }
  if (run.error != null) {
    if (stageIndex < run.curr) return 'success';
    if (stageIndex === run.curr) return 'error';
    return 'pending';
  }
  return 'success';
}

function formatElapsedTime(startedAtMs: number | null): string | null {
  if (startedAtMs === null) return null;

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} с`;
  }

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes} хв ${seconds} с`;
}

function formatDurationSinceIso(value: string | null | undefined): string | null {
  const startedAt = parseUtcDateTime(value);
  if (startedAt === null) return null;
  return formatElapsedTime(startedAt.getTime());
}

function formatDateTimeLabel(value: string | null | undefined): string | null {
  const date = parseUtcDateTime(value);
  if (date === null) return null;
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

const reportTemplateOptions: Array<{ id: ReportTemplateId; title: string; description: string }> = [
  {
    id: 'tags',
    title: 'З донесенням',
    description: 'Простий перелік повідомлень разом з їх донесенням',
  },
  { id: 'pelengs', title: 'Пеленги', description: 'Таблиця з пеленгами' },
  { id: 'babak', title: 'Бабак', description: 'Детальний звіт по підрозділах' },
  { id: 'interception', title: 'Перехоплення', description: 'Звіт по перехопленнях' },
  { id: 'senders', title: 'Відправники', description: 'Аналіз відправників або постів' },
  { id: 'posts_docx', title: 'Пости', description: 'Узагальнені метрики по постах' },
  { id: 'mouse', title: 'Мишка', description: 'Детальний почастотний звіт по привʼязках' },
  { id: 'reo', title: 'РЕО', description: 'Доступно лише для розширених ролей звітів' },
  { id: 'digest', title: 'Дайджест', description: 'Доступно лише для розширених ролей звітів' },
  {
    id: 'report_125',
    title: 'Звіт 1.2.5',
    description: 'Доступно лише для розширених ролей звітів',
  },
  {
    id: 'active_networks',
    title: 'Активні радіомережі',
    description: 'Доступно лише для розширених ролей звітів',
  },
];

const exportTemplateOptions: Array<{ id: ReportTemplateId; title: string; description: string }> = [
  {
    id: 'summary_table',
    title: 'Підсумкова таблиця',
    description: 'Частоти, позивні, підрозділи, останні перехоплення й мережі',
  },
  {
    id: 'kmz',
    title: 'KMZ',
    description: 'Точки повідомлень з частотою, координатами й коментарями',
  },
  {
    id: 'geojson',
    title: 'GeoJSON',
    description: 'Точки повідомлень з частотою, координатами, мережами й коментарями',
  },
];

const ADVANCED_REPORT_ROLES = [
  'UnitsEditor',
  'CallsignsEditor',
  'AdvancedReports',
  'Admin',
] as const;

const checkboxLabelSx = {
  display: 'inline-flex',
  width: 'fit-content',
  maxWidth: '100%',
  alignSelf: 'flex-start',
  alignItems: 'center',
  gap: 1,
  flexShrink: 0,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

function ReportCheckboxLabel({
  checked,
  disabled = false,
  label,
  onChange,
  sx,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  sx?: object;
}) {
  return (
    <Box
      component="label"
      sx={{
        ...checkboxLabelSx,
        ...(sx ?? {}),
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onChange={(_event, value) => onChange(value)}
        sx={{ p: 0.5 }}
      />
      <Typography component="span" sx={{ whiteSpace: 'nowrap' }}>
        {label}
      </Typography>
    </Box>
  );
}

function canUseAdvancedReports(user: User | null): boolean {
  return hasAnyRole(user?.roles, ADVANCED_REPORT_ROLES);
}

export function AnalysisReportDialog({
  aors,
  downloadInFlight,
  progressExpanded,
  taskRuns,
  open,
  currentUser,
  supportNonRerInterceptions,
  report,
  queryState,
  onClose,
  onDownload,
  onRepeatTaskRun,
  onSetProgressExpanded,
  onToggleTaskRunLogs,
  onUpdate,
}: Props) {
  const titleId = useId().replace(/:/g, '-');
  const appliedFilters = describeAppliedReportFilters(queryState, report);
  const builderMode = reportTemplateToMode(report.template);
  const hasAdvancedReportAccess = canUseAdvancedReports(currentUser);
  const visibleReportTemplateOptions = supportNonRerInterceptions
    ? [
        ...reportTemplateOptions,
        {
          id: 'rer_report' as const,
          title: 'РЕР Звіт',
          description: 'Документ по non-RER перехопленнях з привʼязаними машинами',
        },
        {
          id: 'sposob' as const,
          title: 'Способ',
          description: 'Звіт із перехопленнями у форматі підрозділ дата час текст',
        },
      ]
    : reportTemplateOptions;
  const isBabakOrInterception = report.template === 'babak' || report.template === 'interception';
  const disableBabakUnitCommentsFilter = report.template === 'babak' && report.withoutComments;
  const showReportTagsOnlyThisUnit = [
    'tags',
    'pelengs',
    'babak',
    'interception',
    'posts_docx',
    'mouse',
    'reo',
  ].includes(report.template);
  const latestTaskRun = taskRuns.length > 0 ? taskRuns[taskRuns.length - 1] : null;
  const latestTaskRunDone = latestTaskRun != null && !latestTaskRun.running;
  const latestTaskRunCancelled = latestTaskRunDone && latestTaskRun?.cancelled === true;
  const latestTaskRunSuccess =
    latestTaskRunDone && !latestTaskRunCancelled && latestTaskRun.error == null;
  const historyTaskRuns = taskRuns.length > 1 ? taskRuns.slice(0, -1) : [];
  const historyRow = latestTaskRun?.historyRow ?? null;
  const isQueued =
    latestTaskRun != null &&
    latestTaskRun.running &&
    (historyRow == null ||
      historyRow.status === 'planned' ||
      (historyRow.status === 'in_progress' && historyRow.bgtaskId == null));
  const hasBgtask = historyRow?.bgtaskId != null;
  const isDialogLocked = downloadInFlight || latestTaskRun?.running === true;
  const isSposobUnitNameMissing =
    report.template === 'sposob' && report.sposobUnitName.trim() === '';
  const reportCreatedAtLabel = formatDateTimeLabel(historyRow?.createdAt ?? null);
  const reportQueuedForLabel = formatDurationSinceIso(historyRow?.createdAt ?? null);
  const reportStartedAtLabel = formatDateTimeLabel(historyRow?.startedAt ?? null);
  const reportPlannedForLabel = formatDateTimeLabel(historyRow?.plannedForTs ?? null);
  const progressVariant = isQueued || !hasBgtask ? 'indeterminate' : 'determinate';
  const latestProgressStage = extractStages(latestTaskRun?.logs ?? []).at(-1) ?? null;
  const progressStageLabel =
    isQueued || !hasBgtask ? QUEUED_TEXT : (latestProgressStage?.text ?? PREPARING_TEXT);
  const progressPercent = Math.max(
    1,
    Math.min(
      100,
      Math.round(((latestTaskRun?.curr ?? 0) / Math.max(1, latestTaskRun?.overall ?? 100)) * 100),
    ),
  );
  const progressSummaryLabel = isQueued
    ? historyRow?.blockedByReportId != null
      ? `Очікує завершення звіту #${historyRow.blockedByReportId} · ${formatDurationSinceIso(historyRow?.createdAt ?? null) ?? '—'}`
      : `Позиція #${historyRow?.queuePosition ?? '—'} · очікує ${formatDurationSinceIso(historyRow?.createdAt ?? null) ?? '—'}`
    : `${latestTaskRun?.curr ?? 0} / ${latestTaskRun?.overall ?? 100}`;
  const downloadButtonLabel =
    builderMode === 'exports'
      ? 'Завантажити'
      : report.template === 'summary_table'
        ? 'Завантажити xlsx'
        : report.template === 'kmz'
          ? 'Завантажити KMZ'
          : report.template === 'geojson'
            ? 'Завантажити GeoJSON'
            : 'Завантажити docx/xlsx';
  const mobileDownloadLabel =
    builderMode === 'exports'
      ? 'Завантажити'
      : report.template === 'summary_table'
        ? 'XLSX'
        : report.template === 'kmz'
          ? 'KMZ'
          : report.template === 'geojson'
            ? 'GEOJSON'
            : 'DOCX/XLSX';
  const downloadButtonAriaLabel = downloadInFlight
    ? PREPARING_TEXT
    : builderMode === 'exports'
      ? 'Завантажити'
      : undefined;

  return (
    <Dialog
      open={open}
      onClose={(_event, reason) => {
        if ((reason === 'backdropClick' || reason === 'escapeKeyDown') && isDialogLocked) {
          return;
        }
        onClose();
      }}
      disableEscapeKeyDown={isDialogLocked}
      fullWidth
      maxWidth="lg"
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>Конструктор звітів</DialogTitle>
      <DialogContent dividers sx={{ pt: 0 }}>
        <Stack spacing={3}>
          <Stack spacing={1.5}>
            <Tabs
              value={builderMode}
              onChange={(_event, value) =>
                onUpdate({ template: value === 'exports' ? 'summary_table' : 'tags' })
              }
              variant="scrollable"
              allowScrollButtonsMobile
            >
              <Tab value="reports" label="Звіти" />
              <Tab value="exports" label="Експорт" />
            </Tabs>
            <Typography variant="body2" color="text.secondary">
              Переглядайте свої звіти в{' '}
              <Box
                component="a"
                href={REPORT_HISTORY_URL}
                sx={{
                  color: 'primary.main',
                  textDecoration: 'none',
                  '&:hover': { textDecoration: 'underline' },
                }}
              >
                Мої звіти
              </Box>
            </Typography>

            {builderMode === 'reports' ? (
              <Stack spacing={1}>
                <Stack direction={{ xs: 'column', md: 'row' }} flexWrap="wrap" gap={1.5}>
                  {visibleReportTemplateOptions.map((option) => (
                    <Button
                      key={option.id}
                      variant={report.template === option.id ? 'contained' : 'outlined'}
                      disabled={
                        ['reo', 'digest', 'report_125', 'active_networks'].includes(option.id) &&
                        !hasAdvancedReportAccess
                      }
                      onClick={() => onUpdate({ template: option.id })}
                      sx={{
                        alignItems: 'flex-start',
                        justifyContent: 'flex-start',
                        textAlign: 'left',
                        p: 2,
                        minWidth: 0,
                        width: 'fit-content',
                      }}
                    >
                      <Stack alignItems="flex-start" spacing={0.75}>
                        <Typography variant="subtitle2">{option.title}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {option.description}
                        </Typography>
                      </Stack>
                    </Button>
                  ))}
                </Stack>
              </Stack>
            ) : (
              <Stack direction={{ xs: 'column', md: 'row' }} flexWrap="wrap" gap={1.5}>
                {exportTemplateOptions.map((option) => (
                  <Button
                    key={option.id}
                    variant={report.template === option.id ? 'contained' : 'outlined'}
                    onClick={() => onUpdate({ template: option.id })}
                    sx={{
                      alignItems: 'flex-start',
                      justifyContent: 'flex-start',
                      textAlign: 'left',
                      p: 2,
                      minWidth: 0,
                      width: 'fit-content',
                    }}
                  >
                    <Stack alignItems="flex-start" spacing={0.75}>
                      <Typography variant="subtitle2">{option.title}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {option.description}
                      </Typography>
                    </Stack>
                  </Button>
                ))}
              </Stack>
            )}
          </Stack>

          {report.template === 'tags' ? (
            <FormControl size="small" sx={{ flex: '1 1 220px', maxWidth: 320, minWidth: 220 }}>
              <InputLabel id="analysis-report-tag-sort-label">Сортування</InputLabel>
              <Select
                labelId="analysis-report-tag-sort-label"
                label="Сортування"
                value={report.tagReportSortBy}
                onChange={(event) =>
                  onUpdate({
                    tagReportSortBy: event.target.value as AnalysisReportState['tagReportSortBy'],
                  })
                }
              >
                <MenuItem value="ByTime">За Часом</MenuItem>
                <MenuItem value="ByFreqThenTime">За Частотою Та Часом</MenuItem>
              </Select>
            </FormControl>
          ) : null}

          {report.template === 'sposob' ? (
            <TextField
              label="Назва підрозділу"
              size="small"
              required
              value={report.sposobUnitName}
              onChange={(event) => onUpdate({ sposobUnitName: event.target.value })}
              error={isSposobUnitNameMissing}
              helperText={isSposobUnitNameMissing ? 'Обовʼязково для звіту Способ' : undefined}
              sx={{ maxWidth: 360 }}
            />
          ) : null}

          {report.template === 'senders' ? (
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1.5}
              alignItems={{ sm: 'center' }}
              flexWrap="wrap"
            >
              <FormControl size="small" sx={{ flex: '1 1 240px', maxWidth: 300, minWidth: 220 }}>
                <InputLabel id="analysis-report-aggregation-label">Агрегація</InputLabel>
                <Select
                  labelId="analysis-report-aggregation-label"
                  label="Агрегація"
                  value={report.senderAggregation}
                  onChange={(event) =>
                    onUpdate({
                      senderAggregation: event.target
                        .value as AnalysisReportState['senderAggregation'],
                    })
                  }
                >
                  <MenuItem value="ByProfile">Профілі</MenuItem>
                  <MenuItem value="ByPost">Пости</MenuItem>
                </Select>
              </FormControl>
              <ReportCheckboxLabel
                checked={report.senderAdvancedFreqs}
                label="Розширений звіт"
                onChange={(value) => onUpdate({ senderAdvancedFreqs: value })}
              />
            </Stack>
          ) : null}

          {report.template === 'reo' ? (
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1.5}
              alignItems={{ sm: 'center' }}
              flexWrap="wrap"
            >
              <FormControl size="small" sx={{ flex: '1 1 180px', maxWidth: 240, minWidth: 180 }}>
                <InputLabel id="analysis-report-reo-adjacent-label">Суміжні частоти</InputLabel>
                <Select
                  labelId="analysis-report-reo-adjacent-label"
                  label="Суміжні частоти"
                  value={String(report.reoAdjacentFreqsDistance)}
                  onChange={(event) =>
                    onUpdate({ reoAdjacentFreqsDistance: Number(event.target.value) })
                  }
                >
                  {REPORT_ADJACENT_FREQS_OPTIONS.map((option) => (
                    <MenuItem key={option} value={String(option)}>
                      {(option * 1000).toFixed(option === 0 ? 0 : 1)} кГц
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ flex: '1 1 180px', maxWidth: 220, minWidth: 180 }}>
                <InputLabel id="analysis-report-reo-file-label">Формат</InputLabel>
                <Select
                  labelId="analysis-report-reo-file-label"
                  label="Формат"
                  value={report.reoFileType}
                  onChange={(event) =>
                    onUpdate({
                      reoFileType: event.target.value as AnalysisReportState['reoFileType'],
                    })
                  }
                >
                  <MenuItem value="Docx">docx</MenuItem>
                  <MenuItem value="Xlsx">xlsx</MenuItem>
                </Select>
              </FormControl>
              <ReportCheckboxLabel
                checked={report.reoNoComments}
                label="Без коментарів"
                onChange={(value) => onUpdate({ reoNoComments: value })}
              />
            </Stack>
          ) : null}

          {report.template === 'active_networks' ? (
            <Stack spacing={0.75}>
              <FormControl size="small" sx={{ maxWidth: 320 }}>
                <InputLabel id="analysis-report-aors-label">Смуги відповідальності</InputLabel>
                <Select
                  labelId="analysis-report-aors-label"
                  label="Смуги відповідальності"
                  multiple
                  value={report.activeNetworksAorIds.map(String)}
                  onChange={(event) =>
                    onUpdate({
                      activeNetworksAorIds: (event.target.value as string[])
                        .map((value) => Number(value))
                        .filter(Number.isFinite),
                    })
                  }
                  renderValue={(selected) =>
                    (selected as string[])
                      .map((value) => aors.find((aor) => aor.id === Number(value))?.name ?? value)
                      .join(', ')
                  }
                >
                  {aors.map((aor) => (
                    <MenuItem key={aor.id} value={String(aor.id)}>
                      <Checkbox checked={report.activeNetworksAorIds.includes(aor.id)} />
                      <ListItemText primary={aor.name} />
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {appliedFilters.inPlaceHints.map((hint) => (
                <Typography key={hint} variant="caption" color="text.secondary">
                  {hint}
                </Typography>
              ))}
            </Stack>
          ) : null}

          {showReportTagsOnlyThisUnit ? (
            isBabakOrInterception ? (
              <Stack spacing={0.5}>
                <ReportCheckboxLabel
                  checked={report.reportTagsOnlyThisUnit}
                  disabled={disableBabakUnitCommentsFilter}
                  label="Лише теги/коментарі мого підрозділу"
                  onChange={(value) => onUpdate({ reportTagsOnlyThisUnit: value })}
                  sx={{
                    opacity: disableBabakUnitCommentsFilter ? 0.5 : 1,
                  }}
                />
                {(() => {
                  const hint = appliedFilters.inPlaceHints.find((item) =>
                    item.startsWith('Лише для цього звіту'),
                  );
                  return hint ? (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', ml: 4.5 }}
                    >
                      {hint}
                    </Typography>
                  ) : null;
                })()}
                {report.template === 'babak' ? (
                  <ReportCheckboxLabel
                    checked={report.withoutComments}
                    label="Не включати коментарі"
                    onChange={(value) =>
                      onUpdate({
                        withoutComments: value,
                        reportTagsOnlyThisUnit: value ? false : report.reportTagsOnlyThisUnit,
                      })
                    }
                  />
                ) : null}
                <ReportCheckboxLabel
                  checked={report.withoutModelTags}
                  label="Без автоматичних тегів"
                  onChange={(value) => onUpdate({ withoutModelTags: value })}
                />
                {report.template === 'interception' ? (
                  <>
                    <ReportCheckboxLabel
                      checked={report.interceptionKeepFullMessage}
                      label="Повний текст повідомлення"
                      onChange={(value) => onUpdate({ interceptionKeepFullMessage: value })}
                    />
                    <ReportCheckboxLabel
                      checked={report.interceptionKeepOldColors}
                      label="Залишити старі кольори"
                      onChange={(value) => onUpdate({ interceptionKeepOldColors: value })}
                    />
                  </>
                ) : null}
                {(() => {
                  const hint = appliedFilters.inPlaceHints.find((item) =>
                    item.startsWith('Без автоматичних тегів'),
                  );
                  return hint ? (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', ml: 4.5 }}
                    >
                      {hint}
                    </Typography>
                  ) : null;
                })()}
              </Stack>
            ) : (
              <Stack spacing={0.5}>
                <ReportCheckboxLabel
                  checked={report.reportTagsOnlyThisUnit}
                  label="Лише теги/коментарі мого підрозділу"
                  onChange={(value) => onUpdate({ reportTagsOnlyThisUnit: value })}
                />
                {(() => {
                  const hint = appliedFilters.inPlaceHints.find((item) =>
                    item.startsWith('Лише для цього звіту'),
                  );
                  return hint ? (
                    <Typography variant="caption" color="text.secondary">
                      {hint}
                    </Typography>
                  ) : null;
                })()}
              </Stack>
            )
          ) : null}

          {latestTaskRun != null ? (
            <Stack spacing={1}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
                <Typography variant="body2" noWrap sx={{ minWidth: 0, fontWeight: 600 }}>
                  {latestTaskRun.reportName}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    flexShrink: 0,
                    color: latestTaskRun.error
                      ? 'error.main'
                      : latestTaskRunCancelled
                        ? 'warning.main'
                        : latestTaskRunSuccess
                          ? 'success.main'
                          : 'text.secondary',
                  }}
                >
                  {latestTaskRun.error
                    ? 'Помилка'
                    : latestTaskRunCancelled
                      ? 'Скасовано'
                      : isQueued
                        ? QUEUED_TEXT
                        : latestTaskRun.running
                          ? FORMING_TEXT
                          : 'Готово'}
                </Typography>
              </Stack>

              <LinearProgress
                variant={progressVariant}
                color={
                  latestTaskRun.error
                    ? 'error'
                    : latestTaskRunCancelled
                      ? 'warning'
                      : latestTaskRunSuccess
                        ? 'success'
                        : 'primary'
                }
                value={progressVariant === 'determinate' ? progressPercent : undefined}
                sx={
                  latestTaskRun.running && progressVariant === 'determinate'
                    ? { '& .MuiLinearProgress-bar': { transition: 'none' } }
                    : undefined
                }
              />

              <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
                <Typography variant="body2" color="text.secondary">
                  {progressSummaryLabel}
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Button
                    size="small"
                    onClick={() => void onRepeatTaskRun(latestTaskRun.id)}
                    disabled={downloadInFlight || latestTaskRun.running}
                  >
                    Сформувати повторно
                  </Button>
                  <Button size="small" onClick={() => onSetProgressExpanded(!progressExpanded)}>
                    {progressExpanded ? 'Сховати деталі' : 'Показати деталі'}
                  </Button>
                </Stack>
              </Stack>

              {latestTaskRun.error ? <Alert severity="error">{latestTaskRun.error}</Alert> : null}
              {isQueued &&
              historyRow?.createdAt != null &&
              Date.now() - parseUtcDateTime(historyRow.createdAt)!.getTime() >= 5 * 60 * 1000 ? (
                <Alert severity="warning">
                  Звіт ще не стартував. Перевірте його стан у Мої звіти.
                </Alert>
              ) : null}

              {progressExpanded ? (
                <Stack spacing={1}>
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: {
                        xs: '1fr',
                        sm: 'repeat(2, minmax(0, 1fr))',
                        md: 'repeat(3, minmax(0, 1fr))',
                      },
                      gap: 1,
                      p: 1.5,
                      borderRadius: 2,
                      border: '1px solid',
                      borderColor: 'divider',
                      bgcolor: 'background.default',
                    }}
                  >
                    <Stack spacing={0.25}>
                      <Typography variant="caption" color="text.secondary">
                        ID звіту
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {historyRow?.id != null ? `#${historyRow.id}` : '—'}
                      </Typography>
                    </Stack>
                    <Stack spacing={0.25}>
                      <Typography variant="caption" color="text.secondary">
                        Черга
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {historyRow?.queuePosition != null ? `#${historyRow.queuePosition}` : '—'}
                      </Typography>
                    </Stack>
                    <Stack spacing={0.25}>
                      <Typography variant="caption" color="text.secondary">
                        Створено
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {reportCreatedAtLabel ?? '—'}
                      </Typography>
                    </Stack>
                    <Stack spacing={0.25}>
                      <Typography variant="caption" color="text.secondary">
                        Очікує
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {reportQueuedForLabel ?? '—'}
                      </Typography>
                    </Stack>
                    <Stack spacing={0.25}>
                      <Typography variant="caption" color="text.secondary">
                        Початок
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {reportStartedAtLabel ?? '—'}
                      </Typography>
                    </Stack>
                    <Stack spacing={0.25}>
                      <Typography variant="caption" color="text.secondary">
                        Заплановано
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {reportPlannedForLabel ?? '—'}
                      </Typography>
                    </Stack>
                    <Stack spacing={0.25}>
                      <Typography variant="caption" color="text.secondary">
                        ID задачі
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {historyRow?.bgtaskId != null ? `#${historyRow.bgtaskId}` : '—'}
                      </Typography>
                    </Stack>
                    <Stack spacing={0.25}>
                      <Typography variant="caption" color="text.secondary">
                        Триває
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {formatElapsedTime(
                          isQueued
                            ? (parseUtcDateTime(historyRow?.createdAt ?? null)?.getTime() ?? null)
                            : latestTaskRun.startedAt
                              ? (parseUtcDateTime(latestTaskRun.startedAt)?.getTime() ?? null)
                              : null,
                        ) ?? '—'}
                      </Typography>
                    </Stack>
                    <Stack spacing={0.25}>
                      <Typography variant="caption" color="text.secondary">
                        Логи
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {latestTaskRun.logs.length}
                      </Typography>
                    </Stack>
                    <Stack spacing={0.25}>
                      <Typography variant="caption" color="text.secondary">
                        Етап
                      </Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {progressStageLabel}
                      </Typography>
                    </Stack>
                  </Box>

                  {[latestTaskRun, ...historyTaskRuns.slice().reverse()].map((run) => {
                    const runQueued =
                      run.running &&
                      (run.historyRow == null ||
                        run.historyRow.status === 'planned' ||
                        (run.historyRow.status === 'in_progress' &&
                          run.historyRow.bgtaskId == null));
                    const stages = extractStages(run.logs);
                    return (
                      <Accordion
                        key={run.id}
                        disableGutters
                        elevation={0}
                        expanded={run.expanded}
                        onChange={(_event, expanded) => onToggleTaskRunLogs(run.id, expanded)}
                        sx={{
                          '&:before': { display: 'none' },
                          border: 1,
                          borderColor: 'divider',
                          borderRadius: 1,
                        }}
                      >
                        <AccordionSummary
                          expandIcon={<ExpandMoreIcon />}
                          sx={{ minHeight: 44, '& .MuiAccordionSummary-content': { my: 0.5 } }}
                        >
                          <Stack
                            width="100%"
                            direction="row"
                            justifyContent="space-between"
                            alignItems="center"
                            spacing={2}
                          >
                            <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                              <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                                {run.reportTitle}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                {run.startedAt ? (formatDateTimeLabel(run.startedAt) ?? '—') : '—'}
                              </Typography>
                            </Stack>
                            <Typography
                              variant="caption"
                              color={
                                run.error
                                  ? 'error.main'
                                  : run.cancelled
                                    ? 'warning.main'
                                    : run.running
                                      ? 'warning.main'
                                      : 'success.main'
                              }
                            >
                              {run.error
                                ? 'Помилка'
                                : run.cancelled
                                  ? 'Скасовано'
                                  : runQueued
                                    ? QUEUED_TEXT
                                    : run.running
                                      ? FORMING_TEXT
                                      : 'Успішно'}
                            </Typography>
                          </Stack>
                        </AccordionSummary>
                        <AccordionDetails sx={{ pt: 0 }}>
                          <Stack spacing={1}>
                            {stages.map((stage) => {
                              const status = getStageStatus(run, stage.index);
                              return (
                                <Stack key={`${run.id}-${stage.index}`} spacing={0.5}>
                                  <Stack direction="row" alignItems="center" spacing={1}>
                                    {status === 'success' ? (
                                      <CheckCircleIcon color="success" fontSize="small" />
                                    ) : status === 'error' ? (
                                      <HighlightOffIcon color="error" fontSize="small" />
                                    ) : status === 'cancelled' ? (
                                      <HighlightOffIcon color="warning" fontSize="small" />
                                    ) : status === 'running' ? (
                                      <CircularProgress size={14} />
                                    ) : (
                                      <Typography variant="caption" color="text.disabled">
                                        ○
                                      </Typography>
                                    )}
                                    <Typography
                                      variant="caption"
                                      color={
                                        status === 'error'
                                          ? 'error.main'
                                          : status === 'cancelled'
                                            ? 'warning.main'
                                            : 'text.secondary'
                                      }
                                    >
                                      [{stage.index}/{stage.overall}] {stage.text}
                                    </Typography>
                                  </Stack>
                                  {status === 'error' && run.error ? (
                                    <Alert severity="error">{run.error}</Alert>
                                  ) : null}
                                </Stack>
                              );
                            })}
                            <Stack direction="row" justifyContent="flex-end">
                              <Button
                                size="small"
                                onClick={() => void onRepeatTaskRun(run.id)}
                                disabled={downloadInFlight || run.running}
                              >
                                Сформувати повторно
                              </Button>
                            </Stack>
                          </Stack>
                        </AccordionDetails>
                      </Accordion>
                    );
                  })}
                </Stack>
              ) : null}
            </Stack>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Typography variant="caption" color="text.secondary" sx={analysisReportDialogHintSx}>
          {appliedFilters.globalHint}
        </Typography>
        <Stack
          direction="row"
          spacing={{ xs: 0.5, sm: 1.5 }}
          alignItems="center"
          justifyContent="flex-end"
          sx={{ width: { xs: '100%', sm: 'auto' }, flexShrink: 0 }}
        >
          <Button onClick={onClose}>Закрити</Button>
          <Button
            variant="contained"
            startIcon={<DownloadIcon />}
            onClick={onDownload}
            disabled={downloadInFlight || isSposobUnitNameMissing}
            aria-label={downloadButtonAriaLabel}
            title={builderMode === 'exports' ? 'Завантажити' : undefined}
          >
            <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
              {downloadInFlight ? PREPARING_TEXT : downloadButtonLabel}
            </Box>
            <Box
              component="span"
              sx={{ display: { xs: 'inline', sm: 'none' } }}
              aria-hidden={downloadInFlight ? true : undefined}
            >
              {downloadInFlight ? PREPARING_TEXT : mobileDownloadLabel}
            </Box>
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
