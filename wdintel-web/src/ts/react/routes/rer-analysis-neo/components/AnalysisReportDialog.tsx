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
  Typography,
} from '@mui/material';
import { useId } from 'react';

import type { User } from '../../../../../Bindings';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';
import {
  describeAppliedReportFilters,
  REPORT_ADJACENT_FREQS_OPTIONS,
  type AnalysisReportState,
  type ReportTemplateId,
  reportTemplateToMode,
} from '../report-helpers';
import type { AnalysisQueryState } from '../types';
import type { AnalysisAorEntry, AnalysisReportTaskRun } from '../types';

type Props = {
  aors: AnalysisAorEntry[];
  downloadInFlight: boolean;
  progressExpanded: boolean;
  taskRuns: AnalysisReportTaskRun[];
  open: boolean;
  currentUser: User | null;
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
    if (!Number.isFinite(index) || !Number.isFinite(overall) || index <= 0 || overall <= 0) continue;
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

function formatRunStartedAt(iso: string): string {
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(iso));
}

const reportTemplateOptions: Array<{ id: ReportTemplateId; title: string; description: string }> = [
  { id: 'tags', title: 'З донесенням', description: 'Простий перелік повідомлень разом з їх донесенням' },
  { id: 'pelengs', title: 'Пеленги', description: 'Таблиця з пеленгами' },
  { id: 'babak', title: 'Бабак', description: 'Детальний звіт по підрозділах' },
  { id: 'interception', title: 'Перехоплення', description: 'Звіт по перехопленнях' },
  { id: 'senders', title: 'Відправники', description: 'Аналіз відправників або постів' },
  { id: 'posts_docx', title: 'Пости', description: 'Узагальнені метрики по постах' },
  { id: 'mouse', title: 'Мишка', description: 'Детальний почастотний звіт по привʼязках' },
  { id: 'reo', title: 'РЕО', description: 'Доступно лише для розширених ролей звітів' },
  { id: 'digest', title: 'Дайджест', description: 'Доступно лише для розширених ролей звітів' },
  { id: 'active_networks', title: 'Активні радіомережі', description: 'Доступно лише для розширених ролей звітів' },
];

const exportTemplateOptions: Array<{ id: ReportTemplateId; title: string; description: string }> = [
  { id: 'summary_table', title: 'Підсумкова таблиця', description: 'Частоти, позивні, підрозділи, останні перехоплення й мережі' },
  { id: 'kmz', title: 'KMZ', description: 'Точки повідомлень з частотою, координатами й коментарями' },
  { id: 'geojson', title: 'GeoJSON', description: 'Точки повідомлень з частотою, координатами, мережами й коментарями' },
];

const ADVANCED_REPORT_ROLES = ['UnitsEditor', 'CallsignsEditor', 'AdvancedReports', 'Admin'] as const;

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
  return ADVANCED_REPORT_ROLES.some((role) => Boolean(user?.roles.includes(role)));
}

export function AnalysisReportDialog({
  aors,
  downloadInFlight,
  progressExpanded,
  taskRuns,
  open,
  currentUser,
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
  const isBabakOrInterception = report.template === 'babak' || report.template === 'interception';
  const disableBabakUnitCommentsFilter = report.template === 'babak' && report.withoutComments;
  const showReportTagsOnlyThisUnit = ['tags', 'pelengs', 'babak', 'interception', 'posts_docx', 'mouse', 'reo'].includes(report.template);
  const latestTaskRun = taskRuns.length > 0 ? taskRuns[taskRuns.length - 1] : null;
  const latestTaskRunDone = latestTaskRun != null && !latestTaskRun.running;
  const latestTaskRunCancelled = latestTaskRunDone && latestTaskRun?.cancelled === true;
  const latestTaskRunSuccess = latestTaskRunDone && !latestTaskRunCancelled && latestTaskRun.error == null;
  const historyTaskRuns = taskRuns.length > 1 ? taskRuns.slice(0, -1) : [];
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

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>Конструктор звітів</DialogTitle>
      <DialogContent dividers sx={{ pt: 0 }}>
        <Stack spacing={3}>
          <Stack spacing={1.5}>
            <Tabs
              value={builderMode}
              onChange={(_event, value) => onUpdate({ template: value === 'exports' ? 'summary_table' : 'tags' })}
              variant="scrollable"
              allowScrollButtonsMobile
            >
              <Tab value="reports" label="Звіти" />
              <Tab value="exports" label="Експорт" />
            </Tabs>

            {builderMode === 'reports' ? (
              <Stack spacing={1}>
                <Stack direction={{ xs: 'column', md: 'row' }} flexWrap="wrap" gap={1.5}>
                  {reportTemplateOptions.map((option) => (
                    <Button
                      key={option.id}
                      variant={report.template === option.id ? 'contained' : 'outlined'}
                      disabled={['reo', 'digest', 'active_networks'].includes(option.id) && !hasAdvancedReportAccess}
                      onClick={() => onUpdate({ template: option.id })}
                      sx={{ alignItems: 'flex-start', justifyContent: 'flex-start', textAlign: 'left', p: 2, minWidth: 0, width: 'fit-content' }}
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
                    sx={{ alignItems: 'flex-start', justifyContent: 'flex-start', textAlign: 'left', p: 2, minWidth: 0, width: 'fit-content' }}
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

          {report.template === 'senders' ? (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }} flexWrap="wrap">
              <FormControl size="small" sx={{ flex: '1 1 240px', maxWidth: 300, minWidth: 220 }}>
                <InputLabel id="analysis-report-aggregation-label">Агрегація</InputLabel>
                <Select
                  labelId="analysis-report-aggregation-label"
                  label="Агрегація"
                  value={report.senderAggregation}
                  onChange={(event) => onUpdate({ senderAggregation: event.target.value as AnalysisReportState['senderAggregation'] })}
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
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }} flexWrap="wrap">
              <FormControl size="small" sx={{ flex: '1 1 180px', maxWidth: 240, minWidth: 180 }}>
                <InputLabel id="analysis-report-reo-adjacent-label">Суміжні частоти</InputLabel>
                <Select
                  labelId="analysis-report-reo-adjacent-label"
                  label="Суміжні частоти"
                  value={String(report.reoAdjacentFreqsDistance)}
                  onChange={(event) => onUpdate({ reoAdjacentFreqsDistance: Number(event.target.value) })}
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
                  onChange={(event) => onUpdate({ reoFileType: event.target.value as AnalysisReportState['reoFileType'] })}
                >
                  <MenuItem value="Docx">docx</MenuItem>
                  <MenuItem value="Xlsx">xlsx</MenuItem>
                </Select>
              </FormControl>
              <ReportCheckboxLabel checked={report.reoNoComments} label="Без коментарів" onChange={(value) => onUpdate({ reoNoComments: value })} />
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
                    onUpdate({ activeNetworksAorIds: (event.target.value as string[]).map((value) => Number(value)).filter(Number.isFinite) })
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
                  const hint = appliedFilters.inPlaceHints.find((item) => item.startsWith('Лише для цього звіту'));
                  return hint ? (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', ml: 4.5 }}>
                      {hint}
                    </Typography>
                  ) : null;
                })()}
                {report.template === 'babak' ? (
                  <ReportCheckboxLabel
                    checked={report.withoutComments}
                    label="Не включати коментарі"
                    onChange={(value) => onUpdate({ withoutComments: value, reportTagsOnlyThisUnit: value ? false : report.reportTagsOnlyThisUnit })}
                  />
                ) : null}
                <ReportCheckboxLabel
                  checked={report.withoutModelTags}
                  label="Без автоматичних тегів"
                  onChange={(value) => onUpdate({ withoutModelTags: value })}
                />
                {(() => {
                  const hint = appliedFilters.inPlaceHints.find((item) => item.startsWith('Без автоматичних тегів'));
                  return hint ? (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', ml: 4.5 }}>
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
                  const hint = appliedFilters.inPlaceHints.find((item) => item.startsWith('Лише для цього звіту'));
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
                    color: latestTaskRun.error ? 'error.main' : latestTaskRunCancelled ? 'warning.main' : latestTaskRunSuccess ? 'success.main' : 'text.secondary',
                  }}
                >
                  {latestTaskRun.error ? 'Помилка' : latestTaskRunCancelled ? 'Скасовано' : latestTaskRun.running ? 'Формується…' : 'Готово'}
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                color={latestTaskRun.error ? 'error' : latestTaskRunCancelled ? 'warning' : latestTaskRunSuccess ? 'success' : 'primary'}
                value={Math.max(1, Math.min(100, Math.round((latestTaskRun.curr / Math.max(1, latestTaskRun.overall)) * 100)))}
                sx={latestTaskRun.running ? { '& .MuiLinearProgress-bar': { transition: 'none' } } : undefined}
              />
              <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
                <Typography variant="body2" color="text.secondary">
                  {latestTaskRun.curr} / {latestTaskRun.overall}
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Button size="small" onClick={() => void onRepeatTaskRun(latestTaskRun.id)} disabled={downloadInFlight || latestTaskRun.running}>
                    Сформувати повторно
                  </Button>
                  <Button size="small" onClick={() => onSetProgressExpanded(!progressExpanded)}>
                    {progressExpanded ? 'Сховати деталі' : 'Показати деталі'}
                  </Button>
                </Stack>
              </Stack>
              {latestTaskRun.error ? <Alert severity="error">{latestTaskRun.error}</Alert> : null}
                  {progressExpanded ? (
                <Stack spacing={1}>
                  {[latestTaskRun, ...historyTaskRuns.slice().reverse()].map((run) => {
                    const stages = extractStages(run.logs);
                    return (
                      <Accordion
                        key={run.id}
                        disableGutters
                        elevation={0}
                        expanded={run.expanded}
                        onChange={(_event, expanded) => onToggleTaskRunLogs(run.id, expanded)}
                        sx={{ '&:before': { display: 'none' }, border: 1, borderColor: 'divider', borderRadius: 1 }}
                      >
                        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 44, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
                          <Stack width="100%" direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
                            <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                              <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                                {run.reportTitle}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                {formatRunStartedAt(run.startedAt)}
                              </Typography>
                            </Stack>
                            <Typography variant="caption" color={run.error ? 'error.main' : run.cancelled ? 'warning.main' : run.running ? 'warning.main' : 'success.main'}>
                              {run.error ? 'Помилка' : run.cancelled ? 'Скасовано' : run.running ? 'Формується…' : 'Успішно'}
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
                                    <Typography variant="caption" color={status === 'error' ? 'error.main' : status === 'cancelled' ? 'warning.main' : 'text.secondary'}>
                                      [{stage.index}/{stage.overall}] {stage.text}
                                    </Typography>
                                  </Stack>
                                  {status === 'error' && run.error ? <Alert severity="error">{run.error}</Alert> : null}
                                </Stack>
                              );
                            })}
                            <Stack direction="row" justifyContent="flex-end">
                              <Button size="small" onClick={() => void onRepeatTaskRun(run.id)} disabled={downloadInFlight || run.running}>
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
      <DialogActions
        sx={{
          ...(STANDARD_DIALOG_ACTIONS_SX as Record<string, unknown>),
          gap: 2,
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ flex: '1 1 320px', minWidth: 0 }}>
          {appliedFilters.globalHint}
        </Typography>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexShrink: 0 }}>
          <Button onClick={onClose}>Закрити</Button>
          <Button variant="contained" startIcon={<DownloadIcon />} onClick={onDownload} disabled={downloadInFlight}>
            {downloadInFlight ? 'Готуємо...' : downloadButtonLabel}
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
