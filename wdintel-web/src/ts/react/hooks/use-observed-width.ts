import { useLayoutEffect, useState, type RefCallback } from 'react';

export function useObservedWidth<T extends HTMLElement>(): {
  ref: RefCallback<T>;
  width: number | null;
} {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!element) {
      setWidth(null);
      return;
    }

    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return { ref: setElement, width };
}
