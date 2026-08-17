import CloseIcon from '@mui/icons-material/Close';
import DescriptionIcon from '@mui/icons-material/Description';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
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
import { isAbortError } from '../../../../services/api/client';
import { mapCoordinates, type CoordinateLocality } from '../../../../services/api/location';
import { getMediaSummary, type MediaSummaryAccess } from '../../../../services/api/media-summary';
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
        const description = coordinate.description?.trim() ?? '';
        const plannedMeans = coordinate.plannedMeans?.trim() ?? '';
        return (
          <Box
            component="li"
            key={`${coordinate.coordinateSystem}:${coordinate.value}:${index}`}
            data-media-summary-coordinate-item="true"
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              alignItems: 'center',
              gap: 0.5,
              py: 0.5,
              minHeight: 32,
              borderBottom: 1,
              borderColor: 'divider',
            }}
          >
            <Box
              sx={{
                minWidth: 0,
                display: 'flex',
                alignItems: 'baseline',
                columnGap: 1,
                rowGap: 0.25,
                flexWrap: 'wrap',
              }}
            >
              <Typography variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>
                {coordinate.title}
              </Typography>
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
            </Box>
            {description !== '' || plannedMeans !== '' ? (
              <Tooltip
                placement="left"
                arrow
                enterDelay={200}
                slotProps={{ tooltip: { sx: { maxWidth: 420 } } }}
                title={
                  <Stack spacing={0.75} sx={{ maxWidth: 400 }}>
                    {description !== '' ? (
                      <Typography
                        variant="body2"
                        color="inherit"
                        data-media-summary-coordinate-description="true"
                        sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                      >
                        {coordinate.description}
                      </Typography>
                    ) : null}
                    {plannedMeans !== '' ? (
                      <Box>
                        <Typography variant="caption" color="inherit" sx={{ fontWeight: 700 }}>
                          Сплановані засоби
                        </Typography>
                        <Typography
                          variant="body2"
                          color="inherit"
                          data-media-summary-coordinate-planned-means="true"
                          sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                        >
                          {coordinate.plannedMeans}
                        </Typography>
                      </Box>
                    ) : null}
                  </Stack>
                }
              >
                <IconButton
                  size="small"
                  aria-label={`Деталі координати: ${coordinate.title}`}
                  data-media-summary-coordinate-info="true"
                  sx={{ width: 28, height: 28, color: 'text.secondary' }}
                >
                  <InfoOutlinedIcon sx={{ fontSize: 17 }} />
                </IconButton>
              </Tooltip>
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

function useMediaSummaryResult({
  mediaId,
  status,
  enabled,
  summaryAccess,
  onStatusChange,
}: {
  mediaId?: string | null;
  status?: MediaSummaryStatus | null;
  enabled: boolean;
  summaryAccess: MediaSummaryAccess;
  onStatusChange?: (status: MediaSummaryStatus) => void;
}) {
  const [result, setResult] = useState<MediaSummaryResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  useEffect(() => {
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    setResult(null);
    setRefreshing(false);
    setRefreshError(null);
    return () => {
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
    };
  }, [mediaId, summaryAccess]);

  const refresh = useCallback(
    async (quiet: boolean) => {
      if (mediaId == null || refreshControllerRef.current != null) return;
      const controller = new AbortController();
      refreshControllerRef.current = controller;
      setRefreshing(true);
      try {
        const nextResult = await getMediaSummary(
          mediaId,
          { signal: controller.signal },
          summaryAccess,
        );
        if (controller.signal.aborted) return;
        setResult(nextResult);
        setRefreshError(null);
        onStatusChangeRef.current?.({
          state: nextResult.state,
          lastError: nextResult.lastError,
          hasCoordinates: nextResult.state === 'completed' && nextResult.coordinates.length > 0,
        });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        const message = `Не вдалося завантажити стислий опис: ${
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
    [mediaId, summaryAccess],
  );

  const hasStatus = status != null;
  useEffect(() => {
    if (enabled && hasStatus) void refresh(false);
  }, [enabled, hasStatus, mediaId, refresh]);

  const state = result?.state ?? status?.state;
  useEffect(() => {
    if (!enabled || state == null || !isMediaSummaryProcessing(state)) return;
    const interval = window.setInterval(() => void refresh(true), 5_000);
    return () => window.clearInterval(interval);
  }, [enabled, refresh, state]);

  return { result, refreshing, refreshError, refresh };
}

export function MessageCardMediaSummary({
  mediaId,
  status,
  navigationOverlay = false,
}: {
  mediaId?: string | null;
  status?: MediaSummaryStatus | null;
  navigationOverlay?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { result, refreshing, refreshError, refresh } = useMediaSummaryResult({
    mediaId,
    status,
    enabled: mediaId != null && status != null,
    summaryAccess: 'messenger',
  });
  const state = result?.state ?? status?.state;
  const summary = result?.summary?.trim() ?? '';
  const lastError = result?.lastError ?? status?.lastError;
  const expandable = summary.length > 280 || summary.split(/\r?\n/).length > 3;

  useEffect(() => setExpanded(false), [mediaId, summary]);

  if (mediaId == null || status == null || state == null) return null;

  return (
    <Box
      data-media-summary-inline="true"
      sx={{ mt: navigationOverlay ? 0 : 0.5, width: 'min(460px, 100%)', minWidth: 0 }}
    >
      {state === 'completed' && summary !== '' ? (
        <Box
          component="blockquote"
          onClick={expandable ? () => setExpanded((current) => !current) : undefined}
          role={expandable ? 'button' : undefined}
          tabIndex={expandable ? 0 : undefined}
          aria-expanded={expandable ? expanded : undefined}
          onKeyDown={(event) => {
            if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            setExpanded((current) => !current);
          }}
          sx={{
            m: 0,
            pl: 1,
            pr: navigationOverlay ? 10 : 1,
            py: 0.75,
            borderLeft: 3,
            borderColor: 'primary.main',
            borderRadius: 0.5,
            bgcolor: 'action.hover',
            color: 'text.primary',
            cursor: expandable ? 'pointer' : 'default',
          }}
        >
          <Stack direction="row" spacing={0.75} alignItems="flex-start">
            <DescriptionIcon sx={{ mt: 0.15, fontSize: 17, color: 'text.secondary' }} />
            <Typography
              variant="body2"
              sx={{
                minWidth: 0,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                ...(!expanded
                  ? {
                      display: '-webkit-box',
                      WebkitBoxOrient: 'vertical',
                      WebkitLineClamp: 3,
                      overflow: 'hidden',
                    }
                  : {}),
              }}
            >
              {summary}
            </Typography>
          </Stack>
        </Box>
      ) : (
        <Stack
          direction="row"
          spacing={0.75}
          alignItems="center"
          sx={{
            pl: 1,
            pr: navigationOverlay ? 10 : 1,
            py: 0.5,
            color: state === 'failed' ? 'error.main' : 'text.secondary',
          }}
        >
          {isMediaSummaryProcessing(state) || refreshing ? <CircularProgress size={14} /> : null}
          <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
            {lastError || refreshError || STATE_LABELS[state] || state}
          </Typography>
          {state === 'failed' || refreshError != null ? (
            <IconButton
              size="small"
              aria-label="Оновити стислий опис"
              disabled={refreshing}
              onClick={() => void refresh(false)}
            >
              <RefreshIcon sx={{ fontSize: 16 }} />
            </IconButton>
          ) : null}
        </Stack>
      )}
    </Box>
  );
}

export function MessageCardMediaSummaryCarousel({
  media,
  onIndexChange,
}: {
  media: Array<{
    id?: string | null;
    summary?: MediaSummaryStatus | null;
  }>;
  onIndexChange?: (index: number) => void;
}) {
  const mediaIds = media.map((item, itemIndex) => item.id ?? itemIndex).join('\0');
  const firstSummaryIndex = media.findIndex((item) => item.id != null && item.summary != null);
  const [index, setIndex] = useState(() => Math.max(0, firstSummaryIndex));

  useEffect(() => {
    const nextIndex = Math.max(0, firstSummaryIndex);
    setIndex(nextIndex);
    onIndexChange?.(nextIndex);
  }, [firstSummaryIndex, mediaIds, onIndexChange]);

  const resolvedIndex = Math.min(index, media.length - 1);
  const current = media[resolvedIndex];
  if (firstSummaryIndex < 0 || current == null) return null;
  const hasCurrentSummary = current.id != null && current.summary != null;

  const selectIndex = (nextIndex: number) => {
    setIndex(nextIndex);
    onIndexChange?.(nextIndex);
  };

  return (
    <Box
      data-media-summary-carousel="true"
      sx={{
        position: 'relative',
        mt: 1,
        width: hasCurrentSummary ? 'min(460px, 100%)' : 'fit-content',
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      <Box
        key={`${current.id ?? resolvedIndex}:${resolvedIndex}`}
        data-media-summary-carousel-content="true"
        sx={{
          minHeight: hasCurrentSummary ? 72 : undefined,
          animation: 'media-summary-carousel-in 160ms ease-out',
          '@keyframes media-summary-carousel-in': {
            from: { opacity: 0.55, transform: 'translateX(2px)' },
            to: { opacity: 1, transform: 'translateX(0)' },
          },
        }}
      >
        {hasCurrentSummary ? (
          <MessageCardMediaSummary
            mediaId={current.id}
            status={current.summary}
            navigationOverlay={media.length > 1}
          />
        ) : (
          <Box
            data-media-summary-inline="true"
            sx={{
              width: 'fit-content',
              maxWidth: '100%',
              minWidth: 0,
              pl: 1,
              pr: 10,
              py: 0.75,
              borderLeft: 3,
              borderColor: 'divider',
              borderRadius: 0.5,
              bgcolor: 'action.hover',
            }}
          >
            <Typography variant="caption" color="text.secondary">
              Стислий опис відсутній
            </Typography>
          </Box>
        )}
      </Box>
      {media.length > 1 ? (
        <Stack
          data-media-summary-navigation="true"
          direction="row"
          spacing={0.25}
          alignItems="center"
          sx={{
            position: 'absolute',
            top: 4,
            right: 4,
            zIndex: 1,
            bgcolor: 'background.paper',
            borderRadius: 1,
            boxShadow: 1,
          }}
        >
          <IconButton
            size="small"
            aria-label="Попередній стислий опис"
            disabled={resolvedIndex === 0}
            onClick={() => selectIndex(Math.max(0, resolvedIndex - 1))}
            sx={{ width: 24, height: 24, p: 0, fontSize: 14 }}
          >
            {'<'}
          </IconButton>
          <Typography
            variant="caption"
            aria-live="polite"
            sx={{ minWidth: 30, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
          >
            {`${resolvedIndex + 1}/${media.length}`}
          </Typography>
          <IconButton
            size="small"
            aria-label="Наступний стислий опис"
            disabled={resolvedIndex === media.length - 1}
            onClick={() => selectIndex(Math.min(media.length - 1, resolvedIndex + 1))}
            sx={{ width: 24, height: 24, p: 0, fontSize: 14 }}
          >
            {'>'}
          </IconButton>
        </Stack>
      ) : null}
    </Box>
  );
}

export function MediaSummaryOverlay({
  source,
  mediaId,
  status,
  visible,
  onStatusChange,
  onClose,
  summaryAccess = 'messenger',
}: {
  source: ReactNode;
  mediaId?: string | null;
  status?: MediaSummaryStatus | null;
  visible: boolean;
  onStatusChange: (status: MediaSummaryStatus) => void;
  onClose: () => void;
  summaryAccess?: MediaSummaryAccess;
}) {
  const { result, refreshing, refreshError, refresh } = useMediaSummaryResult({
    mediaId,
    status,
    enabled: visible,
    summaryAccess,
    onStatusChange,
  });

  if (mediaId == null || status == null) return source;

  return (
    <Box
      sx={{
        flex: '1 1 auto',
        minHeight: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box sx={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, display: 'flex' }}>{source}</Box>
      {visible ? (
        <Box
          role="region"
          aria-label="Стислий опис документа"
          sx={{
            position: 'relative',
            flex: '0 0 auto',
            maxHeight: '35%',
            minHeight: 96,
            overflow: 'auto',
            px: 2,
            py: 1.5,
            pr: 6,
            borderTop: 1,
            borderColor: 'divider',
            bgcolor: 'background.paper',
            color: 'text.primary',
          }}
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
