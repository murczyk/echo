import { useEffect, useRef } from 'react';

export function DeviceFileTreePage({
  cursor,
  onLoadMore,
}: {
  cursor: string;
  onLoadMore: () => void;
}) {
  const target = useRef<HTMLLIElement>(null);
  const loadMore = useRef(onLoadMore);
  loadMore.current = onLoadMore;
  useEffect(() => {
    if (!target.current || typeof IntersectionObserver === 'undefined') return;
    let observing = true;
    const observer = new IntersectionObserver((entries) => {
      if (!observing || !entries.some((entry) => entry.isIntersecting)) return;
      observing = false;
      observer.disconnect();
      loadMore.current();
    });
    observer.observe(target.current);
    return () => {
      observing = false;
      observer.disconnect();
    };
  }, [cursor]);
  return <li ref={target} aria-hidden="true" className="h-px" />;
}
