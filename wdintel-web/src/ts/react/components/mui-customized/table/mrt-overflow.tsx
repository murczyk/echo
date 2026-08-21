import { Box, ClickAwayListener, Popper, Tooltip } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import type { ElementType, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

export type MrtOverflowMode = 'text' | 'items' | 'wrap' | 'custom' | 'none';

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
  renderCompactItem?: (item: T, index: number) => ReactNode;
  renderMeasurementItem?: (item: T, index: number) => ReactNode;
  getItemKey?: (item: T, index: number) => string | number;
  getItemText?: (item: T, index: number) => string;
  getItemMeasurementKey?: (item: T, index: number) => string | number;
  /** Shared column/renderer namespace for reusable measurement geometry. */
  measurementScope?: string;
  emptyValue?: ReactNode;
  containerProps?: Record<string, unknown>;
};

type ItemMeasurements = {
  signature: string;
  itemWidths: number[];
  triggerWidths: number[];
  itemGap: number;
  triggerGap: number;
  spacerWidth: number;
};

const measurementCache = new Map<string, ItemMeasurements>();
const MAX_MEASURED_ITEMS = 16;
const MAX_ACTIVE_MEASUREMENT_JOBS = 8;
const MAX_MEASUREMENT_CACHE_ENTRIES = 512;
const OVERFLOW_TRIGGER_CLASS_NAME =
  'shrink-0 border-0 bg-transparent px-1 font-inherit text-sm leading-normal whitespace-nowrap tabular-nums text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary';

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

function completeMeasurementJob(ownerId: string) {
  const job = [...activeMeasurementJobs.values()].find(
    (candidate) => candidate.ownerId === ownerId,
  );
  if (!job) return;
  activeMeasurementJobs.delete(job.cacheKey);
  job.ownerId = null;
  job.subscribers.forEach((subscriber) => subscriber.resolve());
  if (visibleMeasurementJobs.size > 0 && !isDrainingMeasurementJobs && !cancelMeasurementDrain) {
    cancelMeasurementDrain = scheduleFrame(drainMeasurementJobs);
  }
}

function failMeasurementOwner(ownerId: string) {
  const job = [...activeMeasurementJobs.values()].find(
    (candidate) => candidate.ownerId === ownerId,
  );
  if (!job) return;
  activeMeasurementJobs.delete(job.cacheKey);
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

function cancelMeasurementSubscriber(subscriberId: string) {
  const pendingJob = [
    ...visibleMeasurementJobs.values(),
    ...deferredMeasurementJobs.values(),
    ...parkedMeasurementJobs.values(),
  ].find((job) => job.subscribers.has(subscriberId));
  pendingJob?.subscribers.delete(subscriberId);
  pendingJob?.failedSubscriberIds.delete(subscriberId);
  if (pendingJob && pendingJob.subscribers.size === 0) {
    visibleMeasurementJobs.delete(pendingJob.cacheKey);
    deferredMeasurementJobs.delete(pendingJob.cacheKey);
    parkedMeasurementJobs.delete(pendingJob.cacheKey);
  }
  const activeJob = [...activeMeasurementJobs.values()].find((candidate) =>
    candidate.subscribers.has(subscriberId),
  );
  if (!activeJob) return;
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

export function MrtOverflowItems<T>({
  items,
  renderItem,
  renderCompactItem,
  renderMeasurementItem = renderItem,
  getItemKey = (_, index) => index,
  getItemText = (_, index) => `Значення ${index + 1}`,
  getItemMeasurementKey,
  measurementScope,
  emptyValue = '—',
  containerProps,
}: OverflowItemsProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const triggerMeasureRefs = useRef<Array<HTMLElement | null>>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
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
  const [visibleCount, setVisibleCount] = useState(() => (items.length > 0 ? 1 : 0));
  const [measurementBatch, setMeasurementBatch] = useState(() => ({
    start: 0,
    end: Math.min(items.length, MAX_MEASURED_ITEMS),
  }));
  const [isOpen, setIsOpen] = useState(false);
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
  const layoutSignatureRef = useRef(measurementSignature);
  const currentVisibleCount =
    layoutSignatureRef.current === measurementSignature ? visibleCount : Math.min(items.length, 1);
  const compactFirstItem = currentVisibleCount === 0;
  const representedCount = compactFirstItem ? 1 : currentVisibleCount;
  const hiddenCount = items.length - representedCount;
  const hasOverflow = hiddenCount > 0;
  const hiddenItems = items.slice(representedCount);
  const hiddenItemText = hiddenItems
    .map((item, index) => getItemText(item, representedCount + index))
    .join(', ');
  const cacheKey = `${measurementScope ?? measurementJobId}|${measurementSignature}`;
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

  const updateVisibleCount = useCallback((measurements: ItemMeasurements) => {
    const container = containerRef.current;
    if (!container || container.clientWidth <= 0) return;
    const nextCount = calculateVisibleItemCount({
      itemWidths: measurements.itemWidths,
      contentWidth: container.clientWidth,
      triggerWidths: measurements.triggerWidths,
      itemGap: measurements.itemGap,
      triggerGap: measurements.triggerGap,
      spacerWidth: measurements.spacerWidth,
    });
    layoutSignatureRef.current = measurements.signature;
    setVisibleCount((current) => (current === nextCount ? current : nextCount));
  }, []);

  const startMeasurement = useCallback(() => {
    const cachedMeasurements = readMeasurementCache(cacheKey);
    if (cachedMeasurements?.signature === measurementSignature) {
      measurementsRef.current = cachedMeasurements;
      updateVisibleCount(cachedMeasurements);
      completeMeasurementJob(measurementJobId);
      return;
    }
    setIsMeasuring(true);
  }, [cacheKey, measurementJobId, measurementSignature, updateVisibleCount]);

  const resolveMeasurement = useCallback(() => {
    const cachedMeasurements = measurementsRef.current ?? readMeasurementCache(cacheKey);
    if (cachedMeasurements?.signature !== measurementSignature) return;
    measurementsRef.current = cachedMeasurements;
    updateVisibleCount(cachedMeasurements);
  }, [cacheKey, measurementSignature, updateVisibleCount]);

  const queueMeasurement = useCallback(() => {
    const container = containerRef.current;
    if (items.length === 0 || !container || container.clientWidth <= 0) return;
    const cachedMeasurements = measurementsRef.current ?? readMeasurementCache(cacheKey);
    if (cachedMeasurements?.signature === measurementSignature) {
      measurementsRef.current = cachedMeasurements;
      updateVisibleCount(cachedMeasurements);
      return;
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
      failMeasurementOwner(measurementJobId);
      return;
    }
    const availableWidth = container.clientWidth;
    if (availableWidth <= 0) {
      setIsMeasuring(false);
      failMeasurementOwner(measurementJobId);
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
    if (nextVisibleCount === measurementBatch.end && measurementBatch.end < items.length) {
      layoutSignatureRef.current = measurementSignature;
      setVisibleCount(nextVisibleCount);
      setMeasurementBatch((current) => ({
        start: current.end,
        end: Math.min(current.end + MAX_MEASURED_ITEMS, items.length),
      }));
      return;
    } else {
      measurementsRef.current = nextMeasurements;
      writeMeasurementCache(cacheKey, nextMeasurements);
      updateVisibleCount(nextMeasurements);
    }
    setIsMeasuring(false);
    completeMeasurementJob(measurementJobId);
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
      cancelMeasurementSubscriber(measurementJobId);
      setIsMeasuring(false);
      layoutSignatureRef.current = measurementSignature;
      setVisibleCount(0);
      measuredWidthsRef.current = [];
      setMeasurementBatch({ start: 0, end: 0 });
      closeSurface();
    }
  }, [items.length, measurementJobId]);

  useLayoutEffect(() => {
    const cachedMeasurements = readMeasurementCache(cacheKey);
    measurementsRef.current = cachedMeasurements ?? null;
    measuredWidthsRef.current =
      cachedMeasurements?.itemWidths.filter((width) => width !== Number.MAX_SAFE_INTEGER) ?? [];
    layoutSignatureRef.current = measurementSignature;
    setVisibleCount(items.length === 0 ? 0 : 1);
    setMeasurementBatch({ start: 0, end: Math.min(items.length, MAX_MEASURED_ITEMS) });
  }, [cacheKey, items.length]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || items.length === 0) return;
    return observeMeasurementVisibility(element, (visible) => {
      setIsVisible(visible);
      if (visible && element.clientWidth > 0) {
        const cachedMeasurements = measurementsRef.current ?? readMeasurementCache(cacheKey);
        if (cachedMeasurements?.signature === measurementSignature) {
          measurementsRef.current = cachedMeasurements;
          updateVisibleCount(cachedMeasurements);
          return;
        }
        queueMeasurementJob(
          measurementJobId,
          cacheKey,
          startMeasurement,
          'visible',
          resolveMeasurement,
        );
      }
    });
  }, [
    cacheKey,
    items.length,
    measurementJobId,
    measurementSignature,
    resolveMeasurement,
    startMeasurement,
    updateVisibleCount,
  ]);

  useLayoutEffect(() => {
    queueMeasurement();
  }, [queueMeasurement]);

  useLayoutEffect(() => {
    if (!isMeasuring) return;
    return scheduleFrame(measure);
  }, [isMeasuring, measure]);

  useEffect(
    () => () => {
      cancelMeasurementSubscriber(measurementJobId);
      cancelPendingFocusRestore();
    },
    [measurementJobId],
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

  const measurement =
    isMeasuring && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={measureRef}
            data-mrt-overflow-measure={surfaceId}
            aria-hidden
            {...({ inert: '' } as any)}
            style={{
              position: 'absolute',
              visibility: 'hidden',
              pointerEvents: 'none',
              display: 'flex',
              gap: '4px',
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
                style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none' }}
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
          </div>,
          document.body,
        )
      : null;

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
        >
          {compactFirstItem ? (
            <span className="min-w-0 max-w-full flex-1 overflow-hidden">
              {(renderCompactItem ?? renderItem)(items[0], 0)}
            </span>
          ) : (
            items.slice(0, currentVisibleCount).map((item, index) => (
              <span key={getItemKey(item, index)} className="min-w-0 shrink-0">
                {renderItem(item, index)}
              </span>
            ))
          )}
        </div>
        {hasOverflow && !compactFirstItem ? (
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
        {hasOverflow ? (
          <button
            ref={triggerRef}
            type="button"
            onClick={() => (isOpen ? closeSurface() : openSurface())}
            aria-label={`Показати ще ${hiddenCount} значення`}
            aria-expanded={isOpen}
            aria-controls={isOpen ? surfaceId : undefined}
            title={hiddenItemText || `Показати ще ${hiddenCount} значення`}
            className={OVERFLOW_TRIGGER_CLASS_NAME}
          >
            Ще {hiddenCount}
          </button>
        ) : null}
        {isOpen && hasOverflow ? (
          <Popper
            open={isOpen}
            anchorEl={triggerRef.current}
            placement="bottom-start"
            sx={{ zIndex: (theme) => theme.zIndex.tooltip + 1 }}
          >
            <ClickAwayListener onClickAway={() => closeSurface()}>
              <Box
                id={surfaceId}
                ref={surfaceRef}
                role="dialog"
                aria-label="Додаткові значення"
                tabIndex={-1}
                sx={{
                  p: 1,
                  mt: 0.5,
                  maxWidth: 'min(90vw, 640px)',
                  bgcolor: 'background.paper',
                  color: 'text.primary',
                  border: 1,
                  borderColor: 'divider',
                  boxShadow: 4,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 0.5,
                  whiteSpace: 'normal',
                  overflowWrap: 'anywhere',
                }}
              >
                {hiddenItems.map((item, index) => (
                  <Box key={getItemKey(item, representedCount + index)}>
                    {renderItem(item, representedCount + index)}
                  </Box>
                ))}
              </Box>
            </ClickAwayListener>
          </Popper>
        ) : null}
      </div>
      {measurement}
    </>
  );
}
