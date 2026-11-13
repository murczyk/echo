import { useLayoutEffect, useRef, useState } from 'react';

export function useDeviceFileBreadcrumbCollapse(path: string, maxHidden: number) {
  const viewportRef = useRef<HTMLElement>(null);
  const measurementRef = useRef<HTMLOListElement>(null);
  const [hiddenCount, setHiddenCount] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const measurement = measurementRef.current;
    if (!viewport || !measurement) return;
    const update = () => {
      const availableWidth = viewport.getBoundingClientRect().width;
      if (availableWidth === 0) return;
      const [rootWidth, menuWidth, ...segments] = Array.from(
        measurement.children,
        (element) => element.getBoundingClientRect().width,
      );
      let width = rootWidth + segments.reduce((total, segment) => total + segment, 0);
      let hidden = 0;
      while (width > availableWidth && hidden < maxHidden) {
        if (hidden === 0) width += menuWidth;
        width -= segments[hidden];
        hidden += 1;
      }
      setHiddenCount(hidden);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(measurement);
    return () => observer.disconnect();
  }, [path, maxHidden]);

  return { viewportRef, measurementRef, hiddenCount: Math.min(hiddenCount, maxHidden) };
}
