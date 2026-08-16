import CloseIcon from '@mui/icons-material/Close';
import DescriptionIcon from '@mui/icons-material/Description';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  alpha,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import type { MediaSummaryResult, MediaSummaryStatus } from '../../../../../../Bindings';
import { useOptionalPowerSnackbar } from '../../../../components/PowerSnackbar';
import { getMediaSummary } from '../../../../services/api/media-summary';

const STATE_LABELS: Record<string, string> = {
  queued: 'Опис у черзі',
  running: 'Опис створюється',
  retry_wait: 'Опис очікує повтору',
  completed: 'Стислий опис',
  failed: 'Не вдалося створити опис',
};

export function isMediaSummaryProcessing(state: string): boolean {
  return state === 'queued' || state === 'running' || state === 'retry_wait';
}

export function MediaSummaryAction({
  status,
  active,
  onClick,
}: {
  status?: MediaSummaryStatus | null;
  active: boolean;
  onClick: () => void;
}) {
  if (status == null) return null;
  const processing = isMediaSummaryProcessing(status.state);
  const title = active ? 'Закрити стислий опис' : 'Показати стислий опис';

  return (
    <Tooltip title={title} enterDelay={300}>
      <Box component="span" sx={{ display: 'inline-flex', position: 'relative' }}>
        <IconButton
          size="small"
          aria-label={title}
          aria-pressed={active}
          color={active ? 'primary' : 'default'}
          onClick={onClick}
          sx={{
            bgcolor: 'background.paper',
            boxShadow: 1,
            color: active ? 'primary.main' : processing ? 'info.main' : 'text.secondary',
          }}
        >
          <DescriptionIcon fontSize="small" />
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

function SummaryContent({
  result,
  status,
  refreshing,
  refreshError,
  onRefresh,
}: {
  result: MediaSummaryResult | null;
  status: MediaSummaryStatus;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh: () => void;
}) {
  const state = result?.state ?? status.state;
  const lastError = result?.lastError ?? status.lastError;
  if (state === 'completed' && result?.summary) {
    return (
      <Typography variant="body1" sx={{ fontWeight: 600, whiteSpace: 'pre-wrap' }}>
        {result.summary}
      </Typography>
    );
  }

  return (
    <Stack spacing={1} alignItems="flex-start">
      <Stack direction="row" spacing={1} alignItems="center">
        {isMediaSummaryProcessing(state) ? <CircularProgress size={18} /> : null}
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {STATE_LABELS[state] ?? state}
        </Typography>
      </Stack>
      {lastError ? (
        <Typography variant="body2" color={state === 'failed' ? 'error.main' : 'warning.main'}>
          {lastError}
        </Typography>
      ) : null}
      {refreshError ? (
        <Typography variant="body2" color="error.main" role="alert">
          {refreshError}
        </Typography>
      ) : null}
      <Button
        size="small"
        variant="outlined"
        startIcon={refreshing ? <CircularProgress size={14} /> : <RefreshIcon />}
        disabled={refreshing}
        onClick={onRefresh}
      >
        Оновити
      </Button>
    </Stack>
  );
}

export function MediaSummaryOverlay({
  source,
  mediaId,
  status,
  visible,
  onStatusChange,
  onClose,
}: {
  source: ReactNode;
  mediaId?: string | null;
  status?: MediaSummaryStatus | null;
  visible: boolean;
  onStatusChange: (status: MediaSummaryStatus) => void;
  onClose: () => void;
}) {
  const [result, setResult] = useState<MediaSummaryResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshInFlight = useRef(false);
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const refresh = useCallback(
    async (quiet: boolean) => {
      if (mediaId == null || refreshInFlight.current) return;
      refreshInFlight.current = true;
      setRefreshing(true);
      try {
        const nextResult = await getMediaSummary(mediaId);
        setResult(nextResult);
        setRefreshError(null);
        onStatusChangeRef.current({ state: nextResult.state, lastError: nextResult.lastError });
      } catch (error) {
        const message = `Не вдалося завантажити стислий опис: ${
          error instanceof Error ? error.message : String(error)
        }`;
        setRefreshError(message);
        if (!quiet) notifyRef.current({ severity: 'error', message });
      } finally {
        refreshInFlight.current = false;
        setRefreshing(false);
      }
    },
    [mediaId],
  );

  const hasStatus = status != null;
  useEffect(() => {
    setResult(null);
    setRefreshError(null);
    if (visible && hasStatus) void refresh(false);
  }, [hasStatus, mediaId, refresh, visible]);

  const state = result?.state ?? status?.state;
  useEffect(() => {
    if (!visible || state == null || !isMediaSummaryProcessing(state)) return;
    const interval = window.setInterval(() => void refresh(true), 5_000);
    return () => window.clearInterval(interval);
  }, [refresh, state, visible]);

  if (mediaId == null || status == null) return source;

  return (
    <Box
      sx={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, display: 'flex', position: 'relative' }}
    >
      {source}
      {visible ? (
        <Box
          role="region"
          aria-label="Стислий опис документа"
          sx={(theme) => ({
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: '30%',
            minHeight: 120,
            overflow: 'auto',
            zIndex: 3,
            px: 2,
            py: 1.5,
            pr: 6,
            borderTop: 1,
            borderColor: 'divider',
            bgcolor: alpha(theme.palette.background.paper, 0.82),
            backdropFilter: 'blur(4px)',
          })}
        >
          <IconButton
            size="small"
            aria-label="Закрити стислий опис"
            onClick={onClose}
            sx={{ position: 'absolute', top: 6, right: 8 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
          <SummaryContent
            result={result}
            status={status}
            refreshing={refreshing}
            refreshError={refreshError}
            onRefresh={() => void refresh(false)}
          />
        </Box>
      ) : null}
    </Box>
  );
}
