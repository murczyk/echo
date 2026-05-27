import DownloadIcon from '@mui/icons-material/Download';
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
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from '@mui/material';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { type ReactNode, useEffect, useState } from 'react';

import { PowerDateTimePicker } from '../../../components/PowerDateTimePicker';
import { PowerAlert } from '../../../components/PowerAlert';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';
import { APP_DATETIME_INPUT_MIN, APP_TIME_ZONE } from '../../../utils/misc';
import { type NetworkEtalonkaReportState, type NetworkEtalonkaReportType } from '../use-rer-network-details-neo-page.etalonka-report';

type Props = {
  report: NetworkEtalonkaReportState;
  onClose: () => void;
  onDownload: () => void;
  onTypeChange: (reportType: NetworkEtalonkaReportType) => void;
  onActiveFreqsOnlyChange: (activeFreqsOnly: boolean) => void;
  onIncludeSigintSignsChange: (includeSigintSigns: boolean) => void;
  onIncludeConfirmationChange: (includeConfirmation: boolean) => void;
  onIncludeUnitCallsignsChange: (includeUnitCallsigns: boolean) => void;
  onIncludePelengsMapChange: (includePelengsMap: boolean) => void;
  onFromDateTimeStrChange: (fromDateTimeStr: string) => void;
  onToDateTimeStrChange: (toDateTimeStr: string) => void;
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

function ReportSectionCard({
  title,
  description,
  children,
  disabled = false,
  minHeight = 0,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  disabled?: boolean;
  minHeight?: number;
}) {
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

export function NetworkEtalonkaReportDialog({
  report,
  onClose,
  onDownload,
  onTypeChange,
  onActiveFreqsOnlyChange,
  onIncludeSigintSignsChange,
  onIncludeConfirmationChange,
  onIncludeUnitCallsignsChange,
  onIncludePelengsMapChange,
  onFromDateTimeStrChange,
  onToDateTimeStrChange,
}: Props) {
  const isExtended = report.reportType === 'ExtendedReport';
  const dateTimeDisabled = report.downloading || !isExtended;
  const [fromDateTimeDraft, setFromDateTimeDraft] = useState<Dayjs | null>(() => parseDateTime(report.fromDateTimeStr));
  const [toDateTimeDraft, setToDateTimeDraft] = useState<Dayjs | null>(() => parseDateTime(report.toDateTimeStr));

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

  return (
    <Dialog
      open={report.dialogOpen}
      onClose={report.downloading ? undefined : handleClose}
      fullWidth
      maxWidth={false}
      disableEscapeKeyDown={report.downloading}
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
          Звіт &laquo;Еталонний опис&raquo;
        </Typography>
      </DialogTitle>

      <DialogContent dividers sx={{ px: 3, pt: 1.75, pb: 2.5 }}>
        <Stack spacing={2}>
          {report.error ? <PowerAlert severity="error">{report.error}</PowerAlert> : null}

          <RadioGroup row value={report.reportType} onChange={(_event, value) => onTypeChange(value as NetworkEtalonkaReportType)} sx={{ gap: 2 }}>
            <FormControlLabel value="AccordingToTheForm" control={<Radio />} label="Згідно форми" disabled={report.downloading} />
            <FormControlLabel value="ExtendedReport" control={<Radio />} label="Розширений" disabled={report.downloading} />
          </RadioGroup>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
              gap: 2.5,
              alignItems: 'stretch',
            }}
          >
            <ReportSectionCard title="Основні налаштування" minHeight={190}>
              <Stack spacing={1.25}>
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={report.activeFreqsOnly}
                      onChange={(_event, checked) => onActiveFreqsOnlyChange(checked)}
                      disabled={report.downloading}
                      sx={{ p: 0.5 }}
                    />
                  }
                  label="Лише активні частоти"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={report.includeSigintSigns}
                      onChange={(_event, checked) => onIncludeSigintSignsChange(checked)}
                      disabled={report.downloading}
                      sx={{ p: 0.5 }}
                    />
                  }
                  label="Включити сигнали"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={report.includeConfirmation}
                      onChange={(_event, checked) => onIncludeConfirmationChange(checked)}
                      disabled={report.downloading}
                      sx={{ p: 0.5 }}
                    />
                  }
                  label="Включити підтвердження"
                />
              </Stack>
            </ReportSectionCard>

            <ReportSectionCard
              title="Додаткові опції"
              description={isExtended ? undefined : 'Доступні тільки в розширеному звіті'}
              disabled={!isExtended}
              minHeight={190}
            >
              {isExtended ? (
                <Stack spacing={2}>
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
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
                    <FormControlLabel
                      control={
                        <Checkbox
                          size="small"
                          checked={report.includeUnitCallsigns}
                          onChange={(_event, checked) => onIncludeUnitCallsignsChange(checked)}
                          disabled={report.downloading}
                          sx={{ p: 0.5 }}
                        />
                      }
                      label="Включити позивні підрозділів"
                    />
                    <FormControlLabel
                      control={
                        <Checkbox
                          size="small"
                          checked={report.includePelengsMap}
                          onChange={(_event, checked) => onIncludePelengsMapChange(checked)}
                          disabled={report.downloading}
                          sx={{ p: 0.5 }}
                        />
                      }
                      label="Включити карту пеленгів"
                    />
                  </Stack>
                </Stack>
              ) : null}
            </ReportSectionCard>
          </Box>
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
          Еталонний опис для мережі
        </Typography>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexShrink: 0 }}>
          <Button onClick={handleClose} disabled={report.downloading}>
            Закрити
          </Button>
          <Button
            onClick={onDownload}
            disabled={report.downloading}
            variant="contained"
            startIcon={report.downloading ? <CircularProgress color="inherit" size={16} /> : <DownloadIcon />}
          >
            Згенерувати
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
