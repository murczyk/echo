import { Box, Button, ClickAwayListener, Popper, Tooltip } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import type { ElementType, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

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

type MeasurementJob = { start: () => void; priority: 'visible' | 'deferred' };

const visibleMeasurementJobs = new Map<string, MeasurementJob>();
const deferredMeasurementJobs = new Map<string, MeasurementJob>();
let activeMeasurementJob: string | null = null;
let cancelMeasurementDrain: (() => void) | null = null;
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
  if (activeMeasurementJob || visibleMeasurementJobs.size === 0) return;
  const [jobId, job] = visibleMeasurementJobs.entries().next().value as [string, MeasurementJob];
  visibleMeasurementJobs.delete(jobId);
  activeMeasurementJob = jobId;
  job.start();
}

function queueMeasurementJob(
  jobId: string,
  start: () => void,
  priority: MeasurementJob['priority'],
) {
  if (activeMeasurementJob === jobId) return;
  deferredMeasurementJobs.delete(jobId);
  visibleMeasurementJobs.delete(jobId);
  const queue = priority === 'visible' ? visibleMeasurementJobs : deferredMeasurementJobs;
  queue.set(jobId, { start, priority });
  if (priority === 'visible' && !activeMeasurementJob) {
    drainMeasurementJobs();
  }
}

function releaseMeasurementJob(jobId: string) {
  if (activeMeasurementJob !== jobId) return;
  activeMeasurementJob = null;
  if (visibleMeasurementJobs.size > 0 && !cancelMeasurementDrain) {
    cancelMeasurementDrain = scheduleFrame(drainMeasurementJobs);
  }
}

function cancelMeasurementJob(jobId: string) {
  visibleMeasurementJobs.delete(jobId);
  deferredMeasurementJobs.delete(jobId);
  if (activeMeasurementJob !== jobId) return;
  activeMeasurementJob = null;
  if (visibleMeasurementJobs.size > 0 && !cancelMeasurementDrain) {
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
  for (let visibleCount = itemWidths.length; visibleCount >= 0; visibleCount -= 1) {
    const hiddenCount = itemWidths.length - visibleCount;
    const itemWidth = itemWidths.slice(0, visibleCount).reduce((sum, width) => sum + width, 0);
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
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [isVisible, setIsVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [visibleCount, setVisibleCount] = useState(items.length);
  const [isOpen, setIsOpen] = useState(false);
  const compactFirstItem = visibleCount === 0;
  const representedCount = compactFirstItem ? 1 : visibleCount;
  const hiddenCount = items.length - representedCount;
  const hasOverflow = hiddenCount > 0;
  const hiddenItems = items.slice(representedCount);
  const hiddenItemText = hiddenItems
    .map((item, index) => getItemText(item, representedCount + index))
    .join(', ');
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
    setVisibleCount((current) => (current === nextCount ? current : nextCount));
  }, []);

  const queueMeasurement = useCallback(() => {
    const container = containerRef.current;
    if (items.length === 0 || !container || container.clientWidth <= 0) return;
    const cachedMeasurements = measurementsRef.current;
    if (cachedMeasurements?.signature === measurementSignature) {
      updateVisibleCount(cachedMeasurements);
      return;
    }
    queueMeasurementJob(
      measurementJobId,
      () => setIsMeasuring(true),
      isVisible ? 'visible' : 'deferred',
    );
  }, [isVisible, items.length, measurementJobId, measurementSignature, updateVisibleCount]);
  const queueMeasurementRef = useRef(queueMeasurement);
  queueMeasurementRef.current = queueMeasurement;

  const measure = useCallback(() => {
    const container = containerRef.current;
    const measuredItems = measureRef.current?.children;
    if (items.length === 0 || !container || !measuredItems) {
      setIsMeasuring(false);
      releaseMeasurementJob(measurementJobId);
      return;
    }
    const availableWidth = container.clientWidth;
    if (availableWidth <= 0) {
      setIsMeasuring(false);
      releaseMeasurementJob(measurementJobId);
      return;
    }
    const itemWidths = Array.from(measuredItems)
      .slice(0, items.length)
      .map((item) => item.getBoundingClientRect().width);
    const itemGap = parseCssPixels(getComputedStyle(measureRef.current!).columnGap || '0');
    const triggerGap = parseCssPixels(getComputedStyle(container).columnGap || '0');
    const triggerWidths = triggerMeasureRefs.current.map(
      (trigger) => trigger?.getBoundingClientRect().width ?? 0,
    );
    const spacerWidth = spacerMeasureRef.current?.getBoundingClientRect().width ?? 0;
    const nextMeasurements = {
      signature: measurementSignature,
      itemWidths,
      triggerWidths,
      itemGap,
      triggerGap,
      spacerWidth,
    };
    measurementsRef.current = nextMeasurements;
    updateVisibleCount(nextMeasurements);
    setIsMeasuring(false);
    releaseMeasurementJob(measurementJobId);
  }, [items.length, measurementJobId, measurementSignature, updateVisibleCount]);

  useLayoutEffect(() => {
    if (items.length === 0) {
      measurementsRef.current = null;
      cancelMeasurementJob(measurementJobId);
      setIsMeasuring(false);
      setVisibleCount(0);
      closeSurface();
    }
  }, [items.length, measurementJobId]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || items.length === 0) return;
    return observeMeasurementVisibility(element, setIsVisible);
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
      cancelMeasurementJob(measurementJobId);
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

  if (items.length === 0) return <Box component="span">{emptyValue}</Box>;

  const openSurface = () => {
    cancelPendingFocusRestore();
    previousTriggerRef.current = triggerRef.current;
    setIsOpen(true);
  };

  const measurement =
    isMeasuring && typeof document !== 'undefined'
      ? createPortal(
          <Box
            ref={measureRef}
            data-mrt-overflow-measure={surfaceId}
            aria-hidden
            {...({ inert: '' } as any)}
            sx={{
              position: 'absolute',
              visibility: 'hidden',
              pointerEvents: 'none',
              display: 'flex',
              gap: 0.5,
            }}
          >
            {items.map((item, index) => (
              <Box
                key={getItemKey(item, index)}
                data-mrt-overflow-measured-item=""
                sx={{ display: 'inline-flex', flexShrink: 0 }}
              >
                {renderMeasurementItem(item, index)}
              </Box>
            ))}
            {items.map((_, index) => (
              <Button
                key={`trigger-${index + 1}`}
                component="span"
                ref={(element) => {
                  triggerMeasureRefs.current[index] = element as HTMLElement | null;
                }}
                aria-hidden
                data-mrt-overflow-trigger-measure=""
                {...({ inert: '' } as any)}
                tabIndex={-1}
                sx={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none' }}
              >
                Ще {index + 1}
              </Button>
            ))}
            <Box
              ref={spacerMeasureRef}
              data-mrt-overflow-spacer-measure=""
              aria-hidden
              {...({ inert: '' } as any)}
              sx={{ width: '2rem', height: 1 }}
            />
          </Box>,
          document.body,
        )
      : null;

  return (
    <>
      <Box
        ref={containerRef}
        data-mrt-overflow-items={surfaceId}
        {...containerProps}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          minWidth: 0,
          width: '100%',
          maxWidth: '100%',
          flex: '1 1 auto',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <Box
          data-mrt-overflow-visible=""
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            minWidth: 0,
            overflow: 'hidden',
            flex: '1 1 auto',
            maxWidth: '100%',
          }}
        >
          {compactFirstItem ? (
            <Box sx={{ minWidth: 0, maxWidth: '100%', overflow: 'hidden', flex: '1 1 auto' }}>
              {renderCompactItem ? (
                renderCompactItem(items[0], 0)
              ) : (
                <MrtOverflowText
                  displayValue={getItemText(items[0], 0)}
                  fullValue={getItemText(items[0], 0)}
                />
              )}
            </Box>
          ) : (
            items.slice(0, visibleCount).map((item, index) => (
              <Box key={getItemKey(item, index)} sx={{ flexShrink: 0, minWidth: 0 }}>
                {renderItem(item, index)}
              </Box>
            ))
          )}
        </Box>
        {hasOverflow && !compactFirstItem ? (
          <Box
            aria-hidden
            data-mrt-overflow-fade=""
            {...({ inert: '' } as any)}
            sx={{
              width: '2rem',
              flex: '0 0 2rem',
              height: '100%',
              pointerEvents: 'none',
              background: (theme) =>
                `linear-gradient(to right, transparent, ${theme.palette.background.paper})`,
            }}
          />
        ) : null}
        {hasOverflow ? (
          <Tooltip title={hiddenItemText || `Показати ще ${hiddenCount} значення`} describeChild>
            <Button
              ref={triggerRef}
              size="small"
              variant="text"
              onClick={() => (isOpen ? closeSurface() : openSurface())}
              aria-label={`Показати ще ${hiddenCount} значення`}
              aria-expanded={isOpen}
              aria-controls={isOpen ? surfaceId : undefined}
              sx={{ minWidth: 'fit-content', flexShrink: 0, whiteSpace: 'nowrap', px: 0.5 }}
            >
              Ще {hiddenCount}
            </Button>
          </Tooltip>
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
      </Box>
      {measurement}
    </>
  );
}
