import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { Box, ClickAwayListener, Paper, Popper, Tooltip, Typography } from '@mui/material';
import { ThemeProvider, useTheme } from '@mui/material/styles';
import type { SxProps, Theme } from '@mui/material/styles';
import type { ElementType, MouseEvent, ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { copyTextToClipboard } from '../../../../copy-to-clipboard';
import { PowerIconButton } from '../../PowerIconButton';

export type MrtOverflowMode = 'text' | 'items' | 'wrap' | 'custom' | 'none';

export function formatValueCount(count: number) {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;
  const noun =
    lastTwoDigits >= 11 && lastTwoDigits <= 14
      ? 'значень'
      : lastDigit >= 1 && lastDigit <= 4
        ? 'значення'
        : 'значень';
  return `${count} ${noun}`;
}

type OverflowTextProps = {
  displayValue: ReactNode;
  fullValue: string | null | undefined;
  interactive?: boolean;
  sx?: SxProps<Theme>;
  component?: ElementType;
  componentProps?: Record<string, unknown>;
};

function useResizeVersion(ref: RefObject<HTMLElement | null>, value: unknown) {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setVersion((current) => current + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, value]);

  return version;
}

export function MrtOverflowText({
  displayValue,
  fullValue,
  interactive = false,
  sx,
  component = 'span',
  componentProps,
}: OverflowTextProps) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const resizeVersion = useResizeVersion(textRef, displayValue);
  const meaningfulValue = fullValue?.trim() && fullValue !== '—' ? fullValue : null;

  useLayoutEffect(() => {
    const element = textRef.current;
    const nextValue = Boolean(element && element.scrollWidth > element.clientWidth);
    setIsOverflowing((current) => (current === nextValue ? current : nextValue));
  }, [displayValue, resizeVersion]);

  useEffect(() => {
    if (!isOverflowing) setIsTooltipOpen(false);
  }, [isOverflowing]);

  const content = (
    <Box
      component={component}
      ref={textRef}
      {...componentProps}
      tabIndex={isOverflowing && !interactive ? 0 : undefined}
      sx={{
        display: 'block',
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: 2,
        },
        ...sx,
      }}
    >
      {displayValue}
    </Box>
  );

  if (!meaningfulValue) return content;

  return (
    <Tooltip
      title={meaningfulValue}
      open={isOverflowing && isTooltipOpen}
      onOpen={() => setIsTooltipOpen(true)}
      onClose={() => setIsTooltipOpen(false)}
      disableHoverListener={!isOverflowing}
      disableFocusListener={!isOverflowing}
      describeChild
    >
      {content}
    </Tooltip>
  );
}

type OverflowItemsProps<T> = {
  items: readonly T[];
  renderItem: (item: T, index: number) => ReactNode;
  renderDisclosureItem?: (item: T, index: number) => ReactNode;
  renderCompactItem?: (item: T, index: number) => ReactNode;
  renderMeasurementItem?: (item: T, index: number) => ReactNode;
  getItemKey?: (item: T, index: number) => string | number;
  getItemText?: (item: T, index: number) => string;
  getItemMeasurementKey?: (item: T, index: number) => string | number;
  /** Shared column/renderer namespace for reusable measurement geometry. */
  measurementScope?: string;
  disclosureLayout?: 'wrap' | 'list';
  emptyValue?: ReactNode;
  containerProps?: Record<string, unknown>;
};

type ItemMeasurements = {
  signature: string;
  measuredItemCount: number;
  itemWidths: number[];
  triggerWidths: number[];
  itemGap: number;
  triggerGap: number;
  spacerWidth: number;
};

type CommittedLayout = {
  cacheKey: string;
  visibleCount: number;
};

const measurementCache = new Map<string, ItemMeasurements>();
const MAX_MEASURED_ITEMS = 16;
const MAX_ACTIVE_MEASUREMENT_JOBS = 8;
const MAX_MEASUREMENT_CACHE_ENTRIES = 512;
const OVERFLOW_TRIGGER_CLASS_NAME = 'mrt-overflow-trigger';

function readMeasurementCache(key: string) {
  const value = measurementCache.get(key);
  if (!value) return null;
  measurementCache.delete(key);
  measurementCache.set(key, value);
  return value;
}

function writeMeasurementCache(key: string, value: ItemMeasurements) {
  measurementCache.delete(key);
  measurementCache.set(key, value);
  if (measurementCache.size <= MAX_MEASUREMENT_CACHE_ENTRIES) return;
  const oldestKey = measurementCache.keys().next().value as string | undefined;
  if (oldestKey) measurementCache.delete(oldestKey);
}

export function resetMrtOverflowMeasurementCacheForTests() {
  measurementCache.clear();
  visibleMeasurementJobs.clear();
  deferredMeasurementJobs.clear();
  parkedMeasurementJobs.clear();
  activeMeasurementJobs.clear();
}

type MeasurementSubscriber = {
  start: () => void;
  resolve: () => void;
};

type MeasurementJob = {
  cacheKey: string;
  priority: 'visible' | 'deferred';
  ownerId: string | null;
  failedSubscriberIds: Set<string>;
  subscribers: Map<string, MeasurementSubscriber>;
};

const visibleMeasurementJobs = new Map<string, MeasurementJob>();
const deferredMeasurementJobs = new Map<string, MeasurementJob>();
const parkedMeasurementJobs = new Map<string, MeasurementJob>();
const activeMeasurementJobs = new Map<string, MeasurementJob>();
let cancelMeasurementDrain: (() => void) | null = null;
let isDrainingMeasurementJobs = false;
const visibilityCallbacks = new Map<HTMLElement, (visible: boolean) => void>();
let sharedIntersectionObserver: IntersectionObserver | null = null;

function getSharedIntersectionObserver() {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (!sharedIntersectionObserver) {
    sharedIntersectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) =>
          visibilityCallbacks.get(entry.target as HTMLElement)?.(entry.isIntersecting),
        );
      },
      { rootMargin: '240px 0px' },
    );
  }
  return sharedIntersectionObserver;
}

function observeMeasurementVisibility(element: HTMLElement, callback: (visible: boolean) => void) {
  const observer = getSharedIntersectionObserver();
  if (!observer) {
    callback(true);
    return () => undefined;
  }
  visibilityCallbacks.set(element, callback);
  observer.observe(element);
  return () => {
    visibilityCallbacks.delete(element);
    observer.unobserve(element);
    if (visibilityCallbacks.size === 0) {
      observer.disconnect();
      sharedIntersectionObserver = null;
    }
  };
}

function drainMeasurementJobs() {
  cancelMeasurementDrain = null;
  if (visibleMeasurementJobs.size === 0) return;
  isDrainingMeasurementJobs = true;
  try {
    const jobs = [...visibleMeasurementJobs.values()];
    for (const job of jobs) {
      if (activeMeasurementJobs.size >= MAX_ACTIVE_MEASUREMENT_JOBS) break;
      if (!visibleMeasurementJobs.delete(job.cacheKey)) continue;
      const owner = [...job.subscribers.keys()].find((id) => !job.failedSubscriberIds.has(id));
      if (!owner) {
        job.ownerId = null;
        parkedMeasurementJobs.set(job.cacheKey, job);
        continue;
      }
      job.ownerId = owner;
      activeMeasurementJobs.set(job.cacheKey, job);
      job.subscribers.get(owner)?.start();
    }
  } finally {
    isDrainingMeasurementJobs = false;
  }
}

function queueMeasurementJob(
  jobId: string,
  cacheKey: string,
  start: () => void,
  priority: MeasurementJob['priority'],
  resolve: () => void,
) {
  const activeJob = activeMeasurementJobs.get(cacheKey);
  if (activeJob) {
    activeJob.subscribers.set(jobId, { start, resolve });
    activeJob.failedSubscriberIds.delete(jobId);
    return;
  }

  const existing =
    visibleMeasurementJobs.get(cacheKey) ??
    deferredMeasurementJobs.get(cacheKey) ??
    parkedMeasurementJobs.get(cacheKey);
  if (existing) {
    existing.subscribers.set(jobId, { start, resolve });
    existing.failedSubscriberIds.delete(jobId);
    if (parkedMeasurementJobs.delete(cacheKey)) {
      existing.priority = priority;
      (priority === 'visible' ? visibleMeasurementJobs : deferredMeasurementJobs).set(
        cacheKey,
        existing,
      );
    }
    if (priority === 'visible' && existing.priority === 'deferred') {
      deferredMeasurementJobs.delete(cacheKey);
      existing.priority = 'visible';
      visibleMeasurementJobs.set(cacheKey, existing);
    }
    if (priority === 'visible' && activeMeasurementJobs.size < MAX_ACTIVE_MEASUREMENT_JOBS) {
      drainMeasurementJobs();
    }
    return;
  }

  const job = {
    cacheKey,
    priority,
    ownerId: null,
    failedSubscriberIds: new Set<string>(),
    subscribers: new Map([[jobId, { start, resolve }]]),
  };
  const queue = priority === 'visible' ? visibleMeasurementJobs : deferredMeasurementJobs;
  queue.set(cacheKey, job);
  if (priority === 'visible' && activeMeasurementJobs.size < MAX_ACTIVE_MEASUREMENT_JOBS) {
    drainMeasurementJobs();
  }
}

function completeMeasurementJob(ownerId: string, cacheKey: string) {
  const job = activeMeasurementJobs.get(cacheKey);
  if (!job || job.ownerId !== ownerId) return;
  activeMeasurementJobs.delete(cacheKey);
  job.ownerId = null;
  job.subscribers.forEach((subscriber) => subscriber.resolve());
  if (visibleMeasurementJobs.size > 0 && !isDrainingMeasurementJobs && !cancelMeasurementDrain) {
    cancelMeasurementDrain = scheduleFrame(drainMeasurementJobs);
  }
}

function failMeasurementOwner(ownerId: string, cacheKey: string) {
  const job = activeMeasurementJobs.get(cacheKey);
  if (!job || job.ownerId !== ownerId) return;
  activeMeasurementJobs.delete(cacheKey);
  job.ownerId = null;
  job.failedSubscriberIds.add(ownerId);
  if (job.subscribers.size === 0) return;
  job.priority = 'visible';
  if (![...job.subscribers.keys()].some((id) => !job.failedSubscriberIds.has(id))) {
    parkedMeasurementJobs.set(job.cacheKey, job);
    return;
  }
  visibleMeasurementJobs.set(job.cacheKey, job);
  if (!isDrainingMeasurementJobs && !cancelMeasurementDrain) {
    cancelMeasurementDrain = scheduleFrame(drainMeasurementJobs);
  }
}

function cancelMeasurementSubscriber(subscriberId: string, cacheKey: string) {
  const pendingJob =
    visibleMeasurementJobs.get(cacheKey) ??
    deferredMeasurementJobs.get(cacheKey) ??
    parkedMeasurementJobs.get(cacheKey);
  if (pendingJob && !pendingJob.subscribers.has(subscriberId)) return;
  pendingJob?.subscribers.delete(subscriberId);
  pendingJob?.failedSubscriberIds.delete(subscriberId);
  if (pendingJob && pendingJob.subscribers.size === 0) {
    visibleMeasurementJobs.delete(pendingJob.cacheKey);
    deferredMeasurementJobs.delete(pendingJob.cacheKey);
    parkedMeasurementJobs.delete(pendingJob.cacheKey);
  }
  const activeJob = activeMeasurementJobs.get(cacheKey);
  if (!activeJob || !activeJob.subscribers.has(subscriberId)) return;
  activeJob.subscribers.delete(subscriberId);
  activeJob.failedSubscriberIds.delete(subscriberId);
  if (activeJob.ownerId !== subscriberId) return;
  activeJob.ownerId = null;
  if (activeJob.subscribers.size > 0) {
    activeMeasurementJobs.delete(activeJob.cacheKey);
    activeJob.priority = 'visible';
    visibleMeasurementJobs.set(activeJob.cacheKey, activeJob);
    if (!isDrainingMeasurementJobs && !cancelMeasurementDrain) {
      cancelMeasurementDrain = scheduleFrame(drainMeasurementJobs);
    }
    return;
  }
  activeMeasurementJobs.delete(activeJob.cacheKey);
  if (visibleMeasurementJobs.size > 0 && !isDrainingMeasurementJobs && !cancelMeasurementDrain) {
    cancelMeasurementDrain = scheduleFrame(drainMeasurementJobs);
  }
}

function measurementSignaturePart(value: string | number): string {
  const text = String(value);
  return `${text.length}:${text}`;
}

function scheduleFrame(callback: () => void) {
  if (typeof requestAnimationFrame === 'function') {
    const frame = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(frame);
  }
  callback();
  return () => undefined;
}

function parseCssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function calculateVisibleItemCount({
  itemWidths,
  contentWidth,
  triggerWidths,
  itemGap,
  triggerGap,
  spacerWidth = 0,
}: {
  itemWidths: readonly number[];
  contentWidth: number;
  triggerWidths: readonly number[];
  itemGap: number;
  triggerGap: number;
  spacerWidth?: number;
}) {
  const itemWidthPrefixSums = itemWidths.reduce<number[]>(
    (prefixSums, width) => {
      prefixSums.push(prefixSums[prefixSums.length - 1] + width);
      return prefixSums;
    },
    [0],
  );
  for (let visibleCount = itemWidths.length; visibleCount >= 0; visibleCount -= 1) {
    const hiddenCount = itemWidths.length - visibleCount;
    const itemWidth = itemWidthPrefixSums[visibleCount];
    const itemGaps = Math.max(visibleCount - 1, 0) * itemGap;
    const triggerWidth = hiddenCount > 0 ? (triggerWidths[hiddenCount - 1] ?? 0) : 0;
    const overflowWidth =
      hiddenCount > 0 ? spacerWidth + triggerGap * (spacerWidth > 0 ? 2 : 1) + triggerWidth : 0;
    const totalWidth = itemWidth + itemGaps + overflowWidth;
    if (totalWidth <= contentWidth) return visibleCount;
  }
  return 0;
}

type OverflowDisclosureSurfaceProps<T> = {
  anchorEl: HTMLElement | null;
  surfaceId: string;
  hiddenCount: number;
  items: readonly T[];
  hiddenItems: readonly T[];
  representedCount: number;
  disclosureLayout: 'wrap' | 'list';
  renderItem: (item: T, index: number) => ReactNode;
  renderDisclosureItem?: (item: T, index: number) => ReactNode;
  getItemKey: (item: T, index: number) => string | number;
  getItemText: (item: T, index: number) => string;
  onClose: () => void;
  surfaceRef: RefObject<HTMLDivElement | null>;
};

function MrtOverflowDisclosureSurface<T>({
  anchorEl,
  surfaceId,
  hiddenCount,
  items,
  hiddenItems,
  representedCount,
  disclosureLayout,
  renderItem,
  renderDisclosureItem = renderItem,
  getItemKey,
  getItemText,
  onClose,
  surfaceRef,
}: OverflowDisclosureSurfaceProps<T>) {
  const inheritedTheme = useTheme<Theme>();
  const disclosureTheme = useMemo(
    () => ({
      ...inheritedTheme,
      zIndex: {
        ...inheritedTheme.zIndex,
        tooltip: inheritedTheme.zIndex.tooltip + 2,
      },
    }),
    [inheritedTheme],
  );
  const [copyStatus, setCopyStatus] = useState<'success' | 'failure' | null>(null);
  const copyAllItems = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    try {
      await copyTextToClipboard(items.map((item, index) => getItemText(item, index)).join('\n'));
      setCopyStatus('success');
    } catch {
      setCopyStatus('failure');
    }
  };

  return (
    <Popper
      open
      anchorEl={anchorEl}
      placement="bottom-start"
      sx={{ zIndex: (theme) => theme.zIndex.tooltip + 1 }}
      modifiers={[
        { name: 'flip', enabled: true },
        { name: 'preventOverflow', enabled: true, options: { padding: 8 } },
      ]}
    >
      <ClickAwayListener onClickAway={onClose}>
        <Paper
          id={surfaceId}
          ref={surfaceRef as RefObject<HTMLDivElement>}
          role="dialog"
          aria-label="Додаткові значення"
          tabIndex={-1}
          sx={{
            width: 'max-content',
            maxWidth: 'min(90vw, 640px)',
            maxHeight: 'min(60dvh, 32rem)',
            bgcolor: 'background.paper',
            color: 'text.primary',
            border: 1,
            borderColor: 'divider',
            boxShadow: 4,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <Box
            sx={{
              px: 1,
              py: 0.75,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 1,
              borderBottom: 1,
              borderColor: 'divider',
              flex: '0 0 auto',
            }}
          >
            <Typography variant="subtitle2">Додаткові значення ({hiddenCount})</Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography
                role="status"
                aria-live="polite"
                variant="caption"
                sx={{ minWidth: '11rem', textAlign: 'right' }}
              >
                {copyStatus === 'success'
                  ? 'Скопійовано'
                  : copyStatus === 'failure'
                    ? 'Не вдалося скопіювати'
                    : ''}
              </Typography>
              <Tooltip
                title="Скопіювати всі значення"
                placement="top-end"
                slotProps={{ popper: { sx: { zIndex: (theme) => theme.zIndex.tooltip + 2 } } }}
              >
                <PowerIconButton
                  size="small"
                  aria-label={`Скопіювати всі ${formatValueCount(items.length)}`}
                  onClick={copyAllItems}
                >
                  <ContentCopyOutlinedIcon fontSize="inherit" />
                </PowerIconButton>
              </Tooltip>
            </Box>
          </Box>
          <ThemeProvider theme={disclosureTheme}>
            <Box
              component={disclosureLayout === 'list' ? 'ul' : 'div'}
              data-mrt-overflow-disclosure-body=""
              sx={{
                m: 0,
                p: 1,
                minHeight: 0,
                minWidth: 0,
                overflowY: 'auto',
                overflowX: 'hidden',
                overscrollBehavior: 'contain',
                scrollbarGutter: 'stable',
                display: disclosureLayout === 'list' ? 'block' : 'flex',
                flexWrap: disclosureLayout === 'list' ? undefined : 'wrap',
                gap: disclosureLayout === 'list' ? 0 : 0.5,
                listStyle: 'none',
              }}
            >
              {hiddenItems.map((item, index) => (
                <Box
                  component={disclosureLayout === 'list' ? 'li' : 'div'}
                  key={getItemKey(item, representedCount + index)}
                  sx={
                    disclosureLayout === 'list'
                      ? {
                          width: '100%',
                          minWidth: 0,
                          overflowWrap: 'anywhere',
                          whiteSpace: 'normal',
                          py: 0.25,
                        }
                      : undefined
                  }
                >
                  {renderDisclosureItem(item, representedCount + index)}
                </Box>
              ))}
            </Box>
          </ThemeProvider>
        </Paper>
      </ClickAwayListener>
    </Popper>
  );
}

export function MrtOverflowItems<T>({
  items,
  renderItem,
  renderDisclosureItem,
  renderCompactItem,
  renderMeasurementItem = renderItem,
  getItemKey = (_, index) => index,
  getItemText = (_, index) => `Значення ${index + 1}`,
  getItemMeasurementKey,
  measurementScope,
  disclosureLayout = 'wrap',
  emptyValue = '—',
  containerProps,
}: OverflowItemsProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const triggerMeasureRefs = useRef<Array<HTMLElement | null>>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const compactItemRef = useRef<HTMLSpanElement>(null);
  const spacerMeasureRef = useRef<HTMLElement>(null);
  const previousTriggerRef = useRef<HTMLElement | null>(null);
  const restoreFocusTimeoutRef = useRef<number | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const surfaceId = `mrt-overflow-surface-${useId().replaceAll(':', '')}`;
  const measurementJobId = `mrt-overflow-measure-${surfaceId}`;
  const measurementsRef = useRef<ItemMeasurements | null>(null);
  const measuredWidthsRef = useRef<number[]>([]);
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [isVisible, setIsVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [hasMeasurableWidth, setHasMeasurableWidth] = useState(true);
  const [committedLayout, setCommittedLayout] = useState<CommittedLayout | null>(null);
  const [measurementBatch, setMeasurementBatch] = useState(() => ({
    start: 0,
    end: Math.min(items.length, MAX_MEASURED_ITEMS),
  }));
  const [isOpen, setIsOpen] = useState(false);
  const [isCompactHovered, setIsCompactHovered] = useState(false);
  const [isCompactFocused, setIsCompactFocused] = useState(false);
  const cancelPendingFocusRestore = () => {
    if (restoreFocusTimeoutRef.current == null) return;
    window.clearTimeout(restoreFocusTimeoutRef.current);
    restoreFocusTimeoutRef.current = null;
  };
  const closeSurface = (restoreFocus = false) => {
    setIsOpen(false);
    cancelPendingFocusRestore();
    if (restoreFocus) {
      restoreFocusTimeoutRef.current = window.setTimeout(() => {
        restoreFocusTimeoutRef.current = null;
        previousTriggerRef.current?.focus();
      }, 0);
    }
  };

  const measurementSignature = [
    measurementSignaturePart(items.length),
    ...items.flatMap((item, index) => [
      measurementSignaturePart(getItemKey(item, index)),
      measurementSignaturePart(getItemText(item, index)),
      measurementSignaturePart(getItemMeasurementKey?.(item, index) ?? ''),
    ]),
  ].join('|');
  const cacheKey = `${measurementScope ?? measurementJobId}|${measurementSignature}`;
  const isLayoutCommitted = committedLayout?.cacheKey === cacheKey;
  const currentVisibleCount = isLayoutCommitted ? committedLayout.visibleCount : 0;
  const compactFirstItem = isLayoutCommitted && currentVisibleCount === 0;
  const hasUnmeasurableFallback = !isLayoutCommitted && !hasMeasurableWidth && items.length > 1;
  const representedCount = compactFirstItem || hasUnmeasurableFallback ? 1 : currentVisibleCount;
  const hiddenCount =
    isLayoutCommitted || hasUnmeasurableFallback ? items.length - representedCount : 0;
  const hasOverflow = hiddenCount > 0;
  const hiddenItems = items.slice(representedCount);
  const cacheKeyRef = useRef(cacheKey);
  cacheKeyRef.current = cacheKey;
  const measuredItemCount = measurementBatch.end - measurementBatch.start;
  const triggerCounts = useMemo(
    () =>
      Array.from(
        new Set(
          [1, 9, 10, 99, 100, items.length - 1].filter(
            (count) => count > 0 && count < items.length,
          ),
        ),
      ).sort((left, right) => left - right),
    [items.length],
  );

  const getVisibleCount = useCallback((measurements: ItemMeasurements) => {
    const container = containerRef.current;
    if (!container || container.clientWidth <= 0) return null;
    return calculateVisibleItemCount({
      itemWidths: measurements.itemWidths,
      contentWidth: container.clientWidth,
      triggerWidths: measurements.triggerWidths,
      itemGap: measurements.itemGap,
      triggerGap: measurements.triggerGap,
      spacerWidth: measurements.spacerWidth,
    });
  }, []);

  const updateVisibleCount = useCallback(
    (measurements: ItemMeasurements) => {
      const nextCount = getVisibleCount(measurements);
      if (nextCount == null) return null;
      setCommittedLayout((current) =>
        current?.cacheKey === cacheKey && current.visibleCount === nextCount
          ? current
          : { cacheKey, visibleCount: nextCount },
      );
      return nextCount;
    },
    [cacheKey, getVisibleCount],
  );

  const startMeasurement = useCallback(() => {
    const cachedMeasurements = readMeasurementCache(cacheKey);
    if (cachedMeasurements?.signature === measurementSignature) {
      measurementsRef.current = cachedMeasurements;
      const cachedVisibleCount = getVisibleCount(cachedMeasurements);
      if (
        cachedMeasurements.measuredItemCount === items.length ||
        cachedVisibleCount == null ||
        cachedVisibleCount < cachedMeasurements.measuredItemCount
      ) {
        updateVisibleCount(cachedMeasurements);
        completeMeasurementJob(measurementJobId, cacheKey);
        return;
      }
      setMeasurementBatch({
        start: cachedMeasurements.measuredItemCount,
        end: Math.min(cachedMeasurements.measuredItemCount + MAX_MEASURED_ITEMS, items.length),
      });
    }
    setIsMeasuring(true);
  }, [
    cacheKey,
    getVisibleCount,
    items.length,
    measurementJobId,
    measurementSignature,
    updateVisibleCount,
  ]);

  const resolveMeasurement = useCallback(() => {
    const completedMeasurements = readMeasurementCache(cacheKey);
    const measurements =
      completedMeasurements?.signature === measurementSignature
        ? completedMeasurements
        : measurementsRef.current;
    if (measurements?.signature !== measurementSignature) return;
    measurementsRef.current = measurements;
    updateVisibleCount(measurements);
  }, [cacheKey, measurementSignature, updateVisibleCount]);

  const queueMeasurement = useCallback(() => {
    const container = containerRef.current;
    if (items.length === 0 || !container) return;
    if (container.clientWidth <= 0) setHasMeasurableWidth(false);
    if (container.clientWidth <= 0) return;
    if (!hasMeasurableWidth) setHasMeasurableWidth(true);
    const cachedMeasurements = measurementsRef.current ?? readMeasurementCache(cacheKey);
    if (cachedMeasurements?.signature === measurementSignature) {
      measurementsRef.current = cachedMeasurements;
      const cachedVisibleCount = getVisibleCount(cachedMeasurements);
      if (
        cachedMeasurements.measuredItemCount === items.length ||
        cachedVisibleCount == null ||
        cachedVisibleCount < cachedMeasurements.measuredItemCount
      ) {
        updateVisibleCount(cachedMeasurements);
        return;
      }
    }
    queueMeasurementJob(
      measurementJobId,
      cacheKey,
      startMeasurement,
      isVisible ? 'visible' : 'deferred',
      resolveMeasurement,
    );
  }, [
    cacheKey,
    getVisibleCount,
    hasMeasurableWidth,
    isVisible,
    items.length,
    measurementBatch.end,
    measurementBatch.start,
    measurementJobId,
    measurementSignature,
    resolveMeasurement,
    updateVisibleCount,
    startMeasurement,
  ]);
  const queueMeasurementRef = useRef(queueMeasurement);
  queueMeasurementRef.current = queueMeasurement;

  const measure = useCallback(() => {
    const container = containerRef.current;
    const measuredItems = measureRef.current?.children;
    if (items.length === 0 || !container || !measuredItems) {
      setIsMeasuring(false);
      failMeasurementOwner(measurementJobId, cacheKey);
      return;
    }
    const availableWidth = container.clientWidth;
    if (availableWidth <= 0) {
      setIsMeasuring(false);
      failMeasurementOwner(measurementJobId, cacheKey);
      return;
    }
    const measuredItemWidths = Array.from(measuredItems)
      .slice(0, measuredItemCount)
      .map((item) => item.getBoundingClientRect().width);
    measuredItemWidths.forEach((width, index) => {
      measuredWidthsRef.current[measurementBatch.start + index] = width;
    });
    const itemWidths = [
      ...Array.from(
        { length: items.length },
        (_, index) => measuredWidthsRef.current[index] ?? Number.MAX_SAFE_INTEGER,
      ),
    ];
    const itemGap = parseCssPixels(getComputedStyle(measureRef.current!).columnGap || '0');
    const triggerGap = parseCssPixels(getComputedStyle(container).columnGap || '0');
    const measuredTriggerWidths = new Map(
      triggerCounts.map((count, index) => [
        count,
        triggerMeasureRefs.current[index]?.getBoundingClientRect().width ?? 0,
      ]),
    );
    const triggerWidths = Array.from({ length: items.length }, (_, index) => {
      const hiddenCount = index + 1;
      const exact = measuredTriggerWidths.get(hiddenCount);
      if (exact != null) return exact;
      const sameDigits = [...triggerCounts]
        .reverse()
        .find((count) => String(count).length === String(hiddenCount).length);
      return (sameDigits == null ? 0 : measuredTriggerWidths.get(sameDigits)) ?? 0;
    });
    const spacerWidth = spacerMeasureRef.current?.getBoundingClientRect().width ?? 0;
    const nextMeasurements = {
      signature: measurementSignature,
      measuredItemCount: measurementBatch.end,
      itemWidths,
      triggerWidths,
      itemGap,
      triggerGap,
      spacerWidth,
    };
    const nextVisibleCount = calculateVisibleItemCount({
      itemWidths,
      contentWidth: availableWidth,
      triggerWidths,
      itemGap,
      triggerGap,
      spacerWidth,
    });
    if (nextVisibleCount >= measurementBatch.end && measurementBatch.end < items.length) {
      measurementsRef.current = nextMeasurements;
      writeMeasurementCache(cacheKey, nextMeasurements);
      setMeasurementBatch((current) => ({
        start: current.end,
        end: Math.min(current.end + MAX_MEASURED_ITEMS, items.length),
      }));
      return;
    } else {
      measurementsRef.current = nextMeasurements;
      writeMeasurementCache(cacheKey, nextMeasurements);
      setIsMeasuring(false);
      updateVisibleCount(nextMeasurements);
    }
    completeMeasurementJob(measurementJobId, cacheKey);
  }, [
    cacheKey,
    items.length,
    measuredItemCount,
    measurementBatch.end,
    measurementBatch.start,
    measurementJobId,
    measurementSignature,
    triggerCounts,
    updateVisibleCount,
  ]);

  useLayoutEffect(() => {
    if (items.length === 0) {
      measurementsRef.current = null;
      cancelMeasurementSubscriber(measurementJobId, cacheKey);
      setIsMeasuring(false);
      setCommittedLayout(null);
      measuredWidthsRef.current = [];
      setMeasurementBatch({ start: 0, end: 0 });
      closeSurface();
    }
  }, [items.length, measurementJobId]);

  useLayoutEffect(() => {
    const cachedMeasurements = readMeasurementCache(cacheKey);
    if ((containerRef.current?.clientWidth ?? 0) <= 0) setHasMeasurableWidth(false);
    measurementsRef.current = cachedMeasurements ?? null;
    measuredWidthsRef.current =
      cachedMeasurements?.itemWidths.slice(0, cachedMeasurements.measuredItemCount) ?? [];
    setIsMeasuring(false);
    setCommittedLayout(null);
    const measuredItemCount = cachedMeasurements?.measuredItemCount ?? 0;
    setMeasurementBatch({
      start: measuredItemCount,
      end: Math.min(measuredItemCount + MAX_MEASURED_ITEMS, items.length),
    });
    if (cachedMeasurements?.signature !== measurementSignature) return;
    const cachedVisibleCount = getVisibleCount(cachedMeasurements);
    if (
      cachedMeasurements.measuredItemCount === items.length ||
      cachedVisibleCount == null ||
      cachedVisibleCount < cachedMeasurements.measuredItemCount
    ) {
      updateVisibleCount(cachedMeasurements);
    }
  }, [cacheKey, getVisibleCount, items.length, measurementSignature, updateVisibleCount]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || items.length === 0) return;
    return observeMeasurementVisibility(element, (visible) => {
      setIsVisible(visible);
      if (visible && element.clientWidth > 0) {
        queueMeasurementRef.current();
      }
    });
  }, [items.length]);

  useLayoutEffect(() => {
    queueMeasurement();
  }, [queueMeasurement]);

  useLayoutEffect(() => {
    if (!isMeasuring) return;
    return scheduleFrame(measure);
  }, [isMeasuring, measure]);

  useEffect(
    () => () => {
      cancelMeasurementSubscriber(measurementJobId, cacheKey);
      cancelPendingFocusRestore();
    },
    [cacheKey, measurementJobId],
  );

  useEffect(() => {
    const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
    if (!fonts) return;
    let mounted = true;
    fonts.ready.then(() => {
      if (!mounted) return;
      measurementsRef.current = null;
      measurementCache.delete(cacheKeyRef.current);
      queueMeasurementRef.current();
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let cancelFrame: () => void = () => undefined;
    const observer = new ResizeObserver(() => {
      cancelFrame();
      cancelFrame = scheduleFrame(queueMeasurement);
    });
    observer.observe(element);
    return () => {
      cancelFrame();
      observer.disconnect();
    };
  }, [queueMeasurement]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeSurface(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (!hasOverflow) {
      closeSurface();
      return;
    }

    return scheduleFrame(() => surfaceRef.current?.focus());
  }, [hasOverflow, isOpen]);

  if (items.length === 0) return <span>{emptyValue}</span>;

  const openSurface = () => {
    cancelPendingFocusRestore();
    previousTriggerRef.current = triggerRef.current;
    setIsOpen(true);
  };

  const measurement = isMeasuring ? (
    <div
      ref={measureRef}
      data-mrt-overflow-measure={surfaceId}
      aria-hidden
      {...({ inert: '' } as any)}
      style={{
        position: 'absolute',
        width: 'max-content',
        visibility: 'hidden',
        pointerEvents: 'none',
        display: 'flex',
        gap: '4px',
        whiteSpace: 'nowrap',
      }}
    >
      {items.slice(measurementBatch.start, measurementBatch.end).map((item, index) => (
        <span
          key={getItemKey(item, measurementBatch.start + index)}
          data-mrt-overflow-measured-item=""
          style={{ display: 'inline-flex', flexShrink: 0 }}
        >
          {renderMeasurementItem(item, measurementBatch.start + index)}
        </span>
      ))}
      {triggerCounts.map((count, index) => (
        <button
          key={`trigger-${count}`}
          type="button"
          ref={(element) => {
            triggerMeasureRefs.current[index] = element as HTMLElement | null;
          }}
          aria-hidden
          data-mrt-overflow-trigger-measure=""
          {...({ inert: '' } as any)}
          className={OVERFLOW_TRIGGER_CLASS_NAME}
        >
          Ще {count}
        </button>
      ))}
      <span
        ref={spacerMeasureRef}
        data-mrt-overflow-spacer-measure=""
        aria-hidden
        {...({ inert: '' } as any)}
        style={{ width: '2rem', height: 1 }}
      />
    </div>
  ) : null;

  const compactItemText = getItemText(items[0], 0);
  const isCompactTooltipOpen =
    compactFirstItem && !renderCompactItem && (isCompactHovered || isCompactFocused);
  const renderCompactFirstItem = () =>
    renderCompactItem ? renderCompactItem(items[0], 0) : renderItem(items[0], 0);
  const visibleItems = items.slice(0, currentVisibleCount).map((item, index) => (
    <span key={getItemKey(item, index)} className="min-w-0 shrink-0">
      {renderItem(item, index)}
    </span>
  ));

  return (
    <>
      <div
        ref={containerRef}
        data-mrt-overflow-items={surfaceId}
        {...containerProps}
        className="relative flex w-full max-w-full min-w-0 flex-1 items-center gap-1 overflow-hidden"
      >
        <div
          data-mrt-overflow-visible=""
          className="flex min-w-0 max-w-full flex-1 items-center gap-1 overflow-hidden"
          aria-hidden={isLayoutCommitted ? undefined : true}
          {...(isLayoutCommitted ? {} : ({ inert: '' } as any))}
          style={{ visibility: isLayoutCommitted ? 'visible' : 'hidden' }}
        >
          {compactFirstItem || !isLayoutCommitted ? (
            <span
              ref={compactItemRef}
              className="min-w-0 max-w-full flex-1 overflow-hidden"
              title={renderCompactItem || isCompactTooltipOpen ? undefined : compactItemText}
              aria-label={renderCompactItem ? undefined : compactItemText}
              tabIndex={renderCompactItem ? undefined : 0}
              onMouseEnter={renderCompactItem ? undefined : () => setIsCompactHovered(true)}
              onMouseLeave={renderCompactItem ? undefined : () => setIsCompactHovered(false)}
              onFocusCapture={renderCompactItem ? undefined : () => setIsCompactFocused(true)}
              onBlurCapture={renderCompactItem ? undefined : () => setIsCompactFocused(false)}
            >
              {renderCompactFirstItem()}
            </span>
          ) : (
            visibleItems
          )}
          {hasUnmeasurableFallback ? (
            <button
              ref={triggerRef}
              type="button"
              onClick={() => (isOpen ? closeSurface() : openSurface())}
              aria-label={`Показати ще ${formatValueCount(hiddenCount)}`}
              aria-expanded={isOpen}
              aria-controls={isOpen ? surfaceId : undefined}
              title={`Показати ще ${formatValueCount(hiddenCount)}`}
              className={OVERFLOW_TRIGGER_CLASS_NAME}
            >
              Ще {hiddenCount}
            </button>
          ) : null}
        </div>
        {isLayoutCommitted && hasOverflow && !compactFirstItem ? (
          <span
            aria-hidden
            data-mrt-overflow-fade=""
            {...({ inert: '' } as any)}
            className="pointer-events-none h-full w-8 flex-none"
            style={{
              background: 'linear-gradient(to right, transparent, var(--color-background))',
            }}
          />
        ) : null}
        {isLayoutCommitted && hasOverflow ? (
          <button
            ref={triggerRef}
            type="button"
            onClick={() => (isOpen ? closeSurface() : openSurface())}
            aria-label={`Показати ще ${formatValueCount(hiddenCount)}`}
            aria-expanded={isOpen}
            aria-controls={isOpen ? surfaceId : undefined}
            title={`Показати ще ${formatValueCount(hiddenCount)}`}
            className={OVERFLOW_TRIGGER_CLASS_NAME}
          >
            Ще {hiddenCount}
          </button>
        ) : null}
        {isOpen && hasOverflow ? (
          <MrtOverflowDisclosureSurface
            anchorEl={triggerRef.current}
            surfaceId={surfaceId}
            hiddenCount={hiddenCount}
            items={items}
            hiddenItems={hiddenItems}
            representedCount={representedCount}
            disclosureLayout={disclosureLayout}
            renderItem={renderItem}
            renderDisclosureItem={renderDisclosureItem}
            getItemKey={getItemKey}
            getItemText={getItemText}
            onClose={() => closeSurface()}
            surfaceRef={surfaceRef}
          />
        ) : null}
        {isCompactTooltipOpen ? (
          <Popper
            open
            anchorEl={compactItemRef.current}
            placement="top-start"
            role="presentation"
            sx={{ zIndex: (theme) => theme.zIndex.tooltip + 2, pointerEvents: 'none' }}
            modifiers={[
              { name: 'flip', enabled: true },
              { name: 'preventOverflow', enabled: true, options: { padding: 8 } },
            ]}
          >
            <Paper
              role="tooltip"
              sx={{
                px: 1,
                py: 0.5,
                maxWidth: 'min(90vw, 40rem)',
                bgcolor: 'grey.700',
                color: 'common.white',
                borderRadius: 1,
                boxShadow: 3,
                pointerEvents: 'none',
              }}
            >
              <Typography variant="caption" sx={{ color: 'inherit', overflowWrap: 'anywhere' }}>
                {compactItemText}
              </Typography>
            </Paper>
          </Popper>
        ) : null}
        <div
          data-mrt-overflow-measurement-host=""
          aria-hidden
          {...({ inert: '' } as any)}
          style={{
            position: 'absolute',
            inset: '0 auto auto 0',
            width: 0,
            height: 0,
            overflow: 'hidden',
            visibility: 'hidden',
            pointerEvents: 'none',
            contain: 'layout style paint',
          }}
        >
          {measurement}
        </div>
      </div>
    </>
  );
}
