import { useCallback, useLayoutEffect, useRef, type UIEvent } from 'react';

import { DEVICES_AUTO_LOAD_THRESHOLD_PX } from './helpers';

export function useDeviceAutoLoad<ScrollElement extends HTMLElement = HTMLDivElement>({
  hasMore,
  blocked,
  resetKey,
  onLoadMore,
}: {
  hasMore: boolean;
  blocked: boolean;
  resetKey: string;
  onLoadMore: () => Promise<void>;
}) {
  const containerRef = useRef<ScrollElement>(null);
  useLayoutEffect(() => {
    containerRef.current?.scrollTo({ top: 0 });
  }, [resetKey]);
  const onScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      const container = event.currentTarget;
      if (blocked || !hasMore || container.scrollTop <= 0) return;
      if (
        container.scrollHeight - container.scrollTop - container.clientHeight <=
        DEVICES_AUTO_LOAD_THRESHOLD_PX
      )
        void onLoadMore();
    },
    [blocked, hasMore, onLoadMore],
  );
  return { containerRef, onScroll };
}
