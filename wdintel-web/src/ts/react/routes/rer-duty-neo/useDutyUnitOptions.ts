import { useEffect, useMemo, useRef, useState } from 'react';
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
  const scope = useMemo(
    () => ({ requestKey, hierarchy: panel.sources.unitHierarchy }),
    [requestKey, panel.sources.unitHierarchy],
  );
  const [counts, setCounts] = useState<{
    scope: typeof scope;
    options: UnitCountOption[];
  } | null>(null);
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
          if (!controller.signal.aborted) setCounts({ scope, options });
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
  }, [scope]);
  useInboxChangedMessageIds({
    enabled: requestKey !== null,
    refreshOnMount: true,
    scopeKey: scope,
    minIntervalMs: panel.sources.unitStatsRefreshIntervalMs ?? INBOX_COUNT_POLL_INTERVAL_MS,
    onMessageIds: () => refreshRef.current(),
  });
  return { options: counts?.scope === scope ? counts.options : EMPTY_OPTIONS };
}
