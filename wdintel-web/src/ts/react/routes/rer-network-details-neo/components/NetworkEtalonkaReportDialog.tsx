import DownloadIcon from '@mui/icons-material/Download';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { type ReactNode, useEffect, useState } from 'react';

import { PowerDateTimePicker } from '../../../components/PowerDateTimePicker';
import { PowerAlert } from '../../../components/PowerAlert';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';
import type { BgtaskProgressStage } from '../../../services/api/bgtask';
import { parseBgtaskProgressStages } from '../../../services/api/bgtask';
import { parseUtcDateTime } from '../../../services/api/report-history';
import { APP_DATETIME_INPUT_MIN, APP_TIME_ZONE } from '../../../utils/misc';
import {
  type NetworkEtalonkaReportState,
  type NetworkEtalonkaReportType,
} from '../use-rer-network-details-neo-page.etalonka-report';

const REPORT_HISTORY_URL = '/my-reports';

type Props = {
  report: NetworkEtalonkaReportState;
  description: string;
  onClose: () => void;
  onDownload: () => void;
  onSetProgressExpanded: (expanded: boolean) => void;
  onTypeChange: (reportType: NetworkEtalonkaReportType) => void;
  onActiveFreqsOnlyChange: (activeFreqsOnly: boolean) => void;
  onIncludeSigintSignsChange: (includeSigintSigns: boolean) => void;
  onIncludeConfirmationChange: (includeConfirmation: boolean) => void;
  onIncludeHeadingsAndFreqsChange: (includeHeadingsAndFreqs: boolean) => void;
  onIncludeUnitCallsignsChange: (includeUnitCallsigns: boolean) => void;
  onIncludePelengsMapChange: (includePelengsMap: boolean) => void;
  onFromDateTimeStrChange: (fromDateTimeStr: string) => void;
  onToDateTimeStrChange: (toDateTimeStr: string) => void;
  launchWarningText?: string | null;
  disableRestoreFocus?: boolean;
};

function parseDateTime(value: string): Dayjs | null {
  if (value.trim() === '') return null;
  const nextValue = dayjs.tz(value, APP_TIME_ZONE);
  return nextValue.isValid() ? nextValue : null;
}

function formatDateTime(value: Dayjs | null): string {
  if (!value) return '';
  return (value as Dayjs).tz(APP_TIME_ZONE, true).format('YYYY-MM-DDTHH:mm');
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
  const startedAtMs = startedAt.getTime();
  return formatElapsedTime(startedAtMs);
}

function formatDateTimeLabel(value: string | null | undefined): string | null {
  const date = parseUtcDateTime(value);
  if (date === null) return null;
  return date.toLocaleString('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function getLatestProgressStage(stages: BgtaskProgressStage[]): BgtaskProgressStage | null {
  return stages.at(-1) ?? null;
}

function ReportSectionCard({
  title,
  description,
  children,
  disabled = false,
  minHeightMd,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  disabled?: boolean;
  minHeightMd?: number;
}) {
  const minHeight = minHeightMd === undefined ? undefined : { xs: 'auto', md: minHeightMd };

  return (
    <Paper
      variant="outlined"
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight,
        p: 2.5,
        borderRadius: 3,
        borderColor: 'divider',
        bgcolor: disabled ? 'action.hover' : 'background.paper',
        opacity: disabled ? 0.72 : 1,
      }}
    >
      <Stack spacing={2}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 800, lineHeight: 1.15 }}>
            {title}
          </Typography>
          {description ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
              {description}
            </Typography>
          ) : null}
        </Box>
        {children}
      </Stack>
    </Paper>
  );
}

function ReportCheckboxRow({
  checked,
  disabled = false,
  label,
  onChange,
  infoTitle,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  infoTitle?: string;
}) {
  return (
    <FormControlLabel
      control={
        <Checkbox
          size="small"
          checked={checked}
          onChange={(_event, nextChecked) => onChange(nextChecked)}
          disabled={disabled}
          sx={{ p: 0.5 }}
        />
      }
      label={
        infoTitle ? (
          <Stack
            component="span"
            direction="row"
            alignItems="center"
            spacing={0.5}
            sx={{ minWidth: 0 }}
          >
            <Box component="span">{label}</Box>
            <Tooltip arrow title={infoTitle}>
              <Box
                component="span"
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  color: disabled ? 'text.disabled' : 'text.secondary',
                  lineHeight: 0,
                  cursor: 'default',
                }}
              >
                <InfoOutlinedIcon sx={{ fontSize: 16 }} />
              </Box>
            </Tooltip>
          </Stack>
        ) : (
          label
        )
      }
      sx={{ m: 0 }}
    />
  );
}

export function NetworkEtalonkaReportDialog({
  report,
  description,
  onClose,
  onDownload,
  onSetProgressExpanded,
  onTypeChange,
  onActiveFreqsOnlyChange,
  onIncludeSigintSignsChange,
  onIncludeConfirmationChange,
  onIncludeHeadingsAndFreqsChange,
  onIncludeUnitCallsignsChange,
  onIncludePelengsMapChange,
  onFromDateTimeStrChange,
  onToDateTimeStrChange,
  launchWarningText = null,
  disableRestoreFocus = false,
}: Props) {
  const isExtended = report.reportType === 'ExtendedReport';
  const historyRow = report.historyRow ?? null;
  const hasBgtask = historyRow?.bgtaskId != null;
  const isQueued = report.running && !hasBgtask;
  const dateTimeDisabled = report.running || !isExtended;
  const [fromDateTimeDraft, setFromDateTimeDraft] = useState<Dayjs | null>(() =>
    parseDateTime(report.fromDateTimeStr),
  );
  const [toDateTimeDraft, setToDateTimeDraft] = useState<Dayjs | null>(() =>
    parseDateTime(report.toDateTimeStr),
  );
  const progressStages = parseBgtaskProgressStages(report.logs);
  const latestProgressStage = getLatestProgressStage(progressStages);
  const visibleLogLines = report.logs.filter((line) => !/^\[\d+\/\d+\]/.test(line));
  const hasProgressDetails = progressStages.length > 0 || visibleLogLines.length > 0;
  const elapsedTime = formatElapsedTime(report.startedAtMs);
  const createdAtMs = parseUtcDateTime(historyRow?.createdAt)?.getTime() ?? null;
  const queuedForTime = formatDurationSinceIso(historyRow?.createdAt);
  const startedAtLabel = formatDateTimeLabel(historyRow?.startedAt ?? null);
  const plannedForLabel = formatDateTimeLabel(historyRow?.plannedForTs ?? null);
  const showLongRunningHint =
    report.running &&
    hasBgtask &&
    report.startedAtMs !== null &&
    Date.now() - report.startedAtMs >= 30_000;
  const showQueueWarning =
    isQueued && createdAtMs !== null && Date.now() - createdAtMs >= 5 * 60 * 1000;
  const progressVariant = hasBgtask && !report.error && !isQueued ? 'determinate' : 'indeterminate';
  const progressLabel = report.error
    ? 'Помилка'
    : isQueued
      ? 'Очікує запуску'
      : report.running
        ? 'Формування'
        : 'Готово';
  const progressStageLabel =
    isQueued || !hasBgtask ? 'Очікує запуску' : (latestProgressStage?.text ?? 'Підготовка');
  const progressSummaryLabel = isQueued
    ? historyRow?.blockedByReportId != null
      ? `Очікує завершення звіту #${historyRow.blockedByReportId} · ${queuedForTime ?? '—'}`
      : `Позиція #${historyRow?.queuePosition ?? '—'} · очікує ${queuedForTime ?? '—'}`
    : `${report.curr} / ${report.overall}`;
  const noDescriptions = !report.includeSigintSigns && !report.includeConfirmation;
  const headingsAndFreqsTooltipTitle = noDescriptions
    ? 'Увімкніть «Включити сигнали» або «Включити підтвердження» — заголовки та частоти додаються лише до цих секцій'
    : 'Додатково включити дані з поля «частота» та «заголовок» з розвід ознак та обґрунтувань';

  useEffect(() => {
    setFromDateTimeDraft(parseDateTime(report.fromDateTimeStr));
    setToDateTimeDraft(parseDateTime(report.toDateTimeStr));
  }, [report.fromDateTimeStr, report.toDateTimeStr]);

  const resetDrafts = () => {
    setFromDateTimeDraft(parseDateTime(report.fromDateTimeStr));
    setToDateTimeDraft(parseDateTime(report.toDateTimeStr));
  };

  const handleClose = () => {
    resetDrafts();
    onClose();
  };

  const hasProgress = report.taskId !== null || report.running || report.logs.length > 0;
  const progressPercent = Math.max(
    1,
    Math.min(100, Math.round((report.curr / Math.max(1, report.overall)) * 100)),
  );

  return (
    <Dialog
      open={report.dialogOpen}
      onClose={(_event, reason) => {
        if (report.running && (reason === 'backdropClick' || reason === 'escapeKeyDown')) {
          return;
        }
        handleClose();
      }}
      disableEscapeKeyDown={report.running}
      fullWidth
      maxWidth={false}
      disableRestoreFocus={disableRestoreFocus}
      PaperProps={{
        sx: {
          borderRadius: 1,
          width: { xs: 'calc(100vw - 24px)', md: 760 },
          maxWidth: 'calc(100vw - 24px)',
          overflow: 'hidden',
        },
      }}
    >
      <DialogTitle sx={{ px: 3, pt: 2.5, pb: 1.5 }}>
        <Typography variant="h6" component="div" sx={{ fontWeight: 500 }}>
          Еталонний опис
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {description}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
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
      </DialogTitle>

      <DialogContent dividers sx={{ px: 3, pt: 1.75, pb: 2.5 }}>
        <Stack spacing={2}>
          {launchWarningText ? (
            <PowerAlert severity="warning">{launchWarningText}</PowerAlert>
          ) : null}
          {report.error ? <PowerAlert severity="error">{report.error}</PowerAlert> : null}

          <RadioGroup
            row
            value={report.reportType}
            onChange={(_event, value) => onTypeChange(value as NetworkEtalonkaReportType)}
            sx={{ gap: 2 }}
          >
            <FormControlLabel
              value="AccordingToTheForm"
              control={<Radio />}
              label="Згідно форми"
              disabled={report.running}
            />
            <FormControlLabel
              value="ExtendedReport"
              control={<Radio />}
              label="Розширений"
              disabled={report.running}
            />
          </RadioGroup>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
              gap: 2.5,
              alignItems: 'stretch',
            }}
          >
            <ReportSectionCard title="Основні налаштування" minHeightMd={220}>
              <Stack spacing={1.25}>
                <ReportCheckboxRow
                  checked={report.activeFreqsOnly}
                  onChange={onActiveFreqsOnlyChange}
                  disabled={report.running}
                  label="Лише активні частоти"
                />
                <ReportCheckboxRow
                  checked={report.includeSigintSigns}
                  onChange={onIncludeSigintSignsChange}
                  disabled={report.running}
                  label="Включити сигнали"
                />
                <ReportCheckboxRow
                  checked={report.includeConfirmation}
                  onChange={onIncludeConfirmationChange}
                  disabled={report.running}
                  label="Включити підтвердження"
                />
              </Stack>
            </ReportSectionCard>

            <ReportSectionCard title="Додаткові опції" minHeightMd={220}>
              <Stack spacing={1.25}>
                {isExtended ? (
                  <Stack spacing={2}>
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                        gap: 1.5,
                      }}
                    >
                      <PowerDateTimePicker
                        label="Від"
                        value={fromDateTimeDraft}
                        allowEmpty={false}
                        onChange={setFromDateTimeDraft}
                        onAccept={(value) => onFromDateTimeStrChange(formatDateTime(value))}
                        onClose={resetDrafts}
                        disabled={dateTimeDisabled}
                        minDateTime={dayjs.tz(APP_DATETIME_INPUT_MIN, APP_TIME_ZONE) as Dayjs}
                        format="DD.MM.YYYY HH:mm"
                        slotProps={{
                          textField: {
                            size: 'small',
                            fullWidth: true,
                            InputLabelProps: { shrink: true },
                          },
                        }}
                      />
                      <PowerDateTimePicker
                        label="До"
                        value={toDateTimeDraft}
                        allowEmpty={false}
                        onChange={setToDateTimeDraft}
                        onAccept={(value) => onToDateTimeStrChange(formatDateTime(value))}
                        onClose={resetDrafts}
                        disabled={dateTimeDisabled}
                        minDateTime={dayjs.tz(APP_DATETIME_INPUT_MIN, APP_TIME_ZONE) as Dayjs}
                        format="DD.MM.YYYY HH:mm"
                        slotProps={{
                          textField: {
                            size: 'small',
                            fullWidth: true,
                            InputLabelProps: { shrink: true },
                          },
                        }}
                      />
                    </Box>

                    <Stack spacing={0.75}>
                      <ReportCheckboxRow
                        checked={report.includeUnitCallsigns}
                        onChange={onIncludeUnitCallsignsChange}
                        disabled={report.running}
                        label="Включити позивні підрозділів"
                      />
                      <ReportCheckboxRow
                        checked={report.includePelengsMap}
                        onChange={onIncludePelengsMapChange}
                        disabled={report.running}
                        label="Включити карту пеленгів"
                      />
                      <ReportCheckboxRow
                        checked={report.includeHeadingsAndFreqs}
                        onChange={onIncludeHeadingsAndFreqsChange}
                        disabled={report.running || noDescriptions}
                        label="Включити заголовки та частоти"
                        infoTitle={headingsAndFreqsTooltipTitle}
                      />
                    </Stack>
                  </Stack>
                ) : (
                  <Stack spacing={1.25}>
                    <Typography variant="body2" color="text.secondary">
                      Дата, позивні підрозділів та карта пеленгів доступні тільки в розширеному
                      звіті
                    </Typography>

                    <Stack spacing={0.75}>
                      <ReportCheckboxRow
                        checked={report.includeHeadingsAndFreqs}
                        onChange={onIncludeHeadingsAndFreqsChange}
                        disabled={report.running || noDescriptions}
                        label="Включити заголовки та частоти"
                        infoTitle={headingsAndFreqsTooltipTitle}
                      />
                    </Stack>
                  </Stack>
                )}
              </Stack>
            </ReportSectionCard>
          </Box>

          {hasProgress ? (
            <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, borderColor: 'divider' }}>
              <Stack spacing={1.5}>
                <Stack
                  direction="row"
                  justifyContent="space-between"
                  alignItems="center"
                  spacing={2}
                >
                  <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                    {progressLabel}
                  </Typography>
                </Stack>

                <LinearProgress
                  variant={progressVariant}
                  color={report.error ? 'error' : report.running ? 'primary' : 'success'}
                  value={progressVariant === 'determinate' ? progressPercent : undefined}
                  sx={
                    report.running && progressVariant === 'determinate'
                      ? { '& .MuiLinearProgress-bar': { transition: 'none' } }
                      : undefined
                  }
                />

                <Stack
                  direction="row"
                  justifyContent="space-between"
                  alignItems="center"
                  spacing={2}
                >
                  <Typography variant="body2" color="text.secondary">
                    {progressSummaryLabel}
                  </Typography>
                  <Button
                    size="small"
                    onClick={() => onSetProgressExpanded(!report.progressExpanded)}
                  >
                    {report.progressExpanded ? 'Сховати деталі' : 'Показати деталі'}
                  </Button>
                </Stack>

                {report.progressExpanded ? (
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
                          {report.taskId !== null ? `#${report.taskId}` : '—'}
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
                          Очікує
                        </Typography>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {queuedForTime ?? '—'}
                        </Typography>
                      </Stack>
                      <Stack spacing={0.25}>
                        <Typography variant="caption" color="text.secondary">
                          Початок
                        </Typography>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {startedAtLabel ?? '—'}
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
                          Заплановано
                        </Typography>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {plannedForLabel ?? '—'}
                        </Typography>
                      </Stack>
                      <Stack spacing={0.25}>
                        <Typography variant="caption" color="text.secondary">
                          Триває
                        </Typography>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {elapsedTime ?? '—'}
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
                      <Stack spacing={0.25}>
                        <Typography variant="caption" color="text.secondary">
                          Логи
                        </Typography>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {report.logs.length}
                        </Typography>
                      </Stack>
                      <Stack spacing={0.25}>
                        <Typography variant="caption" color="text.secondary">
                          Файл
                        </Typography>
                        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                          {report.downloadFileName ?? '—'}
                        </Typography>
                      </Stack>
                    </Box>

                    {hasProgressDetails ? (
                      <Paper
                        variant="outlined"
                        sx={{ p: 1.5, borderRadius: 2, bgcolor: 'background.default' }}
                      >
                        <Stack spacing={0.75}>
                          {progressStages.map((stage) => {
                            const stageDone =
                              !report.running && !report.error ? true : report.curr > stage.index;
                            const stageCurrent = report.running && report.curr === stage.index;
                            return (
                              <Stack
                                key={`${report.taskRunId}-${stage.index}`}
                                direction="row"
                                spacing={1}
                                alignItems="center"
                              >
                                {stageDone ? (
                                  <CheckCircleIcon color="success" fontSize="small" />
                                ) : stageCurrent ? (
                                  <CircularProgress size={14} />
                                ) : report.error ? (
                                  <HighlightOffIcon color="error" fontSize="small" />
                                ) : (
                                  <Typography variant="caption" color="text.disabled">
                                    ○
                                  </Typography>
                                )}
                                <Typography
                                  variant="caption"
                                  color={stageCurrent ? 'primary.main' : 'text.secondary'}
                                >
                                  [{stage.index}/{stage.overall}] {stage.text}
                                </Typography>
                              </Stack>
                            );
                          })}
                          {visibleLogLines.map((line) => (
                            <Typography key={line} variant="caption" color="text.secondary">
                              {line}
                            </Typography>
                          ))}
                        </Stack>
                      </Paper>
                    ) : null}
                  </Stack>
                ) : null}

                {report.error ? <PowerAlert severity="error">{report.error}</PowerAlert> : null}
                {showQueueWarning ? (
                  <PowerAlert severity="warning">
                    Звіт ще не стартував. Перевірте його стан у Мої звіти.
                  </PowerAlert>
                ) : null}
                {showLongRunningHint ? (
                  <PowerAlert severity="info">
                    Формування може тривати кілька хвилин. Звіт можна переглянути та завантажити
                    пізніше в Мої звіти.
                  </PowerAlert>
                ) : null}
              </Stack>
            </Paper>
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
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ flex: '1 1 320px', minWidth: 0 }}
        >
          {description}
        </Typography>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexShrink: 0 }}>
          <Button onClick={handleClose}>Закрити</Button>
          <Button
            onClick={onDownload}
            disabled={report.running}
            variant="contained"
            startIcon={
              report.running ? <CircularProgress color="inherit" size={16} /> : <DownloadIcon />
            }
          >
            {isQueued ? 'Очікує запуску' : report.running ? 'Формування...' : 'Завантажити'}
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
