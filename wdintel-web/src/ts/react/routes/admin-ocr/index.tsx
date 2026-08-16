import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityIcon from '@mui/icons-material/Visibility';
import {
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useState } from 'react';

import type { OcrJobItem, OcrPageRsp } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { getOcrPage, saveOcrSettings } from '../../services/api/ocr';

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

const STATE_LABELS: Record<string, string> = {
  queued: 'У черзі',
  submitted: 'Обробляється',
  retry_wait: 'Очікує повтору',
  completed: 'Завершено',
  failed: 'Помилка',
};

function stateColor(state: string): 'default' | 'info' | 'success' | 'error' | 'warning' {
  if (state === 'completed') return 'success';
  if (state === 'failed') return 'error';
  if (state === 'retry_wait') return 'warning';
  if (state === 'submitted') return 'info';
  return 'default';
}

function activeJobs(page: OcrPageRsp | null): boolean {
  return Boolean(page && page.counts.queued + page.counts.submitted + page.counts.retryWait > 0);
}

export function AdminOcrPage() {
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
    <Stack spacing={2.5}>
      <PageHeader
        title="OCR"
        titleInfo="Автоматичне розпізнавання PDF, JPG і PNG за останні сім днів."
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
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              alignItems={{ sm: 'center' }}
            >
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
              <Chip
                label={page?.settings.configured ? 'Налаштовано' : 'Не налаштовано'}
                color={page?.settings.configured ? 'success' : 'error'}
                size="small"
              />
              <Chip
                label={
                  page?.settings.extractorReady ? 'Extractor готовий' : 'Extractor недоступний'
                }
                color={page?.settings.extractorReady ? 'success' : 'warning'}
                size="small"
              />
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

      {page ? (
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <Chip label={`У черзі: ${page.counts.queued}`} />
          <Chip color="info" label={`Обробляється: ${page.counts.submitted}`} />
          <Chip color="warning" label={`Очікує повтору: ${page.counts.retryWait}`} />
          <Chip color="success" label={`Завершено: ${page.counts.completed}`} />
          <Chip color="error" label={`Помилки: ${page.counts.failed}`} />
        </Stack>
      ) : null}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Документ</TableCell>
              <TableCell>Створено</TableCell>
              <TableCell>Стан</TableCell>
              <TableCell>Якість</TableCell>
              <TableCell>Сторінки</TableCell>
              <TableCell>Спроби</TableCell>
              <TableCell>Оновлено</TableCell>
              <TableCell align="right">Перегляд</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {page?.jobs.map((job) => (
              <TableRow key={job.mediaId} hover>
                <TableCell sx={{ maxWidth: 300 }}>
                  <Tooltip title={job.lastError ?? ''} disableHoverListener={!job.lastError}>
                    <Box>
                      <Typography variant="body2" noWrap>
                        {job.fileName || job.mediaId}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {job.contentType} · {formatSize(job.sizeBytes)}
                      </Typography>
                    </Box>
                  </Tooltip>
                </TableCell>
                <TableCell>{formatDateTime(job.sourceCreatedAt)}</TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    color={stateColor(job.state)}
                    label={STATE_LABELS[job.state] ?? job.state}
                  />
                </TableCell>
                <TableCell>{job.qualityStatus ?? '—'}</TableCell>
                <TableCell>
                  {job.totalPages > 0 ? `${job.processedPages}/${job.totalPages}` : '—'}
                </TableCell>
                <TableCell>{job.attempts}</TableCell>
                <TableCell>{formatDateTime(job.updatedAt)}</TableCell>
                <TableCell align="right">
                  {job.previewUrl ? (
                    <Tooltip title="Переглянути OCR">
                      <IconButton
                        aria-label="Переглянути OCR"
                        size="small"
                        onClick={() => setPreview(job)}
                      >
                        <VisibilityIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
            {!loading && page?.jobs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} align="center">
                  OCR-результатів ще немає.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog
        open={preview != null}
        onClose={() => setPreview(null)}
        fullWidth
        maxWidth="xl"
        PaperProps={{ sx: { height: '92svh' } }}
      >
        <DialogTitle
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Typography component="span" variant="h6" noWrap>
            {preview?.fileName || 'OCR'}
          </Typography>
          <IconButton aria-label="Закрити" onClick={() => setPreview(null)}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ p: 0, display: 'flex', minHeight: 0 }}>
          {preview?.previewUrl ? (
            <Box
              component="iframe"
              title="OCR"
              src={preview.previewUrl}
              sandbox=""
              referrerPolicy="no-referrer"
              sx={{ flex: 1, border: 0 }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
