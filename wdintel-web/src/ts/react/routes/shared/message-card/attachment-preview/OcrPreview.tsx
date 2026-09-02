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
import { RightPanelActiveIcon, RightPanelIcon } from '../../../../components/SidePanelToggleButton';
import { useOptionalPowerSnackbar } from '../../../../components/PowerSnackbar';
import { isAbortError } from '../../../../services/api/client';
import { getMediaOcrStatus } from '../../../../services/api/ocr';
import type { AttachmentPreviewInfoSection } from './MessageCardAttachmentPreviewInfoPopover';
import { MediaSummaryOverlay } from './MediaSummaryPreview';
import type { AttachmentPreviewDownloadItem } from './message-card-preview.types';
import { ReportTextPreviewLayout, type AttachmentPreviewReportDraft } from './ReportTextPreview';

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
    ...(ocr.queueSize == null ? [] : [{ label: 'Попереду в черзі', value: `${ocr.queueSize}` }]),
    ...(ocr.attempts > 0 ? [{ label: 'Повторні спроби', value: `${ocr.attempts}` }] : []),
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
  return ocr.queueSize == null ? '' : ` · попереду: ${ocr.queueSize}`;
}

function statusDescription(ocr: OcrMediaSummary): string {
  if (ocr.state === 'failed') return 'OCR завершився з помилкою.';
  if (ocr.state === 'pending' || ocr.state === 'queued') {
    return ocr.queueSize == null
      ? 'OCR очікує в черзі.'
      : `Попереду в OCR-черзі: ${ocr.queueSize}.`;
  }
  if (ocr.state === 'retry_wait') {
    const position = ocr.queueSize == null ? '' : ` Попереду: ${ocr.queueSize}.`;
    return `Очікує повторного надсилання.${position}`;
  }
  if (ocr.totalPages > 0) {
    return `Опрацьовано сторінок: ${ocr.processedPages} із ${ocr.totalPages}.`;
  }
  return 'OCR-extractor обробляє документ.';
}

function formatStatusLogTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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

  const Icon = active ? RightPanelActiveIcon : RightPanelIcon;

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
          <Icon fontSize="small" />
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
      data-attachment-preview-scroll
      spacing={2}
      alignItems="center"
      justifyContent="center"
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        width: '100%',
        height: '100%',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        touchAction: 'pan-y',
        WebkitOverflowScrolling: 'touch',
        p: 3,
        textAlign: 'center',
      }}
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
        {statusDescription(ocr)}
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
      {ocr.statusLog.length > 0 ? (
        <Box
          sx={{
            width: 'min(100%, 520px)',
            maxHeight: 180,
            overflow: 'auto',
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            p: 1.25,
            textAlign: 'left',
            bgcolor: 'background.paper',
          }}
        >
          <Typography variant="caption" sx={{ display: 'block', fontWeight: 600, mb: 0.75 }}>
            Хід обробки
          </Typography>
          <Stack spacing={0.5}>
            {ocr.statusLog.map((entry, index) => (
              <Stack key={`${entry.at}:${index}`} direction="row" spacing={1} alignItems="baseline">
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatStatusLogTime(entry.at)}
                </Typography>
                <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
                  {entry.message}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </Box>
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

function ScrollableOcrFrame({ mediaId, revision }: { mediaId: string; revision: number }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const src = `/api/messenger/media/${encodeURIComponent(mediaId)}/ocr?revision=${revision}`;

  useEffect(() => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    setContentHeight(null);

    return () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    };
  }, [src]);

  const handleLoad = useCallback(() => {
    const iframe = iframeRef.current;
    const frameDocument = iframe?.contentDocument;
    if (iframe == null || frameDocument == null) return;

    const updateContentHeight = () => {
      const nextHeight = Math.max(
        frameDocument.documentElement.scrollHeight,
        frameDocument.body?.scrollHeight ?? 0,
      );
      if (nextHeight > 0) {
        setContentHeight((height) => (height === nextHeight ? height : nextHeight));
      }
    };

    updateContentHeight();
    resizeObserverRef.current?.disconnect();
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(updateContentHeight);
    observer.observe(frameDocument.documentElement);
    if (frameDocument.body != null) observer.observe(frameDocument.body);
    resizeObserverRef.current = observer;
  }, []);

  const usesOuterScroll = contentHeight != null;

  return (
    <Box
      data-attachment-preview-scroll
      data-ocr-scroll-container
      sx={{
        flex: '1 1 0',
        width: '100%',
        height: 0,
        minWidth: 0,
        minHeight: 0,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        touchAction: 'pan-y',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      <Box
        ref={iframeRef}
        component="iframe"
        title="OCR"
        src={src}
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        scrolling={usesOuterScroll ? 'no' : 'yes'}
        onLoad={handleLoad}
        sx={{
          display: 'block',
          width: '100%',
          height: usesOuterScroll ? `${contentHeight}px` : '100%',
          minHeight: '100%',
          border: 0,
          bgcolor: 'background.paper',
        }}
      />
    </Box>
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
  reportDraft,
  reportVisible = false,
  onReportVisibleChange,
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
  reportDraft?: AttachmentPreviewReportDraft;
  reportVisible?: boolean;
  onReportVisibleChange?: (value: boolean) => void;
}) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [iframeRevision, setIframeRevision] = useState(0);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    setRefreshing(false);
    setRefreshError(null);
    return () => {
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
    };
  }, [mediaId]);

  const refresh = useCallback(
    async (quiet: boolean) => {
      if (mediaId == null || refreshControllerRef.current != null) return;
      const controller = new AbortController();
      refreshControllerRef.current = controller;
      setRefreshing(true);
      try {
        const nextOcr = await getMediaOcrStatus(mediaId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        onOcrChange(nextOcr);
        setRefreshError(null);
        if (isOcrReady(nextOcr)) setIframeRevision((revision) => revision + 1);
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        const message = `Не вдалося оновити статус OCR: ${
          error instanceof Error ? error.message : String(error)
        }`;
        setRefreshError(message);
        if (!quiet) notifyRef.current({ severity: 'error', message });
      } finally {
        if (refreshControllerRef.current === controller) {
          refreshControllerRef.current = null;
          setRefreshing(false);
        }
      }
    },
    [mediaId, onOcrChange],
  );

  useEffect(() => {
    if (!visible) onFullPaneChange(false);
  }, [onFullPaneChange, visible]);

  useEffect(() => {
    if (mobile && visible && summaryVisible) {
      onSummaryVisibleChange(false);
    }
  }, [mobile, onSummaryVisibleChange, summaryVisible, visible]);

  useEffect(() => {
    if (mobile && visible && reportVisible) {
      onReportVisibleChange?.(false);
    }
  }, [mobile, onReportVisibleChange, reportVisible, visible]);

  useEffect(() => {
    if (!visible || ocr == null || !isProcessing(ocr)) return;
    void refresh(true);
    const interval = window.setInterval(() => void refresh(true), 5_000);
    return () => window.clearInterval(interval);
  }, [ocr?.qualityStatus, ocr?.state, refresh, visible]);

  useEffect(() => {
    if (!summaryVisible) return;
    onFullPaneChange(false);
  }, [onFullPaneChange, summaryVisible]);

  useEffect(() => {
    if (!reportVisible) return;
    onFullPaneChange(false);
  }, [onFullPaneChange, reportVisible]);

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

  const showReport = reportDraft != null && reportVisible;
  if (showReport) {
    return <ReportTextPreviewLayout source={source} draft={reportDraft} visible />;
  }
  if (mediaId == null) return source;
  if (!visible && summary == null) return source;

  const ocrMediaId = mediaId ?? '';
  const hasSplitPane = visible;
  const showSource = hasSplitPane ? (mobile ? true : !fullPane) : true;
  const showOcr = visible;

  return (
    <Box
      sx={{
        flex: '1 1 0',
        height: 0,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: mobile ? 'column' : 'row',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          display: showSource ? 'flex' : 'none',
          flex: !hasSplitPane || fullPane ? '1 1 100%' : mobile ? '0 0 50%' : '1 1 50%',
          height: hasSplitPane && mobile ? '50%' : 'auto',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
          borderBottom: hasSplitPane && mobile ? 1 : 0,
          borderRight: hasSplitPane && !mobile && showSource ? 1 : 0,
          borderColor: 'divider',
        }}
      >
        {sourceWithSummary}
      </Box>
      {visible ? (
        <Box
          data-attachment-preview-scroll
          sx={{
            display: showOcr ? 'flex' : 'none',
            flexDirection: 'column',
            flex: fullPane ? '1 1 100%' : mobile ? '0 0 50%' : '1 1 50%',
            height: mobile ? '50%' : '100%',
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
            overscrollBehavior: 'contain',
            touchAction: 'pan-y',
            position: 'relative',
            bgcolor: 'background.paper',
          }}
        >
          {ocr != null && isOcrReady(ocr) ? (
            <ScrollableOcrFrame mediaId={ocrMediaId} revision={iframeRevision} />
          ) : ocr != null ? (
            <OcrStatusPane
              ocr={ocr}
              refreshing={refreshing}
              refreshError={refreshError}
              onRefresh={() => void refresh(false)}
            />
          ) : null}
          {!mobile ? (
            <Stack
              direction="row"
              spacing={0.5}
              sx={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}
            >
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
            </Stack>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
