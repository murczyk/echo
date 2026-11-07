import { useEffect, useRef, useState } from 'react';
import { fetchInboxUnitStats } from '../../services/api/inbox-unit-stats';
import type { UnitCountOption } from '../shared/unit-children-filter';
import type { FeedFilterPanelModel } from './FeedFilterPanel';
import { useInboxChangedMessageIds } from '../shared/useInboxChangedMessageIds';
import { INBOX_COUNT_POLL_INTERVAL_MS } from './utils';

const EMPTY_OPTIONS: UnitCountOption[] = [];

export function useDutyUnitOptions(panel: FeedFilterPanelModel) {
  const request = panel.sources.unitStatsReq;
  const requestRef = useRef(request);
  requestRef.current = request;
  const requestKey = request
    ? JSON.stringify({
        ...request,
        selectedUnits: null,
        selectedUnitIds: null,
        deniedUnits: null,
        deniedUnitIds: null,
        hasUnitFilters: [
          request.selectedUnits,
          request.selectedUnitIds,
          request.deniedUnits,
          request.deniedUnitIds,
        ].some((values) => (values?.length ?? 0) > 0),
      })
    : null;
  const [counts, setCounts] = useState<{ key: string; options: UnitCountOption[] } | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const onErrorRef = useRef(panel.actions.onUnitStatsError);
  onErrorRef.current = panel.actions.onUnitStatsError;
  useEffect(() => {
    if (!requestKey) return;
    const controller = new AbortController();
    refreshRef.current = async () => {
      if (controller.signal.aborted) return;
      await fetchInboxUnitStats(requestRef.current!, { signal: controller.signal })
        .then(({ options }) => {
          if (!controller.signal.aborted) setCounts({ key: requestKey, options });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            onErrorRef.current?.(
              `Не вдалося завантажити кількість повідомлень за підрозділами: ${String(error)}`,
            );
        });
    };
    return () => {
      controller.abort();
      refreshRef.current = async () => {};
    };
  }, [requestKey]);
  useInboxChangedMessageIds({
    enabled: requestKey !== null,
    refreshOnMount: true,
    scopeKey: requestKey,
    minIntervalMs: panel.sources.unitStatsRefreshIntervalMs ?? INBOX_COUNT_POLL_INTERVAL_MS,
    onMessageIds: () => refreshRef.current(),
  });
  return { options: counts?.key === requestKey ? counts.options : EMPTY_OPTIONS };
}
