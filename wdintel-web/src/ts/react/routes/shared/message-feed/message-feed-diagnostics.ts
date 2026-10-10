import { useMemo } from 'react';
import type { WindowedFeedScrollRefs } from './windowed-feed-scroll-shared';
import type { FeedScrollMetrics } from './message-feed.types';

export function useFeedScrollDiagnostics(refs: WindowedFeedScrollRefs) {
  return useMemo(
    () => ({
      event: (feedId: string | undefined, name: string, detail?: string) =>
        refs.diagnosticsRef.current?.event(feedId, name, detail),
      metrics: (feedId: string, metrics: FeedScrollMetrics) =>
        refs.diagnosticsRef.current?.metrics(feedId, metrics),
      isEnabled: () => refs.diagnosticsRef.current?.enabled ?? false,
    }),
    [refs],
  );
}
