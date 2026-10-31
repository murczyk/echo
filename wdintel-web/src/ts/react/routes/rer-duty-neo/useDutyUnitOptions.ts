import { useEffect, useMemo, useState } from 'react';
import { fetchInboxUnitStats } from '../../services/api/inbox-unit-stats';
import { getUnitIdFilterValue } from '../../utils/unit-search';
import { useUnitParentOptions } from '../shared/use-unit-children-filter';
import type { UnitCountOption } from '../shared/unit-children-filter';
import type { FeedFilterPanelModel } from './FeedFilterPanel';

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
  const [counts, setCounts] = useState<{ key: string; options: UnitCountOption[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const { onUnitStatsError } = panel.actions;
  useEffect(() => {
    if (!requestKey) return;
    const controller = new AbortController();
    setLoading(true);
    fetchInboxUnitStats(JSON.parse(requestKey), { signal: controller.signal })
      .then(({ units }) => {
        if (controller.signal.aborted) return;
        setCounts({
          key: requestKey,
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
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [onUnitStatsError, requestKey]);
  const options = useMemo(
    () => (counts?.key === requestKey ? counts.options : EMPTY_OPTIONS),
    [counts, requestKey],
  );
  const parents = useUnitParentOptions(
    panel.toggles.unitsIncludeChildren ?? false,
    options,
    panel.sources.unitHierarchy,
  );
  return {
    options: parents.options,
    loading: loading || parents.loading || panel.toggles.unitHierarchyLoading === true,
  };
}
