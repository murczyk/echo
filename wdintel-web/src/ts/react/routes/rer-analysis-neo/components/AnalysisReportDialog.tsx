import DownloadIcon from '@mui/icons-material/Download';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  ListItemText,
  LinearProgress,
  MenuItem,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import { useId } from 'react';

import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';
import {
  REPORT_ADJACENT_FREQS_OPTIONS,
  type AnalysisReportState,
  type ReportTemplateId,
} from '../report-helpers';
import type { AnalysisAorEntry, AnalysisReportTaskRun } from '../types';

type Props = {
  aors: AnalysisAorEntry[];
  downloadInFlight: boolean;
  progressExpanded: boolean;
  taskRuns: AnalysisReportTaskRun[];
  open: boolean;
  report: AnalysisReportState;
  onClose: () => void;
  onCancelTaskRun: (id: number) => void;
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

const templateOptions: Array<{ id: ReportTemplateId; title: string; description: string }> = [
  { id: 'tags', title: 'З донесенням', description: 'Простий перелік повідомлень разом з їх донесенням' },
  { id: 'pelengs', title: 'Пеленги', description: 'Таблиця з пеленгами' },
  { id: 'babak', title: 'Бабак', description: 'Детальний звіт по підрозділах' },
  { id: 'interception', title: 'Перехоплення', description: 'Звіт по перехопленнях' },
  { id: 'senders', title: 'Відправники', description: 'Аналіз відправників або постів' },
  { id: 'posts_docx', title: 'Пости', description: 'Docx-звіт з узагальненими метриками по постах' },
  { id: 'mouse', title: 'Мишка', description: 'Детальний почастотний звіт по привʼязках' },
  { id: 'reo', title: 'РЕО', description: 'Потрібні права редактора чи адміна' },
  { id: 'digest', title: 'Дайджест', description: 'Потрібні права редактора чи адміна' },
  { id: 'active_networks', title: 'Активні радіомережі', description: 'Потрібні права редактора чи адміна' },
  { id: 'summary_table', title: 'Підсумкова таблиця', description: 'XLSX-експорт підсумкової таблиці без обмеження в 1 тиждень' },
];

export function AnalysisReportDialog({
  aors,
  downloadInFlight,
  progressExpanded,
  taskRuns,
  open,
  report,
  onClose,
  onCancelTaskRun,
  onDownload,
  onRepeatTaskRun,
  onSetProgressExpanded,
  onToggleTaskRunLogs,
  onUpdate,
}: Props) {
  const titleId = useId().replace(/:/g, '-');
  const latestTaskRun = taskRuns.length > 0 ? taskRuns[taskRuns.length - 1] : null;
  const latestTaskRunDone = latestTaskRun != null && !latestTaskRun.running;
  const latestTaskRunCancelled = latestTaskRunDone && latestTaskRun?.cancelled === true;
  const latestTaskRunSuccess = latestTaskRunDone && !latestTaskRunCancelled && latestTaskRun.error == null;
  const historyTaskRuns = taskRuns.length > 1 ? taskRuns.slice(0, -1) : [];

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>Конструктор звітів</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={3}>
          <Stack spacing={1.5}>
            <Typography variant="subtitle1">Шаблон</Typography>
            <Stack direction={{ xs: 'column', md: 'row' }} flexWrap="wrap" gap={1.5}>
              {templateOptions.map((option) => (
                <Button
                  key={option.id}
                  variant={report.template === option.id ? 'contained' : 'outlined'}
                  onClick={() => onUpdate({ template: option.id })}
                  sx={{ alignItems: 'flex-start', justifyContent: 'flex-start', textAlign: 'left', p: 2, minWidth: 220 }}
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

          {report.template === 'senders' ? (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <FormControl fullWidth size="small">
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
              <FormControlLabel
                control={<Checkbox checked={report.senderAdvancedFreqs} onChange={(_event, value) => onUpdate({ senderAdvancedFreqs: value })} />}
                label="Розширений звіт"
              />
            </Stack>
          ) : null}

          {report.template === 'reo' ? (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <FormControl fullWidth size="small">
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
              <FormControl fullWidth size="small">
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
              <FormControlLabel
                control={<Checkbox checked={report.reoNoComments} onChange={(_event, value) => onUpdate({ reoNoComments: value })} />}
                label="Без коментарів"
              />
            </Stack>
          ) : null}

          {report.template === 'active_networks' ? (
            <FormControl fullWidth size="small">
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
          ) : null}

          {['tags', 'pelengs', 'babak', 'interception', 'posts_docx', 'mouse', 'reo'].includes(report.template) ? (
            <Stack spacing={0.5}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={report.reportTagsOnlyThisUnit}
                    disabled={report.template === 'babak' && report.withoutComments}
                    onChange={(_event, value) => onUpdate({ reportTagsOnlyThisUnit: value })}
                  />
                }
                label="Лише теги/коментарі мого підрозділу"
              />
              {report.template === 'babak' ? (
                <FormControlLabel
                  control={<Checkbox checked={report.withoutComments} onChange={(_event, value) => onUpdate({ withoutComments: value, reportTagsOnlyThisUnit: value ? false : report.reportTagsOnlyThisUnit })} />}
                  label="Не включати коментарі"
                />
              ) : null}
            </Stack>
          ) : null}

          {['babak', 'interception'].includes(report.template) ? (
            <FormControlLabel
              control={<Checkbox checked={report.withoutModelTags} onChange={(_event, value) => onUpdate({ withoutModelTags: value })} />}
              label="Без автоматичних тегів"
            />
          ) : null}

          {latestTaskRun != null ? (
            <Stack spacing={1.25}>
              <Typography variant="subtitle1">{latestTaskRunSuccess ? 'Сформовано' : latestTaskRunCancelled ? 'Скасовано' : 'Прогрес формування'}</Typography>
              <LinearProgress
                variant="determinate"
                color={latestTaskRun.error ? 'error' : latestTaskRunCancelled ? 'warning' : latestTaskRunSuccess ? 'success' : 'primary'}
                value={Math.max(1, Math.min(100, Math.round((latestTaskRun.curr / Math.max(1, latestTaskRun.overall)) * 100)))}
                sx={
                  latestTaskRun.running
                    ? {
                        '& .MuiLinearProgress-bar': {
                          backgroundImage: 'linear-gradient(90deg, #42a500, #66bb6a, #42a5f5)',
                          backgroundSize: '200% 100%',
                          animation: 'analysis-report-shimmer 1s linear infinite',
                        },
                        '@keyframes analysis-report-shimmer': {
                          '0%': { backgroundPosition: '200% 0' },
                          '100%': { backgroundPosition: '-200% 0' },
                        },
                      }
                    : undefined
                }
              />
              <Typography variant="body2" color="text.secondary">
                {latestTaskRun.curr} / {latestTaskRun.overall}
              </Typography>
              {latestTaskRun.error ? <Alert severity="error">{latestTaskRun.error}</Alert> : null}
              {progressExpanded ? (
                <Stack spacing={1}>
                  {latestTaskRunDone ? (
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Button size="small" onClick={() => onSetProgressExpanded(false)}>
                        Згорнути звіти
                      </Button>
                    </Stack>
                  ) : null}

                  {[latestTaskRun, ...historyTaskRuns.slice().reverse()].map((run) => {
                    const stages = extractStages(run.logs);
                    return (
                      <Accordion
                        key={run.id}
                        disableGutters
                        elevation={0}
                        expanded={run.expanded}
                        onChange={(_event, expanded) => onToggleTaskRunLogs(run.id, expanded)}
                      >
                        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                          <Stack width="100%" direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                              {run.headerTitle}
                            </Typography>
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
                              {run.running ? (
                                <Button size="small" color="error" onClick={() => onCancelTaskRun(run.id)}>
                                  Скасувати
                                </Button>
                              ) : null}
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
              ) : (
                <Stack spacing={1}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {latestTaskRun.headerTitle}
                  </Typography>
                  <Stack direction="row" spacing={1}>
                    <Button size="small" onClick={() => onSetProgressExpanded(true)}>
                      Попередні звіти
                    </Button>
                    <Button size="small" onClick={() => void onRepeatTaskRun(latestTaskRun.id)} disabled={downloadInFlight || latestTaskRun.running}>
                      Сформувати повторно
                    </Button>
                  </Stack>
                </Stack>
              )}
            </Stack>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        <Button onClick={onClose}>Закрити</Button>
        <Button variant="contained" startIcon={<DownloadIcon />} onClick={onDownload} disabled={downloadInFlight}>
          {downloadInFlight ? 'Готуємо...' : report.template === 'summary_table' ? 'Завантажити xlsx' : 'Завантажити docx/xlsx'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
