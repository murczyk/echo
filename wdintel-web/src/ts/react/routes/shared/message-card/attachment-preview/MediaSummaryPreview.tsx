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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type {
  MediaSummaryCoordinate,
  MediaSummaryResult,
  MediaSummaryStatus,
} from '../../../../../../Bindings';
import { formatCoordinateLocality } from '../../../../../maps/coordinate-locality';
import { useOptionalPowerSnackbar } from '../../../../components/PowerSnackbar';
import { mapCoordinates, type CoordinateLocality } from '../../../../services/api/location';
import { getMediaSummary } from '../../../../services/api/media-summary';
import { resolveMediaSummaryCoordinatePoint } from '../message-coordinate-preview';

const STATE_LABELS: Record<string, string> = {
  queued: 'Опис у черзі',
  running: 'Опис створюється',
  retry_wait: 'Опис очікує повтору',
  completed: 'Стислий опис',
  failed: 'Не вдалося створити опис',
};

const COORDINATE_SYSTEM_LABELS: Record<string, string> = {
  sk42: 'СК-42',
  usk2000: 'УСК-2000',
  wgs84: 'WGS-84',
  mgrs: 'MGRS',
};

const EMPTY_COORDINATES: MediaSummaryCoordinate[] = [];

function useCoordinateLocalities(
  coordinates: MediaSummaryCoordinate[],
): Array<CoordinateLocality | null> {
  const resolvedPoints = useMemo(
    () => coordinates.map(resolveMediaSummaryCoordinatePoint),
    [coordinates],
  );
  const [localities, setLocalities] = useState<Array<CoordinateLocality | null>>([]);
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    const nextLocalities = Array.from<CoordinateLocality | null>({
      length: coordinates.length,
    }).fill(null);
    const lookupPoints = resolvedPoints.flatMap((point, index) =>
      point == null ? [] : [{ index, lat: point.lat, lon: point.lng }],
    );
    setLocalities(nextLocalities);
    if (lookupPoints.length === 0) return;

    const controller = new AbortController();
    void mapCoordinates(
      lookupPoints.map(({ lat, lon }) => ({ lat, lon })),
      { signal: controller.signal },
    )
      .then((mapped) => {
        if (controller.signal.aborted) return;
        mapped.forEach((item, index) => {
          const sourceIndex = lookupPoints[index]?.index;
          if (sourceIndex != null) nextLocalities[sourceIndex] = item.locality;
        });
        setLocalities([...nextLocalities]);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        notifyRef.current({
          severity: 'error',
          message: `Не вдалося визначити найближчі населені пункти: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });

    return () => controller.abort();
  }, [coordinates.length, resolvedPoints]);

  return localities;
}

function MediaSummaryCoordinateList({
  coordinates,
  localities,
}: {
  coordinates: MediaSummaryCoordinate[];
  localities: Array<CoordinateLocality | null>;
}) {
  return (
    <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
      {coordinates.map((coordinate, index) => {
        const localityText = formatCoordinateLocality(localities[index] ?? null);
        return (
          <Box
            component="li"
            key={`${coordinate.coordinateSystem}:${coordinate.value}:${index}`}
            data-media-summary-coordinate-item="true"
            sx={{ py: 1.25, borderBottom: 1, borderColor: 'divider', '&:first-of-type': { pt: 0 } }}
          >
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={{ xs: 0.25, md: 1 }}
              alignItems={{ xs: 'flex-start', md: 'baseline' }}
              sx={{ mb: 0.75 }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                {COORDINATE_SYSTEM_LABELS[coordinate.coordinateSystem] ??
                  coordinate.coordinateSystem}
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                  overflowWrap: 'anywhere',
                }}
              >
                {coordinate.value}
              </Typography>
              {localityText ? (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  data-media-summary-coordinate-locality="true"
                  sx={{ overflowWrap: 'anywhere' }}
                >
                  {localityText}
                </Typography>
              ) : null}
            </Stack>
            <Typography variant="subtitle2" sx={{ mb: 0.5, overflowWrap: 'anywhere' }}>
              {coordinate.title}
            </Typography>
            {coordinate.description?.trim() ? (
              <Typography
                variant="body2"
                data-media-summary-coordinate-description="true"
                sx={{ mb: 0.75, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {coordinate.description}
              </Typography>
            ) : null}
            {coordinate.plannedMeans?.trim() ? (
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                  Сплановані засоби
                </Typography>
                <Typography
                  variant="body2"
                  data-media-summary-coordinate-planned-means="true"
                  sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                >
                  {coordinate.plannedMeans}
                </Typography>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

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
  const coordinates = result?.coordinates ?? EMPTY_COORDINATES;
  const coordinateLocalities = useCoordinateLocalities(coordinates);
  if (state === 'completed' && result?.summary) {
    if (result.coordinates.length === 0) {
      return (
        <Typography variant="body1" sx={{ fontWeight: 600, whiteSpace: 'pre-wrap' }}>
          {result.summary}
        </Typography>
      );
    }

    return (
      <Box
        data-media-summary-completed-layout="split"
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
          gap: 2,
          minWidth: 0,
        }}
      >
        <Typography variant="body1" sx={{ fontWeight: 600, whiteSpace: 'pre-wrap' }}>
          {result.summary}
        </Typography>
        <Box
          data-media-summary-coordinate-column="true"
          sx={{
            minWidth: 0,
            borderTop: { xs: 1, sm: 0 },
            borderLeft: { xs: 0, sm: 1 },
            borderColor: 'divider',
            pt: { xs: 1.5, sm: 0 },
            pl: { xs: 0, sm: 2 },
          }}
        >
          <MediaSummaryCoordinateList
            coordinates={result.coordinates}
            localities={coordinateLocalities}
          />
        </Box>
      </Box>
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
        onStatusChangeRef.current({
          state: nextResult.state,
          lastError: nextResult.lastError,
          hasCoordinates: nextResult.state === 'completed' && nextResult.coordinates.length > 0,
        });
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
