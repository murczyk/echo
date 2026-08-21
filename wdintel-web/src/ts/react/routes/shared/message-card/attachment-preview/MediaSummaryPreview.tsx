import ArrowLeftIcon from '@mui/icons-material/ArrowLeft';
import ArrowRightIcon from '@mui/icons-material/ArrowRight';
import DescriptionIcon from '@mui/icons-material/Description';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Button,
  CircularProgress,
  IconButton,
  Skeleton,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type {
  MediaSummaryCoordinate,
  MediaSummaryResult,
  MediaSummaryStatus,
} from '../../../../../../Bindings';
import { formatCoordinateLocality } from '../../../../../maps/coordinate-locality';
import {
  BottomPanelActiveIcon,
  BottomPanelIcon,
} from '../../../../components/SidePanelToggleButton';
import { useOptionalPowerSnackbar } from '../../../../components/PowerSnackbar';
import { isAbortError } from '../../../../services/api/client';
import { mapCoordinates, type CoordinateLocality } from '../../../../services/api/location';
import {
  getMediaSummary,
  retryMediaSummary,
  type MediaSummaryAccess,
} from '../../../../services/api/media-summary';
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
const SUMMARY_LOAD_ERROR = 'Не вдалося завантажити стислий опис';
const SUMMARY_RETRY_ERROR = 'Не вдалося повторно запустити створення опису';

export const MEDIA_SUMMARY_CACHE_LIMIT = 50;
export const MEDIA_SUMMARY_LOCALITY_CACHE_LIMIT = 500;
const summaryCache = new Map<string, MediaSummaryResult>();
const localityCache = new Map<string, CoordinateLocality | null>();

function getLruCacheValue<Value>(cache: Map<string, Value>, key: string): Value | undefined {
  const cached = cache.get(key);
  if (cached === undefined) return undefined;

  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function setLruCacheValue<Value>(
  cache: Map<string, Value>,
  key: string,
  value: Value,
  limit: number,
): void {
  cache.delete(key);
  while (cache.size >= limit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  cache.set(key, value);
}

function summaryResultMatchesStatus(
  result: MediaSummaryResult,
  status: MediaSummaryStatus | null | undefined,
): boolean {
  const hasCoordinates = result.state === 'completed' && result.coordinates.length > 0;
  return (
    status != null &&
    result.state === status.state &&
    result.lastError === status.lastError &&
    hasCoordinates === status.hasCoordinates
  );
}

function getCompatibleCachedSummary(
  cacheKey: string | null,
  status: MediaSummaryStatus | null | undefined,
): MediaSummaryResult | null {
  if (cacheKey == null) return null;
  const cached = getLruCacheValue(summaryCache, cacheKey) ?? null;
  if (cached == null) return null;

  if (summaryResultMatchesStatus(cached, status)) return cached;

  summaryCache.delete(cacheKey);
  return null;
}

export function clearMediaSummaryCache(
  mediaId?: string,
  summaryAccess: MediaSummaryAccess = 'messenger',
): void {
  if (mediaId != null) {
    summaryCache.delete(`${summaryAccess}:${mediaId}`);
  } else {
    summaryCache.clear();
    localityCache.clear();
  }
}

function getLocalityCacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function useCoordinateLocalities(coordinates: MediaSummaryCoordinate[]): {
  localities: Array<CoordinateLocality | null>;
  loading: boolean;
} {
  const resolvedPoints = useMemo(
    () => coordinates.map(resolveMediaSummaryCoordinatePoint),
    [coordinates],
  );
  const pointsKey = useMemo(
    () =>
      resolvedPoints
        .flatMap((p) => (p == null ? [] : [`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`]))
        .join(';'),
    [resolvedPoints],
  );

  const [localities, setLocalities] = useState<Array<CoordinateLocality | null>>(() =>
    resolvedPoints.map((point) => {
      if (point == null) return null;
      return getLruCacheValue(localityCache, getLocalityCacheKey(point.lat, point.lng)) ?? null;
    }),
  );
  const [loading, setLoading] = useState<boolean>(false);
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    const nextLocalities = resolvedPoints.map((point) => {
      if (point == null) return null;
      return getLruCacheValue(localityCache, getLocalityCacheKey(point.lat, point.lng)) ?? null;
    });

    const missingPoints: Array<{ index: number; lat: number; lon: number }> = [];
    resolvedPoints.forEach((point, index) => {
      if (point != null) {
        const key = getLocalityCacheKey(point.lat, point.lng);
        if (!localityCache.has(key)) {
          missingPoints.push({ index, lat: point.lat, lon: point.lng });
        }
      }
    });

    setLocalities(nextLocalities);

    if (missingPoints.length === 0) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    void mapCoordinates(
      missingPoints.map(({ lat, lon }) => ({ lat, lon })),
      { signal: controller.signal },
    )
      .then((mapped) => {
        if (controller.signal.aborted) return;
        mapped.forEach((item, idx) => {
          const source = missingPoints[idx];
          if (source != null) {
            const key = getLocalityCacheKey(source.lat, source.lon);
            setLruCacheValue(localityCache, key, item.locality, MEDIA_SUMMARY_LOCALITY_CACHE_LIMIT);
            nextLocalities[source.index] = item.locality;
          }
        });
        setLocalities([...nextLocalities]);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        notifyRef.current({
          severity: 'error',
          message: `Не вдалося визначити найближчі населені пункти: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });

    return () => controller.abort();
  }, [coordinates.length, pointsKey, resolvedPoints]);

  return { localities, loading };
}

function MediaSummaryCoordinateList({
  coordinates,
  localities,
  loadingLocalities,
}: {
  coordinates: MediaSummaryCoordinate[];
  localities: Array<CoordinateLocality | null>;
  loadingLocalities: boolean;
}) {
  return (
    <ul className="m-0 p-0 list-none">
      {coordinates.map((coordinate, index) => {
        const point = resolveMediaSummaryCoordinatePoint(coordinate);
        const localityText = formatCoordinateLocality(localities[index] ?? null);
        const description = coordinate.description?.trim() ?? '';
        const plannedMeans = coordinate.plannedMeans?.trim() ?? '';
        const isLocalityLoading = loadingLocalities && point != null && localityText == null;

        return (
          <li
            key={`${coordinate.coordinateSystem}:${coordinate.value}:${index}`}
            data-media-summary-coordinate-item="true"
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 py-1 min-h-8 border-b last:border-b-0 border-white/12"
          >
            <div className="min-w-0 flex items-baseline gap-x-2 flex-wrap">
              <Typography variant="subtitle2" className="wrap-break-word">
                {coordinate.title}
              </Typography>
              <Typography variant="caption" color="text.secondary" className="font-bold">
                {COORDINATE_SYSTEM_LABELS[coordinate.coordinateSystem] ??
                  coordinate.coordinateSystem}
              </Typography>
              <Typography variant="body2" className="font-semibold tabular-nums wrap-break-word">
                {coordinate.value}
              </Typography>
              {localityText ? (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  data-media-summary-coordinate-locality="true"
                  className="basis-full w-full wrap-break-word"
                >
                  {localityText}
                </Typography>
              ) : isLocalityLoading ? (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  data-media-summary-coordinate-locality="true"
                  className="basis-full w-full wrap-break-word"
                >
                  <Skeleton width={180} />
                </Typography>
              ) : null}
            </div>
            {description !== '' || plannedMeans !== '' ? (
              <Tooltip
                placement="left"
                arrow
                enterDelay={200}
                slotProps={{ tooltip: { sx: { maxWidth: 420 } } }}
                title={
                  <div className="flex flex-col gap-1.5 max-w-100">
                    {description !== '' ? (
                      <Typography
                        variant="body2"
                        color="inherit"
                        data-media-summary-coordinate-description="true"
                        className="whitespace-pre-wrap wrap-break-word"
                      >
                        {coordinate.description}
                      </Typography>
                    ) : null}
                    {plannedMeans !== '' ? (
                      <div>
                        <Typography variant="caption" color="inherit" className="font-bold">
                          Сплановані засоби
                        </Typography>
                        <Typography
                          variant="body2"
                          color="inherit"
                          data-media-summary-coordinate-planned-means="true"
                          className="whitespace-pre-wrap wrap-break-word"
                        >
                          {coordinate.plannedMeans}
                        </Typography>
                      </div>
                    ) : null}
                  </div>
                }
              >
                <IconButton
                  size="small"
                  aria-label={`Деталі координати: ${coordinate.title}`}
                  data-media-summary-coordinate-info="true"
                  className="w-7! h-7! text-(--color-text-muted)!"
                >
                  <InfoOutlinedIcon className="text-[17px]!" />
                </IconButton>
              </Tooltip>
            ) : null}
          </li>
        );
      })}
    </ul>
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
  const Icon = active ? BottomPanelActiveIcon : BottomPanelIcon;

  return (
    <Tooltip title={title} enterDelay={300}>
      <span className="inline-flex relative">
        <IconButton
          size="small"
          aria-label={title}
          aria-pressed={active}
          color={active ? 'primary' : 'default'}
          onClick={onClick}
          className={
            active
              ? 'text-(--color-primary)!'
              : processing
                ? 'text-blue-500!'
                : 'text-(--color-text-muted)! hover:text-(--color-text)!'
          }
        >
          <Icon fontSize="small" />
        </IconButton>
        {processing ? (
          <CircularProgress
            size={26}
            thickness={2.5}
            color="info"
            className="absolute! inset-0.75! pointer-events-none"
          />
        ) : null}
      </span>
    </Tooltip>
  );
}

function SummaryContent({
  result,
  status,
  refreshing,
  refreshError,
  showErrorDetails,
  onRefresh,
  onRetry,
}: {
  result: MediaSummaryResult | null;
  status: MediaSummaryStatus;
  refreshing: boolean;
  refreshError: string | null;
  showErrorDetails: boolean;
  onRefresh: () => void;
  onRetry: () => void;
}) {
  const state = result?.state ?? status.state;
  const lastError = showErrorDetails ? (result?.lastError ?? status.lastError) : null;
  const coordinates = result?.coordinates ?? EMPTY_COORDINATES;
  const { localities: coordinateLocalities, loading: loadingLocalities } =
    useCoordinateLocalities(coordinates);

  const hasSummaryText = result?.summary != null && result.summary.trim() !== '';
  const hasCoordinates = result?.coordinates != null && result.coordinates.length > 0;

  if (state === 'completed' && (hasSummaryText || hasCoordinates)) {
    if (!hasCoordinates) {
      return (
        <div className="flex-1 min-h-0 overflow-y-auto pr-1 max-w-6xl mx-auto w-full">
          <Typography variant="body2" className="whitespace-pre-wrap">
            {result?.summary}
          </Typography>
        </div>
      );
    }

    if (!hasSummaryText) {
      return (
        <div className="flex-1 min-h-0 overflow-y-auto pr-1 max-w-6xl mx-auto w-full">
          <MediaSummaryCoordinateList
            coordinates={result.coordinates}
            localities={coordinateLocalities}
            loadingLocalities={loadingLocalities}
          />
        </div>
      );
    }

    return (
      <div
        data-media-summary-completed-layout="split"
        className="grid grid-cols-1 sm:grid-cols-2 grid-rows-2 sm:grid-rows-1 gap-2 sm:gap-4 min-w-0 flex-1 min-h-0 h-full"
      >
        <div className="min-w-0 min-h-0 overflow-y-auto pr-1">
          <Typography variant="body2" className="whitespace-pre-wrap">
            {result.summary}
          </Typography>
        </div>

        <div
          data-media-summary-coordinate-column="true"
          className="min-w-0 min-h-0 overflow-y-auto border-t sm:border-t-0 sm:border-l border-white/12 pt-2 sm:pt-0 sm:pl-4 pr-1"
        >
          <MediaSummaryCoordinateList
            coordinates={result.coordinates}
            localities={coordinateLocalities}
            loadingLocalities={loadingLocalities}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 py-0.5 min-h-10 justify-center">
      <div className="flex flex-row items-center gap-3 flex-wrap">
        <div className="flex flex-row gap-2 items-center">
          {isMediaSummaryProcessing(state) ? <CircularProgress size={18} /> : null}

          <Typography variant="body2" className="font-semibold">
            {STATE_LABELS[state] ?? state}
          </Typography>
        </div>

        <Button
          size="small"
          variant="outlined"
          startIcon={refreshing ? <CircularProgress size={14} /> : <RefreshIcon />}
          disabled={refreshing}
          onClick={state === 'failed' ? onRetry : onRefresh}
        >
          {state === 'failed' ? 'Повторити' : 'Оновити'}
        </Button>
      </div>

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
    </div>
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
  const cacheKey = mediaId != null ? `${summaryAccess}:${mediaId}` : null;
  const [result, setResult] = useState<MediaSummaryResult | null>(() =>
    getCompatibleCachedSummary(cacheKey, status),
  );
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
    const cached = getCompatibleCachedSummary(cacheKey, status);
    setResult(cached);
    setRefreshing(false);
    setRefreshError(null);
    return () => {
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
    };
  }, [cacheKey, mediaId, summaryAccess]);

  useEffect(() => {
    const cached = getCompatibleCachedSummary(cacheKey, status);
    setResult((current) =>
      current != null && summaryResultMatchesStatus(current, status) ? current : cached,
    );
  }, [cacheKey, status?.hasCoordinates, status?.lastError, status?.state]);

  const request = useCallback(
    async (quiet: boolean, requeue: boolean) => {
      if (mediaId == null || refreshControllerRef.current != null) return;
      const key = `${summaryAccess}:${mediaId}`;
      const controller = new AbortController();
      refreshControllerRef.current = controller;
      setRefreshing(true);
      try {
        const nextResult = requeue
          ? await retryMediaSummary(mediaId, { signal: controller.signal }, summaryAccess)
          : await getMediaSummary(mediaId, { signal: controller.signal }, summaryAccess);
        if (controller.signal.aborted) return;
        if (nextResult.state === 'completed' || nextResult.state === 'failed') {
          setLruCacheValue(summaryCache, key, nextResult, MEDIA_SUMMARY_CACHE_LIMIT);
        } else {
          summaryCache.delete(key);
        }
        setResult(nextResult);
        setRefreshError(null);
        onStatusChangeRef.current?.({
          state: nextResult.state,
          lastError: nextResult.lastError,
          hasCoordinates: nextResult.state === 'completed' && nextResult.coordinates.length > 0,
        });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        const baseMessage = requeue ? SUMMARY_RETRY_ERROR : SUMMARY_LOAD_ERROR;
        const message =
          summaryAccess === 'admin-ocr'
            ? `${baseMessage}: ${error instanceof Error ? error.message : String(error)}`
            : baseMessage;
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
  const refresh = useCallback((quiet: boolean) => request(quiet, false), [request]);
  const retry = useCallback(() => request(false, true), [request]);

  const hasStatus = status != null;
  useEffect(() => {
    if (!enabled || !hasStatus) return;
    const key = mediaId != null ? `${summaryAccess}:${mediaId}` : null;
    const cached = getCompatibleCachedSummary(key, status);
    if (cached != null) {
      setResult(cached);
      onStatusChangeRef.current?.({
        state: cached.state,
        lastError: cached.lastError,
        hasCoordinates: cached.state === 'completed' && cached.coordinates.length > 0,
      });
    } else if (result == null) {
      void refresh(false);
    }
  }, [
    enabled,
    hasStatus,
    mediaId,
    refresh,
    result,
    status?.hasCoordinates,
    status?.lastError,
    status?.state,
    summaryAccess,
  ]);

  const state = result?.state ?? status?.state;
  useEffect(() => {
    if (!enabled || state == null || !isMediaSummaryProcessing(state)) return;
    const interval = window.setInterval(() => void refresh(true), 5_000);
    return () => window.clearInterval(interval);
  }, [enabled, refresh, state]);

  return { result, refreshing, refreshError, refresh, retry };
}

export function MessageCardMediaSummary({
  mediaId,
  status,
  pagination,
}: {
  mediaId?: string | null;
  status?: MediaSummaryStatus | null;
  pagination?: {
    index: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
  } | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const { result, refreshing, refreshError, refresh, retry } = useMediaSummaryResult({
    mediaId,
    status,
    enabled: mediaId != null && status != null,
    summaryAccess: 'messenger',
  });

  const state = result?.state ?? status?.state;
  const summary = result?.summary?.trim() ?? '';
  const isFailed = state === 'failed' || refreshError != null;
  const isProcessing = (state != null && isMediaSummaryProcessing(state)) || refreshing;
  const isNoResult = mediaId == null || status == null || (state === 'completed' && summary === '');
  const hasSummary = !isNoResult && !isFailed && !isProcessing && summary !== '';
  const expandable = summary.length > 280 || summary.split(/\r?\n/).length > 3;

  useEffect(() => setExpanded(false), [mediaId, summary]);

  if (mediaId == null && pagination == null) return null;

  const borderColorClass = isFailed
    ? 'border-l-red-500'
    : isNoResult
      ? 'border-l-(--color-text-muted)'
      : 'border-l-(--color-primary)';

  const iconColorClass = isFailed
    ? 'text-red-500'
    : isNoResult
      ? 'text-(--color-text-muted)'
      : 'text-(--color-primary)';

  return (
    <div
      data-media-summary-inline="true"
      className={`min-w-0 w-[min(580px,100%)] p-1 rounded bg-black/5 dark:bg-white/5 border-l-[3px] ${borderColorClass} flex flex-row items-start gap-1`}
    >
      <DescriptionIcon className={`text-[20px]! shrink-0 mt-0.5 ${iconColorClass}`} />

      <div className="flex-1 min-w-0 px-1 py-0.5">
        {isFailed ? (
          <div className="flex flex-row items-center gap-1.5 flex-wrap">
            <Typography
              variant="body2"
              className="text-red-500 font-normal text-sm leading-5 wrap-break-word"
            >
              {refreshError || 'Не вдалося створити опис'}
            </Typography>
            <IconButton
              size="small"
              aria-label={state === 'failed' ? 'Повторити стислий опис' : 'Оновити стислий опис'}
              disabled={refreshing}
              onClick={() => void (state === 'failed' ? retry() : refresh(false))}
              className="p-1! text-white! hover:bg-black/10 dark:hover:bg-white/10"
            >
              <RefreshIcon className="text-lg!" />
            </IconButton>
          </div>
        ) : isNoResult ? (
          <Typography
            variant="body2"
            className="text-(--color-text-muted) font-normal text-sm leading-5"
          >
            Не розпізнаний контент
          </Typography>
        ) : isProcessing ? (
          <div className="flex flex-row items-center gap-1.5">
            <CircularProgress size={14} className="text-(--color-primary)!" />
            <Typography
              variant="body2"
              className="text-(--color-text-muted) font-normal text-sm leading-5"
            >
              {STATE_LABELS[state ?? ''] ?? state ?? 'Опис створюється'}
            </Typography>
          </div>
        ) : (
          <Typography
            variant="body2"
            className={`min-w-0 text-(--color-text) font-normal text-sm leading-5 whitespace-pre-wrap wrap-break-word ${
              !expanded ? 'line-clamp-3 overflow-hidden' : ''
            }`}
          >
            {summary}
          </Typography>
        )}
      </div>

      <div className="flex flex-col items-end justify-between self-stretch shrink-0 gap-1 pl-1">
        {pagination != null && pagination.total > 1 ? (
          <div
            data-media-summary-navigation="true"
            className="flex flex-row items-center gap-0.5 bg-black/10 dark:bg-white/10 rounded px-0.5"
          >
            <IconButton
              size="small"
              aria-label="Попередній стислий опис"
              disabled={pagination.index === 0}
              onClick={pagination.onPrev}
              className="w-6! h-6! p-0.5! text-xl! text-(--color-text-muted) disabled:opacity-50"
            >
              <ArrowLeftIcon className="text-xl!" />
            </IconButton>
            <Typography
              variant="caption"
              aria-live="polite"
              className="min-w-6 text-center tabular-nums font-semibold text-xs text-(--color-primary)"
            >
              {`${pagination.index + 1}/${pagination.total}`}
            </Typography>
            <IconButton
              size="small"
              aria-label="Наступний стислий опис"
              disabled={pagination.index === pagination.total - 1}
              onClick={pagination.onNext}
              className="w-6! h-6! p-0.5! text-xl! text-(--color-text-muted) disabled:opacity-50"
            >
              <ArrowRightIcon className="text-xl!" />
            </IconButton>
          </div>
        ) : (
          <div />
        )}

        {hasSummary ? (
          <IconButton
            size="small"
            aria-label={expanded ? 'Згорнути опис' : 'Розгорнути опис'}
            disabled={!expandable && !expanded}
            onClick={expandable ? () => setExpanded((curr) => !curr) : undefined}
            className="w-7! h-7! p-1! text-(--color-text-muted) hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-50 disabled:pointer-events-none self-end mt-auto"
          >
            {expanded ? (
              <KeyboardArrowUpIcon className="text-xl!" />
            ) : (
              <KeyboardArrowDownIcon className="text-xl!" />
            )}
          </IconButton>
        ) : null}
      </div>
    </div>
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

  const selectIndex = (nextIndex: number) => {
    setIndex(nextIndex);
    onIndexChange?.(nextIndex);
  };

  const pagination =
    media.length > 1
      ? {
          index: resolvedIndex,
          total: media.length,
          onPrev: () => selectIndex(Math.max(0, resolvedIndex - 1)),
          onNext: () => selectIndex(Math.min(media.length - 1, resolvedIndex + 1)),
        }
      : null;

  return (
    <div
      data-media-summary-carousel="true"
      className="relative mt-2 max-w-full min-w-0 w-[min(580px,100%)]"
    >
      <div
        key={`${current.id ?? resolvedIndex}:${resolvedIndex}`}
        data-media-summary-carousel-content="true"
        className="animate-[media-summary-carousel-in_160ms_ease-out]"
      >
        <MessageCardMediaSummary
          mediaId={current.id}
          status={current.summary}
          pagination={pagination}
        />
      </div>
    </div>
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
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('sm'));
  const { result, refreshing, refreshError, refresh, retry } = useMediaSummaryResult({
    mediaId,
    status,
    enabled: visible,
    summaryAccess,
    onStatusChange,
  });

  if (mediaId == null || status == null) return source;

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      <div
        className={`min-w-0 flex ${visible && mobile ? 'h-1/2 flex-none min-h-0' : 'flex-1 min-h-0'}`}
      >
        {source}
      </div>
      {visible ? (
        <div
          role="region"
          aria-label="Стислий опис документа"
          data-attachment-preview-scroll
          className={`relative flex-col overscroll-contain touch-pan-y px-4 pt-2.5 pb-1 border-t border-white/12 bg-inherit text-(--color-text) transition-[max-height] duration-200 ease-out ${
            mobile ? 'flex-none h-1/2 min-h-0 overflow-hidden flex' : 'flex-none max-h-44 flex'
          }`}
        >
          <SummaryContent
            result={result}
            status={status}
            refreshing={refreshing}
            refreshError={refreshError}
            showErrorDetails={summaryAccess === 'admin-ocr'}
            onRefresh={() => void refresh(false)}
            onRetry={() => void retry()}
          />
        </div>
      ) : null}
    </div>
  );
}
