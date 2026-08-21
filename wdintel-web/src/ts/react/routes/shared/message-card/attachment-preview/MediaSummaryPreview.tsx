import DescriptionIcon from '@mui/icons-material/Description';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Button, CircularProgress, IconButton, Skeleton, Tooltip, Typography } from '@mui/material';
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
const SUMMARY_LOAD_ERROR = 'Не вдалося завантажити стислий опис';

const summaryCache = new Map<string, MediaSummaryResult>();
const localityCache = new Map<string, CoordinateLocality | null>();

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
      return localityCache.get(getLocalityCacheKey(point.lat, point.lng)) ?? null;
    }),
  );
  const [loading, setLoading] = useState<boolean>(false);
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    const nextLocalities = resolvedPoints.map((point) => {
      if (point == null) return null;
      return localityCache.get(getLocalityCacheKey(point.lat, point.lng)) ?? null;
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
            localityCache.set(key, item.locality);
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
                  className="w-7! h-7! text-(--color-text-secondary)!"
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
                : 'text-(--color-text-secondary)! hover:text-(--color-text)!'
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
}: {
  result: MediaSummaryResult | null;
  status: MediaSummaryStatus;
  refreshing: boolean;
  refreshError: string | null;
  showErrorDetails: boolean;
  onRefresh: () => void;
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
        className="grid grid-cols-1 sm:grid-cols-2 gap-4 min-w-0 flex-1 min-h-0"
      >
        <div className="min-w-0 min-h-0 overflow-y-auto pr-1">
          <Typography variant="body2" className="whitespace-pre-wrap">
            {result.summary}
          </Typography>
        </div>

        <div
          data-media-summary-coordinate-column="true"
          className="min-w-0 min-h-0 overflow-y-auto border-t sm:border-t-0 sm:border-l border-white/12 sm:pt-0 sm:pl-4 pr-1"
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
    <div className="flex flex-col gap-2 items-start py-0.5 min-h-10 justify-center">
      <div className="flex flex-row gap-2 items-center">
        {isMediaSummaryProcessing(state) ? <CircularProgress size={18} /> : null}

        <Typography variant="body2" className="font-semibold">
          {STATE_LABELS[state] ?? state}
        </Typography>
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

      <Button
        size="small"
        variant="outlined"
        startIcon={refreshing ? <CircularProgress size={14} /> : <RefreshIcon />}
        disabled={refreshing}
        onClick={onRefresh}
      >
        Оновити
      </Button>
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
    cacheKey ? (summaryCache.get(cacheKey) ?? null) : null,
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
    const cached = cacheKey ? (summaryCache.get(cacheKey) ?? null) : null;
    setResult(cached);
    setRefreshing(false);
    setRefreshError(null);
    return () => {
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
    };
  }, [cacheKey, mediaId, summaryAccess]);

  const refresh = useCallback(
    async (quiet: boolean) => {
      if (mediaId == null || refreshControllerRef.current != null) return;
      const key = `${summaryAccess}:${mediaId}`;
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
        if (nextResult.state === 'completed' || nextResult.state === 'failed') {
          summaryCache.set(key, nextResult);
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
        const message =
          summaryAccess === 'admin-ocr'
            ? `${SUMMARY_LOAD_ERROR}: ${error instanceof Error ? error.message : String(error)}`
            : SUMMARY_LOAD_ERROR;
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
    if (!enabled || !hasStatus) return;
    const key = mediaId != null ? `${summaryAccess}:${mediaId}` : null;
    const cached = key ? summaryCache.get(key) : null;
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
  }, [enabled, hasStatus, mediaId, refresh, result, summaryAccess]);

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
  const expandable = summary.length > 280 || summary.split(/\r?\n/).length > 3;

  useEffect(() => setExpanded(false), [mediaId, summary]);

  if (mediaId == null || status == null || state == null) return null;

  return (
    <div
      data-media-summary-inline="true"
      className={`min-w-0 w-[min(460px,100%)] ${navigationOverlay ? 'mt-0' : 'mt-1'}`}
    >
      {state === 'completed' && summary !== '' ? (
        <blockquote
          onClick={expandable ? () => setExpanded((current) => !current) : undefined}
          role={expandable ? 'button' : undefined}
          tabIndex={expandable ? 0 : undefined}
          aria-expanded={expandable ? expanded : undefined}
          onKeyDown={(event) => {
            if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            setExpanded((current) => !current);
          }}
          className={`m-0 pl-2 py-1.5 border-l-[3px] border-(--color-primary) rounded bg-black/5 dark:bg-white/5 text-(--color-text) ${
            navigationOverlay ? 'pr-20' : 'pr-2'
          } ${expandable ? 'cursor-pointer' : 'cursor-default'}`}
        >
          <div className="flex flex-row gap-1.5 items-start">
            <DescriptionIcon className="mt-0.5 text-[17px]! text-(--color-text-secondary)" />
            <Typography
              variant="body2"
              className={`min-w-0 whitespace-pre-wrap wrap-break-word ${
                !expanded ? 'line-clamp-3 overflow-hidden' : ''
              }`}
            >
              {summary}
            </Typography>
          </div>
        </blockquote>
      ) : (
        <div
          className={`flex flex-row gap-1.5 items-center pl-2 py-1 ${
            navigationOverlay ? 'pr-20' : 'pr-2'
          } ${state === 'failed' ? 'text-red-500' : 'text-(--color-text-secondary)'}`}
        >
          {isMediaSummaryProcessing(state) || refreshing ? <CircularProgress size={14} /> : null}
          <Typography variant="caption" className="wrap-break-word">
            {refreshError || STATE_LABELS[state] || state}
          </Typography>
          {state === 'failed' || refreshError != null ? (
            <IconButton
              size="small"
              aria-label="Оновити стислий опис"
              disabled={refreshing}
              onClick={() => void refresh(false)}
            >
              <RefreshIcon className="text-lg!" />
            </IconButton>
          ) : null}
        </div>
      )}
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
  const hasCurrentSummary = current.id != null && current.summary != null;

  const selectIndex = (nextIndex: number) => {
    setIndex(nextIndex);
    onIndexChange?.(nextIndex);
  };

  return (
    <div
      data-media-summary-carousel="true"
      className={`relative mt-2 max-w-full min-w-0 ${
        hasCurrentSummary ? 'w-[min(460px,100%)]' : 'w-fit'
      }`}
    >
      <div
        key={`${current.id ?? resolvedIndex}:${resolvedIndex}`}
        data-media-summary-carousel-content="true"
        className={`animate-[media-summary-carousel-in_160ms_ease-out] ${
          hasCurrentSummary ? 'min-h-18' : ''
        }`}
      >
        {hasCurrentSummary ? (
          <MessageCardMediaSummary
            mediaId={current.id}
            status={current.summary}
            navigationOverlay={media.length > 1}
          />
        ) : (
          <div
            data-media-summary-inline="true"
            className="w-fit max-w-full min-w-0 pl-2 pr-20 py-1.5 border-l-[3px] border-(--color-border) rounded bg-black/5 dark:bg-white/5"
          >
            <Typography variant="caption" color="text.secondary">
              Стислий опис відсутній
            </Typography>
          </div>
        )}
      </div>
      {media.length > 1 ? (
        <div
          data-media-summary-navigation="true"
          className="flex flex-row gap-0.5 items-center absolute top-1 right-1 z-10 bg-(--color-card) rounded shadow"
        >
          <IconButton
            size="small"
            aria-label="Попередній стислий опис"
            disabled={resolvedIndex === 0}
            onClick={() => selectIndex(Math.max(0, resolvedIndex - 1))}
            className="w-6! h-6! p-0! text-sm!"
          >
            {'<'}
          </IconButton>
          <Typography
            variant="caption"
            aria-live="polite"
            className="min-w-7.5 text-center tabular-nums"
          >
            {`${resolvedIndex + 1}/${media.length}`}
          </Typography>
          <IconButton
            size="small"
            aria-label="Наступний стислий опис"
            disabled={resolvedIndex === media.length - 1}
            onClick={() => selectIndex(Math.min(media.length - 1, resolvedIndex + 1))}
            className="w-6! h-6! p-0! text-sm!"
          >
            {'>'}
          </IconButton>
        </div>
      ) : null}
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
  const { result, refreshing, refreshError, refresh } = useMediaSummaryResult({
    mediaId,
    status,
    enabled: visible,
    summaryAccess,
    onStatusChange,
  });

  if (mediaId == null || status == null) return source;

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      <div className="flex-1 min-h-0 min-w-0 flex">{source}</div>
      {visible ? (
        <div
          role="region"
          aria-label="Стислий опис документа"
          className="relative flex-none max-h-36 sm:max-h-44 flex flex-col px-4 pt-2.5 pb-1 border-t border-white/12 bg-inherit text-(--color-text) transition-[max-height] duration-200 ease-out"
        >
          <SummaryContent
            result={result}
            status={status}
            refreshing={refreshing}
            refreshError={refreshError}
            showErrorDetails={summaryAccess === 'admin-ocr'}
            onRefresh={() => void refresh(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
