import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchInboxUnitStats } from '../../services/api/inbox-unit-stats';
import { getUnitIdFilterValue } from '../../utils/unit-search';
import { useUnitParentOptions } from '../shared/use-unit-children-filter';
import type { UnitCountOption } from '../shared/unit-children-filter';
import type { FeedFilterPanelModel } from './FeedFilterPanel';
import { useInboxChangedMessageIds } from '../shared/useInboxChangedMessageIds';
import { INBOX_COUNT_POLL_INTERVAL_MS } from './utils';

const EMPTY_OPTIONS: UnitCountOption[] = [];

export function useDutyUnitOptions(panel: FeedFilterPanelModel) {
  const request = panel.sources.unitStatsReq;
  const requestKey = request
    ? JSON.stringify({
        ...request,
        selectedUnits: null,
        selectedUnitIds: null,
        deniedUnits: null,
        deniedUnitIds: null,
      })
    : null;
  const [counts, setCounts] = useState<{
    key: string;
    revision: number;
    options: UnitCountOption[];
  } | null>(null);
  const countsRef = useRef(counts);
  countsRef.current = counts;
  const [revision, setRevision] = useState(0);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useInboxChangedMessageIds({
    onMessageIds: () => {
      if (refreshTimeoutRef.current !== null) return;
      refreshTimeoutRef.current = setTimeout(() => {
        refreshTimeoutRef.current = null;
        setRevision((value) => value + 1);
      }, INBOX_COUNT_POLL_INTERVAL_MS);
    },
  });
  useEffect(
    () => () => {
      if (refreshTimeoutRef.current !== null) clearTimeout(refreshTimeoutRef.current);
    },
    [],
  );
  const { onUnitStatsError } = panel.actions;
  useEffect(() => {
    if (!requestKey) return;
    if (countsRef.current?.key === requestKey && countsRef.current.revision === revision) return;
    const controller = new AbortController();
    fetchInboxUnitStats(JSON.parse(requestKey), { signal: controller.signal })
      .then(({ units }) => {
        if (controller.signal.aborted) return;
        setCounts({
          key: requestKey,
          revision,
          options: units
            .filter((unit) => unit.count > 0)
            .map((unit) => ({
              value: getUnitIdFilterValue(unit.unitId),
              label: unit.name,
              count: unit.count,
            })),
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          onUnitStatsError?.(
            `Не вдалося завантажити кількість повідомлень за підрозділами: ${String(error)}`,
          );
      });
    return () => controller.abort();
  }, [onUnitStatsError, requestKey, revision]);
  const options = useMemo(
    () => (counts?.key === requestKey ? counts.options : EMPTY_OPTIONS),
    [counts, requestKey],
  );
  const parents = useUnitParentOptions(true, options, panel.sources.unitHierarchy);
  return {
    options: parents.options,
  };
}
