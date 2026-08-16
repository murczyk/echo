import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityIcon from '@mui/icons-material/Visibility';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  LinearProgress,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import type { MediaSummaryStatus, OcrMediaSummary } from '../../../../../../Bindings';
import { useOptionalPowerSnackbar } from '../../../../components/PowerSnackbar';
import { getMediaOcrStatus } from '../../../../services/api/ocr';
import type { AttachmentPreviewDownloadItem } from './MessageCardAttachmentPreviewHeader';
import type { AttachmentPreviewInfoSection } from './MessageCardAttachmentPreviewInfoPopover';
import { MediaSummaryAction, MediaSummaryOverlay } from './MediaSummaryPreview';

const OCR_STATE_LABELS: Record<string, string> = {
  pending: 'У черзі',
  queued: 'У черзі',
  submitted: 'Обробляється',
  retry_wait: 'Очікує повтору',
  completed: 'Завершено',
  failed: 'Помилка',
};

const OCR_QUALITY_LABELS: Record<string, string> = {
  accepted: 'Прийнятна',
  degraded: 'Знижена якість',
  failed: 'Невдала',
};

export function isOcrReady(ocr: OcrMediaSummary): boolean {
  return ocr.state === 'completed' && ocr.qualityStatus !== 'failed';
}

export function getOcrDownloadItems(
  mediaId: string | null | undefined,
  ocr: OcrMediaSummary | null | undefined,
  fileName: string,
): AttachmentPreviewDownloadItem[] {
  if (mediaId == null || ocr == null || !isOcrReady(ocr)) return [];
  const stem = fileName.replace(/\.[^.]+$/, '') || 'document';
  const formats = [
    ['docx', 'DOCX'],
    ['xlsx', 'XLSX'],
    ['md', 'Markdown'],
    ['html', 'HTML'],
  ] as const;
  return formats.map(([extension, label]) => ({
    label: `Скачати ${label}`,
    download: {
      href: `/api/messenger/media/${encodeURIComponent(mediaId)}/ocr/download/${extension}`,
      fileName: `${stem}-ocr.${extension}`,
    },
    downloadKey: `media:${mediaId}:ocr:${extension}`,
  }));
}

export function getOcrInfoSeverity(
  ocr: OcrMediaSummary | null | undefined,
): 'warning' | 'error' | undefined {
  if (ocr?.state === 'failed' || ocr?.qualityStatus === 'failed') return 'error';
  if (ocr?.qualityStatus === 'degraded') return 'warning';
  return undefined;
}

export function getOcrInfoSections(
  ocr: OcrMediaSummary | null | undefined,
): AttachmentPreviewInfoSection[] {
  if (ocr == null) return [];
  const fields = [
    {
      label: 'Стан',
      value: OCR_STATE_LABELS[ocr.state] ?? ocr.state,
    },
    ...(ocr.qualityStatus == null || matchesWarningQuality(ocr.qualityStatus)
      ? []
      : [
          {
            label: 'Якість',
            value: OCR_QUALITY_LABELS[ocr.qualityStatus] ?? ocr.qualityStatus,
          },
        ]),
    ...(ocr.totalPages > 0
      ? [
          {
            label: 'Прогрес',
            value: `${ocr.processedPages} із ${ocr.totalPages} стор.`,
          },
        ]
      : []),
    ...(ocr.queueSize == null ? [] : [{ label: 'Черга', value: `${ocr.queueSize}` }]),
    ...(ocr.lastError == null ? [] : [{ label: 'Деталі', value: ocr.lastError }]),
  ];
  const status =
    ocr.state === 'failed' || ocr.qualityStatus === 'failed'
      ? { label: 'Невдала якість OCR', severity: 'error' as const }
      : ocr.qualityStatus === 'degraded'
        ? { label: 'Знижена якість', severity: 'warning' as const }
        : undefined;
  return [{ title: 'OCR', fields, status }];
}

function matchesWarningQuality(qualityStatus: string): boolean {
  return qualityStatus === 'degraded' || qualityStatus === 'failed';
}

function isProcessing(ocr: OcrMediaSummary): boolean {
  return (
    ocr.state === 'pending' ||
    ocr.state === 'queued' ||
    ocr.state === 'submitted' ||
    ocr.state === 'retry_wait'
  );
}

function queueLabel(ocr: OcrMediaSummary): string {
  return ocr.queueSize == null ? '' : ` · черга: ${ocr.queueSize}`;
}

export function OcrPreviewAction({
  ocr,
  active,
  onClick,
}: {
  ocr?: OcrMediaSummary | null;
  active: boolean;
  onClick: () => void;
}) {
  if (ocr == null) return null;
  const ready = isOcrReady(ocr);
  const processing = isProcessing(ocr);
  const progress = ocr.totalPages > 0 ? ` (${ocr.processedPages}/${ocr.totalPages} стор.)` : '';
  const title = ready
    ? active
      ? 'Закрити OCR'
      : ocr.qualityStatus === 'degraded'
        ? 'Переглянути OCR (якість знижена)'
        : 'Переглянути OCR'
    : ocr.state === 'failed'
      ? `OCR завершився з помилкою${ocr.lastError ? `: ${ocr.lastError}` : ''}`
      : ocr.state === 'pending' || ocr.state === 'queued'
        ? `OCR у черзі${queueLabel(ocr)}`
        : `OCR обробляється${progress}${queueLabel(ocr)}`;

  return (
    <Tooltip title={title} enterDelay={300}>
      <Box component="span" sx={{ display: 'inline-flex', position: 'relative' }}>
        <IconButton
          aria-label={title}
          aria-pressed={active}
          color={active ? 'primary' : 'default'}
          size="small"
          onClick={onClick}
          sx={{
            color: active ? 'primary.main' : processing ? 'info.main' : 'text.secondary',
            '&:hover': { color: active ? 'primary.dark' : 'text.primary' },
          }}
        >
          <VisibilityIcon fontSize="small" />
        </IconButton>
        {processing ? (
          <CircularProgress
            size={26}
            thickness={2.5}
            color="info"
            sx={{ position: 'absolute', inset: 3, pointerEvents: 'none' }}
          />
        ) : null}
      </Box>
    </Tooltip>
  );
}

function OcrStatusPane({
  ocr,
  refreshing,
  refreshError,
  onRefresh,
}: {
  ocr: OcrMediaSummary;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh: () => void;
}) {
  const progress = ocr.totalPages > 0 ? (ocr.processedPages / ocr.totalPages) * 100 : null;
  const failed = ocr.state === 'failed' || ocr.qualityStatus === 'failed';

  return (
    <Stack
      spacing={2}
      alignItems="center"
      justifyContent="center"
      sx={{ flex: 1, minWidth: 0, p: 3, textAlign: 'center' }}
    >
      <Chip
        size="small"
        color={failed ? 'error' : ocr.state === 'retry_wait' ? 'warning' : 'info'}
        label={`${OCR_STATE_LABELS[ocr.state] ?? ocr.state}${queueLabel(ocr)}`}
      />
      <Box sx={{ width: 'min(100%, 420px)' }}>
        <LinearProgress
          color={failed ? 'error' : 'info'}
          variant={progress == null ? 'indeterminate' : 'determinate'}
          value={progress ?? undefined}
        />
      </Box>
      <Typography variant="body2" color="text.secondary">
        {ocr.state === 'pending' || ocr.state === 'queued'
          ? ocr.queueSize == null
            ? 'OCR очікує в черзі.'
            : `Завдань OCR у черзі: ${ocr.queueSize}.`
          : ocr.totalPages > 0
            ? `Опрацьовано сторінок: ${ocr.processedPages} із ${ocr.totalPages}`
            : 'Очікуємо дані про прогрес OCR.'}
      </Typography>
      {ocr.lastError ? (
        <Typography variant="body2" color={failed ? 'error.main' : 'warning.main'}>
          {ocr.lastError}
        </Typography>
      ) : null}
      {refreshError ? (
        <Typography variant="body2" color="error.main" role="alert">
          {refreshError}
        </Typography>
      ) : null}
      <Button
        variant="outlined"
        startIcon={refreshing ? <CircularProgress size={16} /> : <RefreshIcon />}
        disabled={refreshing}
        onClick={onRefresh}
      >
        Оновити статус
      </Button>
    </Stack>
  );
}

export function OcrSplitPreview({
  source,
  mediaId,
  ocr,
  visible,
  fullPane,
  onOcrChange,
  onFullPaneChange,
  summary,
  summaryVisible,
  onSummaryChange,
  onSummaryVisibleChange,
}: {
  source: ReactNode;
  mediaId?: string | null;
  ocr?: OcrMediaSummary | null;
  visible: boolean;
  fullPane: boolean;
  onOcrChange: (ocr: OcrMediaSummary) => void;
  onFullPaneChange: (value: boolean) => void;
  summary?: MediaSummaryStatus | null;
  summaryVisible: boolean;
  onSummaryChange: (summary: MediaSummaryStatus) => void;
  onSummaryVisibleChange: (value: boolean) => void;
}) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const [mobilePane, setMobilePane] = useState<'source' | 'ocr'>('ocr');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [iframeRevision, setIframeRevision] = useState(0);
  const refreshInFlightRef = useRef(false);
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const refresh = useCallback(
    async (quiet: boolean) => {
      if (mediaId == null || refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      setRefreshing(true);
      try {
        const nextOcr = await getMediaOcrStatus(mediaId);
        onOcrChange(nextOcr);
        setRefreshError(null);
        if (isOcrReady(nextOcr)) setIframeRevision((revision) => revision + 1);
      } catch (error) {
        const message = `Не вдалося оновити статус OCR: ${
          error instanceof Error ? error.message : String(error)
        }`;
        setRefreshError(message);
        if (!quiet) notifyRef.current({ severity: 'error', message });
      } finally {
        refreshInFlightRef.current = false;
        setRefreshing(false);
      }
    },
    [mediaId, onOcrChange],
  );

  useEffect(() => {
    if (visible) setMobilePane('ocr');
    if (!visible) onFullPaneChange(false);
  }, [onFullPaneChange, visible]);

  useEffect(() => {
    if (!visible || ocr == null || !isProcessing(ocr)) return;
    void refresh(true);
    const interval = window.setInterval(() => void refresh(true), 5_000);
    return () => window.clearInterval(interval);
  }, [ocr?.qualityStatus, ocr?.state, refresh, visible]);

  useEffect(() => {
    if (!summaryVisible) return;
    onFullPaneChange(false);
    setMobilePane('source');
  }, [onFullPaneChange, summaryVisible]);

  const sourceWithSummary = (
    <MediaSummaryOverlay
      source={source}
      mediaId={mediaId}
      status={summary}
      visible={summaryVisible}
      onStatusChange={onSummaryChange}
      onClose={() => onSummaryVisibleChange(false)}
    />
  );

  if (!visible || mediaId == null) {
    if (summary == null || mediaId == null) return source;
    return (
      <Box sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', position: 'relative' }}>
        {sourceWithSummary}
        <Stack
          direction="row"
          spacing={0.5}
          sx={{ position: 'absolute', top: 8, right: 8, zIndex: 4 }}
        >
          <MediaSummaryAction
            status={summary}
            active={summaryVisible}
            onClick={() => onSummaryVisibleChange(!summaryVisible)}
          />
        </Stack>
      </Box>
    );
  }
  const showSource = mobile ? mobilePane === 'source' : !fullPane;
  const showOcr = mobile ? mobilePane === 'ocr' : true;

  return (
    <Box sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', position: 'relative' }}>
      <Box
        sx={{
          display: showSource ? 'flex' : 'none',
          flex: mobile ? '1 1 100%' : '1 1 50%',
          minWidth: 0,
          minHeight: 0,
          borderRight: mobile ? 0 : 1,
          borderColor: 'divider',
        }}
      >
        {sourceWithSummary}
      </Box>
      <Box
        sx={{
          display: showOcr ? 'flex' : 'none',
          flex: fullPane || mobile ? '1 1 100%' : '1 1 50%',
          minWidth: 0,
          minHeight: 0,
          position: 'relative',
          bgcolor: 'background.paper',
        }}
      >
        {ocr != null && isOcrReady(ocr) ? (
          <Box
            component="iframe"
            title="OCR"
            src={`/api/messenger/media/${encodeURIComponent(mediaId)}/ocr?revision=${iframeRevision}`}
            sandbox=""
            referrerPolicy="no-referrer"
            sx={{ flex: 1, minWidth: 0, border: 0, bgcolor: 'background.paper' }}
          />
        ) : ocr != null ? (
          <OcrStatusPane
            ocr={ocr}
            refreshing={refreshing}
            refreshError={refreshError}
            onRefresh={() => void refresh(false)}
          />
        ) : null}
      </Box>
      <Stack
        direction="row"
        spacing={0.5}
        sx={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}
      >
        <MediaSummaryAction
          status={summary}
          active={summaryVisible}
          onClick={() => onSummaryVisibleChange(!summaryVisible)}
        />
        {mobile ? (
          <>
            <Button
              size="small"
              variant={mobilePane === 'source' ? 'contained' : 'outlined'}
              onClick={() => setMobilePane('source')}
            >
              Оригінал
            </Button>
            <Button
              size="small"
              variant={mobilePane === 'ocr' ? 'contained' : 'outlined'}
              onClick={() => setMobilePane('ocr')}
            >
              OCR
            </Button>
          </>
        ) : (
          <Tooltip title={fullPane ? 'Повернути розділений перегляд' : 'Розгорнути OCR'}>
            <IconButton
              size="small"
              aria-label={fullPane ? 'Повернути розділений перегляд' : 'Розгорнути OCR'}
              onClick={() => onFullPaneChange(!fullPane)}
              sx={{ bgcolor: 'background.paper', boxShadow: 1 }}
            >
              {fullPane ? (
                <FullscreenExitIcon fontSize="small" />
              ) : (
                <FullscreenIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        )}
      </Stack>
    </Box>
  );
}
