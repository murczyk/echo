import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { Box, IconButton, Tooltip } from '@mui/material';
import { useState } from 'react';

import type { ReportHistoryRow } from '../../../../Bindings';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import { isCancelledReportHistory } from '../../services/api/report-history';

export const REPORT_STATUS_LABELS: Record<string, string> = {
  planned: 'Очікує запуску',
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
  rer_report: 'РЕР Звіт',
  sposob: 'Способ',
  active_networks: 'Активні радіомережі',
  network_frequencies: 'Частоти Радіомереж',
  report_125: 'Звіт 1.2.5',
  report_1213: 'Звіт 1.2.13',
  summary_table: 'Підсумкова таблиця',
  kmz: 'KMZ',
  geojson: 'GeoJSON',
  etalonka: 'Еталонний опис',
  goi: 'Звіт ГОІ',
  goi_associations: 'Висновки ГОІ',
  legacy: 'Звіт',
};

export function formatReportDate(value: string | null): string {
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

export function formatReportDateOrDash(value: string | null | undefined): string {
  return formatReportDate(value ?? null) || '—';
}

export function formatReportId(value: number | null | undefined): string {
  return value == null ? '—' : `#${value}`;
}

export function reportStatusColor(
  status: string,
): 'default' | 'primary' | 'success' | 'error' | 'warning' {
  if (status === 'done') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'in_progress') return 'primary';
  if (status === 'planned') return 'warning';
  return 'default';
}

export function formatReportKind(reportKind: string): string {
  return REPORT_KIND_LABELS[reportKind] ?? '???';
}

export function formatReportProgress(progress: number): string {
  return `${Math.max(0, Math.min(100, Math.round(progress)))}%`;
}

export function formatReportStatus(row: ReportHistoryRow): string {
  if (isCancelledReportHistory(row)) {
    return 'Скасовано';
  }
  if (row.status === 'planned' && row.blockedByReportId != null) {
    return `Очікує завершення звіту #${row.blockedByReportId}`;
  }
  const label = REPORT_STATUS_LABELS[row.status] ?? row.status;
  if (row.status !== 'in_progress') return label;
  return `${label} ${formatReportProgress(row.progress)}`;
}

export function CopyableReportId({ id }: { id: number }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const label =
    copyStatus === 'copied'
      ? 'ID скопійовано'
      : copyStatus === 'error'
        ? 'Не вдалося скопіювати ID'
        : 'Копіювати ID';

  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, minWidth: 0 }}>
      <Box
        component="span"
        sx={{ fontFamily: 'monospace', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
      >
        #{id}
      </Box>
      <Tooltip title={label}>
        <IconButton
          size="small"
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation();
            void copyTextToClipboard(String(id))
              .then(() => setCopyStatus('copied'))
              .catch(() => setCopyStatus('error'));
          }}
          onBlur={() => setCopyStatus('idle')}
          onMouseLeave={() => setCopyStatus('idle')}
          sx={{ p: 0.25, fontSize: '0.85rem' }}
        >
          <ContentCopyOutlinedIcon fontSize="inherit" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
