import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import {
  Box,
  Chip,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';

import type { ReportHistoryRow } from '../../../../Bindings';
import { PageErrorState } from '../../components/PageErrorState';
import { PageHeader } from '../../components/PageHeader';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerAlert } from '../../components/PowerAlert';
import { navigateWithinSpa } from '../../utils/browser';
import {
  CopyableReportId,
  formatReportDateOrDash,
  formatReportId,
  formatReportKind,
  formatReportStatus,
  reportStatusColor,
} from '../shared/report-history-display';
import { useAdminReportDetails } from './use-admin-report-details';

function MetadataItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" component="div">
        {label}
      </Typography>
      <Box sx={{ mt: 0.25, minWidth: 0, overflowWrap: 'anywhere' }}>{children}</Box>
    </Box>
  );
}

function formatTaskRunning(taskRunning: boolean | null): string {
  if (taskRunning === true) return 'Виконується';
  if (taskRunning === false) return 'Не виконується';
  return '—';
}

function ReportMetadata({
  row,
  taskRunning,
}: {
  row: ReportHistoryRow;
  taskRunning: boolean | null;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, 1fr)' },
          gap: 2,
        }}
      >
        <MetadataItem label="ID">
          <CopyableReportId id={row.id} />
        </MetadataItem>
        <MetadataItem label="Автор">{row.requestedBy || '—'}</MetadataItem>
        <MetadataItem label="Створено">{formatReportDateOrDash(row.createdAt)}</MetadataItem>
        <MetadataItem label="Останній запуск">{formatReportDateOrDash(row.startedAt)}</MetadataItem>
        <MetadataItem label="Завершено">{formatReportDateOrDash(row.completedAt)}</MetadataItem>
        <MetadataItem label="ID задачі">{formatReportId(row.bgtaskId)}</MetadataItem>
        <MetadataItem label="Стан задачі">{formatTaskRunning(taskRunning)}</MetadataItem>
        <MetadataItem label="Період">{row.reportPeriod || '—'}</MetadataItem>
        <MetadataItem label="Деталі">{row.details || '—'}</MetadataItem>
      </Box>
    </Paper>
  );
}

function terminalLines(row: ReportHistoryRow, logs: string[], taskError: string | null): string[] {
  const lines = [...logs];
  for (const entry of row.errorLog ?? []) {
    lines.push(
      `[${formatReportDateOrDash(entry.timestamp)}] [${entry.login || 'system'}] ERROR: ${entry.message}`,
    );
  }
  if (taskError && !lines.some((line) => line.includes(taskError))) {
    lines.push(`ERROR: ${taskError}`);
  }
  if (row.lastError && !lines.some((line) => line.includes(row.lastError ?? ''))) {
    lines.push(`ERROR: ${row.lastError}`);
  }
  return lines;
}

function ReportLog({
  row,
  logs,
  taskError,
  taskRunning,
}: {
  row: ReportHistoryRow;
  logs: string[];
  taskError: string | null;
  taskRunning: boolean | null;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => terminalLines(row, logs, taskError), [logs, row, taskError]);
  const active = row.status === 'planned' || row.status === 'in_progress';

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines.length]);

  const placeholder =
    row.status === 'planned' ? 'Очікування запуску звіту…' : 'Задача ще не записала жодного рядка.';

  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        gap={2}
        sx={{ p: 2 }}
      >
        <Typography component="h2" variant="h6">
          Журнал виконання
        </Typography>
        {active ? (
          <Chip
            size="small"
            color={taskRunning === false ? 'warning' : 'primary'}
            label={taskRunning === false ? 'Задача не виконується' : 'Оновлюється'}
          />
        ) : null}
      </Stack>
      <Box
        ref={logRef}
        role="log"
        aria-live="polite"
        sx={{
          minHeight: 240,
          maxHeight: '60vh',
          overflow: 'auto',
          bgcolor: '#111827',
          color: '#d1fae5',
          px: 2,
          py: 1.5,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: '0.8rem',
          lineHeight: 1.65,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {lines.length > 0 ? lines.map((line, index) => <Box key={index}>{line}</Box>) : placeholder}
      </Box>
    </Paper>
  );
}

export function AdminReportDetailsPage({ reportId }: { reportId: number }) {
  const state = useAdminReportDetails(reportId);
  if (state.loading && state.row === null) return <PageLoadingState />;
  if (state.row === null) {
    return <PageErrorState message={state.error ?? 'Звіт не знайдено.'} />;
  }

  const row = state.row;
  return (
    <Stack spacing={2} sx={{ width: '100%' }}>
      <PageHeader
        title={formatReportKind(row.reportKind)}
        titleLeadingActions={
          <Tooltip title="До всіх звітів">
            <IconButton
              size="small"
              aria-label="До всіх звітів"
              onClick={() => navigateWithinSpa('/admin/all-reports')}
            >
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        }
        titleTrailing={
          <Chip
            size="small"
            color={reportStatusColor(row.status)}
            label={formatReportStatus(row)}
            variant={row.status === 'planned' ? 'outlined' : 'filled'}
          />
        }
      />
      {state.error ? <PowerAlert severity="error">{state.error}</PowerAlert> : null}
      {row.status === 'in_progress' && state.taskRunning === false ? (
        <PowerAlert severity="warning">
          Фонова задача вже не виконується, але звіт досі має активний статус. Це може бути коротке
          завершення або застарілий стан після перезапуску.
        </PowerAlert>
      ) : null}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Stack direction="row" justifyContent="space-between" gap={2}>
            <Typography variant="body2" color="text.secondary">
              Прогрес
            </Typography>
            <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {Math.max(0, Math.min(100, Math.round(row.progress)))}%
            </Typography>
          </Stack>
          <LinearProgress variant="determinate" value={Math.max(0, Math.min(100, row.progress))} />
        </Stack>
      </Paper>
      <ReportMetadata row={row} taskRunning={state.taskRunning} />
      <ReportLog
        row={row}
        logs={state.logs}
        taskError={state.taskError}
        taskRunning={state.taskRunning}
      />
    </Stack>
  );
}
