import { useEffect, useRef, type ReactNode } from 'react';
import { DEVICE_FILE_PAGE_PREFETCH_MARGIN_PX } from '../types';

export function DeviceFileAutoLoad({
  cursor,
  loading,
  enabled,
  onLoadMore,
  children,
}: {
  cursor: string;
  loading: boolean;
  enabled: boolean;
  onLoadMore: () => void;
  children?: ReactNode;
}) {
  const target = useRef<HTMLDivElement>(null);
  const loadMore = useRef(onLoadMore);
  loadMore.current = onLoadMore;
  useEffect(() => {
    if (!enabled || loading || !target.current || typeof IntersectionObserver === 'undefined')
      return;
    let observing = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!observing || !entries.some((entry) => entry.isIntersecting)) return;
        observing = false;
        observer.disconnect();
        loadMore.current();
      },
      {
        root: target.current.closest('[data-device-file-scroll-viewport]'),
        rootMargin: `0px 0px ${DEVICE_FILE_PAGE_PREFETCH_MARGIN_PX}px 0px`,
      },
    );
    observer.observe(target.current);
    return () => {
      observing = false;
      observer.disconnect();
    };
  }, [cursor, enabled, loading]);
  return (
    <div ref={target} data-testid="device-files-load-more" className="min-h-echo-control-md">
      {loading && (
        <>
          <span role="status" className="sr-only">
            Завантаження файлів…
          </span>
          {children}
        </>
      )}
    </div>
  );
}
